import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRegistry, seedCase, seedProject, type Fixture, type TempRegistry } from './temp-db.js';
import { ingestRun, markAgentTests, testsForCase, type IngestRunInput } from '../../../src/registry/code-tests-store.js';
import { getCase } from '../../../src/registry/cases-store.js';
import { query, type Row } from '../../../src/registry/db.js';

type Result = IngestRunInput['results'][number];

describe('тести в коді: що змінюють прогони main, PR і локальні', () => {
  let temp: TempRegistry;
  let fx: Fixture;

  beforeEach(() => {
    temp = createTempRegistry();
    fx = seedProject();
  });

  afterEach(() => temp.cleanup());

  const result = (key: string, caseIds: string[], status: Result['status'] = 'passed', name = key): Result => ({
    key,
    file: 'tests/acts.test.ts',
    name,
    fullName: `${caseIds.join(' ')} ${name}`.trim(),
    status,
    framework: 'vitest',
    caseIds,
    level: 'unit',
  });

  const run = (event: IngestRunInput['event'], results: Result[], extra: Partial<IngestRunInput> = {}) =>
    ingestRun({ projectId: fx.project.id, sha: 'abcdef1234', branch: event === 'main' ? 'main' : 'feature', event, source: event === 'local' ? 'local' : 'ci', results, ...extra });

  it('локальний червоний прогін не фарбує кейс і не переписує зв’язків тесту з main', () => {
    const one = seedCase(fx.project.id, fx.child.id, { title: 'Акт' });
    const other = seedCase(fx.project.id, fx.child.id, { title: 'Інший' });
    run('main', [result('k1', [one.id])]);
    expect(getCase(one.id)?.automation.lastAutoStatus).toBe('passed');

    run('local', [result('k1', [other.id], 'failed')]);
    expect(getCase(one.id)?.automation.lastAutoStatus).toBe('passed');
    expect(getCase(other.id)?.automation.lastAutoStatus).toBeUndefined();
    expect(testsForCase(one.id).map((test) => test.testKey)).toEqual(['k1']);
  });

  it('пропущений у PR тест не стає «пропущеним» глобально', () => {
    const one = seedCase(fx.project.id, fx.child.id, { title: 'Акт' });
    run('main', [result('k1', [one.id])]);
    run('pr', [result('k1', [one.id], 'skipped')], { prNumber: 3 });
    const state = query<Row>(`SELECT state FROM tests WHERE test_key = 'k1'`)[0].state;
    expect(state).toBe('active');
  });

  it('кейс, у якого всі тести пропущено, не отримує статусу «пройшов»', () => {
    const one = seedCase(fx.project.id, fx.child.id, { title: 'Акт' });
    run('main', [result('k1', [one.id], 'skipped')]);
    expect(getCase(one.id)?.automation.lastAutoStatus).not.toBe('passed');
  });

  it('порожній маніфест не позначає всі тести видаленими', () => {
    const one = seedCase(fx.project.id, fx.child.id, { title: 'Акт' });
    run('main', [result('k1', [one.id])]);
    run('main', [], { manifest: { version: 1, tests: [] } as never });
    expect(query<Row>(`SELECT state FROM tests WHERE test_key = 'k1'`)[0].state).toBe('active');
  });

  it('кейс, усі тести якого прибрано з коду, перестає бути «автоматизованим»', () => {
    const one = seedCase(fx.project.id, fx.child.id, { title: 'Акт', status: 'approved' });
    run('main', [result('k1', [one.id])]);
    expect(getCase(one.id)?.automation.status).toBe('automated');
    run('main', [result('k2', [])], { manifest: { version: 1, tests: [{ key: 'k2' }] } as never });
    expect(getCase(one.id)?.automation.status).not.toBe('automated');
  });

  it('позначення тестів агента не чіпає всіх тестів файлу через порожню назву чи символи LIKE', () => {
    run('main', [result('k1', [], 'passed', 'перший'), result('k2', [], 'passed', 'другий')]);
    expect(markAgentTests(fx.project.id, [{ file: 'tests/acts.test.ts', name: '' }])).toBe(0);
    expect(markAgentTests(fx.project.id, [{ file: 'tests/acts.test.ts', name: '%' }])).toBe(0);
    expect(markAgentTests(fx.project.id, [{ file: 'tests/acts.test.ts', name: 'перший' }])).toBe(1);
  });
});
