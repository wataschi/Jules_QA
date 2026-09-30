import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRun, getRunItem, syncAutoResult } from '../../../src/registry/runs-store.js';
import { listDefects } from '../../../src/registry/defects-store.js';
import { createTempRegistry, seedCase, seedProject, type TempRegistry } from './temp-db.js';

describe('createRun — походження адреси середовища', () => {
  let temp: TempRegistry;

  beforeEach(() => {
    temp = createTempRegistry();
  });

  afterEach(() => {
    temp.cleanup();
  });

  it('явно задана адреса закріплює середовище', () => {
    const { project, section } = seedProject();
    const testCase = seedCase(project.id, section.id, { title: 'Кейс' });

    const run = createRun({
      projectId: project.id,
      caseIds: [testCase.id],
      env: { baseUrl: 'https://stage.example' },
    });

    expect(run.env.baseUrl).toBe('https://stage.example');
    expect(run.env.baseUrlPinned).toBe(true);
  });

  it('успадкована від проєкту адреса середовища не закріплює', () => {
    const { project, section } = seedProject();
    const testCase = seedCase(project.id, section.id, { title: 'Кейс' });

    const run = createRun({ projectId: project.id, caseIds: [testCase.id] });

    // Дефолт проєкту лише підстраховує сценарії без власної цілі — він не має
    // права відібрати у сценарію його адресу.
    expect(run.env.baseUrlPinned).toBeUndefined();
  });
});

describe('syncAutoResult — результат рушія в елементі прогону', () => {
  let temp: TempRegistry;

  beforeEach(() => {
    temp = createTempRegistry();
  });

  afterEach(() => {
    temp.cleanup();
  });

  function setup() {
    const { project, section } = seedProject();
    const testCase = seedCase(project.id, section.id, { title: 'Пошук наборів' });
    const run = createRun({ projectId: project.id, kind: 'auto', caseIds: [testCase.id] });
    return { project, testCase, run };
  }

  it('створює дефект із результату рушія і зв’язує його з елементом', () => {
    const { project, testCase, run } = setup();

    syncAutoResult(run.id, testCase.id, {
      autoRunId: 'engine-1',
      engineStatus: 'failed',
      defect: { title: 'Перевірка не пройдена: перелік порожній', severity: 'high', details: 'гіпотеза' },
    });

    const item = getRunItem(run.id, testCase.id);
    expect(item?.status).toBe('failed');
    expect(item?.defectId).toBeTruthy();

    const defects = listDefects({ projectId: project.id });
    expect(defects.items).toHaveLength(1);
    expect(defects.items[0]?.severity).toBe('high');
    expect(defects.items[0]?.seenCount).toBe(1);
  });

  it('повторна синхронізація того самого прогону нічого не змінює', () => {
    const { project, testCase, run } = setup();
    const input = {
      autoRunId: 'engine-1',
      engineStatus: 'failed' as const,
      defect: { title: 'Перевірка не пройдена: перелік порожній' },
    };

    syncAutoResult(run.id, testCase.id, input);
    const first = getRunItem(run.id, testCase.id);
    syncAutoResult(run.id, testCase.id, input);
    syncAutoResult(run.id, testCase.id, input);
    const again = getRunItem(run.id, testCase.id);

    // Ані статус, ані мітка часу, ані лічильник дефекту не рухаються: інакше
    // тік мостика роздував `seenCount` і переписував уже зафіксований результат.
    expect(again).toEqual(first);
    expect(listDefects({ projectId: project.id }).items[0]?.seenCount).toBe(1);
  });

  it('не переписує зафіксований статус іншим вердиктом того самого прогону', () => {
    const { testCase, run } = setup();
    syncAutoResult(run.id, testCase.id, { autoRunId: 'engine-1', engineStatus: 'failed' });
    syncAutoResult(run.id, testCase.id, { autoRunId: 'engine-1', engineStatus: 'failed', blocked: true });

    expect(getRunItem(run.id, testCase.id)?.status).toBe('failed');
  });

  it('новий автопрогін того самого кейса результат оновлює', () => {
    const { testCase, run } = setup();
    syncAutoResult(run.id, testCase.id, { autoRunId: 'engine-1', engineStatus: 'failed' });
    syncAutoResult(run.id, testCase.id, { autoRunId: 'engine-2', engineStatus: 'passed' });

    expect(getRunItem(run.id, testCase.id)?.status).toBe('passed');
  });

  it('недоступне середовище дає blocked, а не failed', () => {
    const { testCase, run } = setup();
    syncAutoResult(run.id, testCase.id, {
      autoRunId: 'engine-1',
      engineStatus: 'failed',
      blocked: true,
      comment: 'ціль віддала HTTP 503',
    });

    expect(getRunItem(run.id, testCase.id)?.status).toBe('blocked');
  });
});
