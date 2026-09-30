import { describe, expect, it } from 'vitest';
import { buildBugReport } from '../../../src/engine/healer.js';
import { ResultsCollector, type StepResult } from '../../../src/engine/results.js';

function collector(): ResultsCollector {
  return new ResultsCollector({
    scenarioId: 'bug-demo',
    goal: 'Перевірити облік впевненості в дефектах',
    targetUrl: 'https://bug.example/app',
    mode: 'regression',
  });
}

function step(index: number, status: StepResult['status'], instruction = `Крок ${index + 1}`): StepResult {
  return {
    index,
    kind: 'step',
    instruction,
    status,
    attempts: 1,
    healed: false,
    handledBy: 'midscene',
    durationMs: 10,
  };
}

describe('buildBugReport — впевненість залежить від пояснення', () => {
  it('без пояснення моделі дефект непідтверджений і не звинувачує застосунок', () => {
    const report = buildBugReport({ assertion: 'перелік наборів видно' });

    expect(report.confidence).toBe('unconfirmed');
    // Саме такий «впевнений вирок» без жодних підстав і давав фантомні баги.
    expect(report.rootCauseHypothesis).not.toContain('регресія функціоналу');
    expect(report.rootCauseHypothesis).toContain('без пояснення від моделі');
    expect(report.severity).toBe('low');
  });

  it('з поясненням моделі дефект підтверджений і цитує спостереження', () => {
    const report = buildBugReport({
      assertion: 'сторінка входу показує помилку 500',
      thought: 'на місці форми порожній блок і текст Internal Server Error',
    });

    expect(report.confidence).toBe('confirmed');
    expect(report.rootCauseHypothesis).toContain('Internal Server Error');
    expect(report.severity).toBe('high');
  });

  it('текст помилки теж вважається поясненням', () => {
    const report = buildBugReport({
      assertion: 'кошик містить товар',
      error: 'Assertion failed: cart is empty',
    });

    expect(report.confidence).toBe('confirmed');
    expect(report.thought).toBe('Assertion failed: cart is empty');
  });

  it('номер кроку чекпойнта зберігається лише коли його передали', () => {
    expect(buildBugReport({ assertion: 'x', checkpointAfterStep: 4 }).checkpointAfterStep).toBe(4);
    expect(buildBugReport({ assertion: 'x' }).checkpointAfterStep).toBeUndefined();
  });
});

describe('ResultsCollector — звірка дефектів із ходом прогону', () => {
  it('знижує впевненість, якщо після чекпойнта крок пройшов', () => {
    const c = collector();
    c.record(step(0, 'passed'));
    c.record(step(1, 'passed'));
    c.record(step(2, 'passed', 'Клікнути назву набору у списку'));
    c.addBugReport(
      buildBugReport({
        assertion: 'перелік наборів видно',
        thought: 'списку не видно',
        checkpointAfterStep: 2,
      }),
    );

    const [report] = c.build().bugReports;
    expect(report?.confidence).toBe('unconfirmed');
    expect(report?.contradictedBy).toContain('крок 3');
    expect(report?.contradictedBy).toContain('Клікнути назву набору');
  });

  it('полікуваний наступний крок так само суперечить вердикту', () => {
    const c = collector();
    c.record(step(0, 'passed'));
    c.record({ ...step(1, 'healed'), healed: true });
    c.addBugReport(
      buildBugReport({ assertion: 'кнопка активна', thought: 'кнопка неактивна', checkpointAfterStep: 1 }),
    );

    expect(c.build().bugReports[0]?.confidence).toBe('unconfirmed');
  });

  it('залишає впевненість, якщо після чекпойнта прогін не пішов далі', () => {
    const c = collector();
    c.record(step(0, 'passed'));
    c.record(step(1, 'passed'));
    c.record(step(2, 'failed'));
    c.addBugReport(
      buildBugReport({
        assertion: 'форма збереглася',
        thought: 'зʼявилося повідомлення про помилку',
        checkpointAfterStep: 3,
      }),
    );

    const [report] = c.build().bugReports;
    expect(report?.confidence).toBe('confirmed');
    expect(report?.contradictedBy).toBeUndefined();
  });

  it('фінальні ассершени не звіряються з кроками — їм нічого не суперечить', () => {
    const c = collector();
    c.record(step(0, 'passed'));
    c.record(step(1, 'passed'));
    c.addBugReport(buildBugReport({ assertion: 'підсумок правильний', thought: 'сума не збігається' }));

    const [report] = c.build().bugReports;
    expect(report?.confidence).toBe('confirmed');
    expect(report?.contradictedBy).toBeUndefined();
  });

  it('пройдений ассершен після чекпойнта не рахується за крок', () => {
    const c = collector();
    c.record(step(0, 'passed'));
    // Лише ассершен — не доказ, що застосунок поїхав далі.
    c.record({ ...step(1, 'passed'), kind: 'assertion', instruction: 'щось перевірено' });
    c.addBugReport(
      buildBugReport({ assertion: 'дані на місці', thought: 'даних немає', checkpointAfterStep: 1 }),
    );

    expect(c.build().bugReports[0]?.confidence).toBe('confirmed');
  });
});
