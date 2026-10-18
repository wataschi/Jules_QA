import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRegistry, seedCase, seedProject, type Fixture, type TempRegistry } from './temp-db.js';
import {
  acceptanceByModel,
  answerTask,
  applyPrEvent,
  askQuestion,
  claimTask,
  confirmTask,
  createTask,
  expireLeases,
  inbox,
  isOwner,
  listEvents,
  listTasks,
  rejectTask,
  releaseTask,
  reportTask,
  requestChanges,
  requireTask,
  retryTask,
  resolveOwners,
  sectionForFile,
  staleTasks,
} from '../../../src/registry/tasks-store.js';
import { updateSection } from '../../../src/registry/sections-store.js';
import { updateProject } from '../../../src/registry/projects-store.js';
import { execute } from '../../../src/registry/db.js';
import { upsertPullRequest } from '../../../src/registry/code-tests-store.js';
import { failTask } from '../../../src/registry/tasks-store.js';

describe('сховище задач для агентів', () => {
  let temp: TempRegistry;
  let fx: Fixture;

  beforeEach(() => {
    temp = createTempRegistry();
    fx = seedProject();
    updateSection(fx.child.id, { paths: ['src/acts/**'] });
  });

  afterEach(() => temp.cleanup());

  const qaTask = (overrides: Partial<Parameters<typeof createTask>[0]> = {}) =>
    createTask({
      projectId: fx.project.id,
      kind: 'add_test',
      title: 'Акт без суми не зберігається',
      author: 'qa@corp',
      authorKind: 'qa',
      ...overrides,
    }).task;

  it('видає людський ID і ставить задачу в чергу', () => {
    const first = qaTask();
    const second = qaTask({ title: 'Друга' });
    expect(first.id).toBe('CYBER-T-1');
    expect(second.id).toBe('CYBER-T-2');
    expect(first.state).toBe('queued');
    expect(listEvents(first.id)[0].text).toBe('Задачу створено');
  });

  it('не плодить відкриту задачу з тим самим ключем дедуплікації', () => {
    const a = createTask({ projectId: fx.project.id, kind: 'triage', title: 'Упав тест', author: 'ci', authorKind: 'system', dedupKey: 'triage:x' });
    const b = createTask({ projectId: fx.project.id, kind: 'triage', title: 'Упав тест', author: 'ci', authorKind: 'system', dedupKey: 'triage:x' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.task.id).toBe(a.task.id);
  });

  it('визначає модуль за кейсом і за файлом', () => {
    const caseRecord = seedCase(fx.project.id, fx.child.id, { title: 'Кейс' });
    expect(qaTask({ anchor: { caseId: caseRecord.id } }).sectionId).toBe(fx.child.id);
    expect(qaTask({ anchor: { file: 'src/acts/form.ts' } }).sectionId).toBe(fx.child.id);
    expect(sectionForFile(fx.project.id, 'src/other/x.ts')).toBeNull();
  });

  it('бере власників із секції, а без них — із CODEOWNERS', () => {
    updateProject(fx.project.id, { settings: { codeowners: '* @everyone\n/src/acts/ @acts-team' } as never });
    expect(resolveOwners(fx.project.id, fx.child.id)).toEqual(['@acts-team']);
    updateSection(fx.child.id, { owners: ['dev@corp'] });
    expect(resolveOwners(fx.project.id, fx.child.id)).toEqual(['dev@corp']);
  });

  it('у вхідних спершу задачі власника, потім модулі змінених файлів', () => {
    updateSection(fx.child.id, { owners: ['dev@corp'] });
    const other = qaTask({ title: 'Без модуля' });
    const mine = qaTask({ title: 'Моя', anchor: { sectionId: fx.child.id } });
    const result = inbox(fx.project.id, { login: 'dev@corp' });
    expect(result.tasks.map((task) => task.id)).toEqual([mine.id, other.id]);
    expect(result.tasks[0].mine).toBe(true);
  });

  it('питання до людей не потрапляє у вхідні агента і не береться', () => {
    const question = qaTask({ kind: 'question', title: 'Сума обовʼязкова?' });
    expect(inbox(fx.project.id).tasks).toHaveLength(0);
    expect(() => claimTask(question.id, 'dev@corp')).toThrow(/Питання/);
  });

  it('оренда: інший не може взяти, після простроченої — може', () => {
    const task = qaTask();
    claimTask(task.id, 'dev@corp', { agent: 'claude-code', model: 'm1' });
    expect(() => claimTask(task.id, 'other@corp')).toThrow(/claimed/);

    execute('UPDATE tasks SET lease_until = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), task.id]);
    expect(expireLeases()).toEqual([task.id]);
    expect(requireTask(task.id).state).toBe('queued');
    const again = claimTask(task.id, 'other@corp');
    expect(again.leaseHolder).toBe('other@corp');
    expect(again.attempts).toBe(2);
  });

  it('питання агента звільняє оренду, відповідь QA повертає в чергу', () => {
    const task = qaTask();
    claimTask(task.id, 'dev@corp');
    const asked = askQuestion(task.id, 'dev@corp', 'Сума 0 — це помилка чи допустимо?');
    expect(asked.state).toBe('needs_info');
    expect(asked.leaseHolder).toBeUndefined();
    expect(answerTask(task.id, 'qa@corp', 'qa', '0 — помилка').state).toBe('queued');
    expect(listEvents(task.id).map((event) => event.type)).toEqual(['status', 'status', 'question', 'answer']);
  });

  it('звіт про тест без посилання на PR не приймається', () => {
    const task = qaTask();
    claimTask(task.id, 'dev@corp');
    expect(() => reportTask(task.id, 'dev@corp', { summary: 'Готово' })).toThrow(/PR/);
  });

  it('звіт чужого агента не приймається', () => {
    const task = qaTask();
    claimTask(task.id, 'dev@corp');
    expect(() => reportTask(task.id, 'other@corp', { summary: 'x', prUrl: 'https://github.com/o/r/pull/1' })).toThrow(/взяв/);
  });

  it('задача з PR закривається лише після підтвердження QA і злиття', () => {
    const task = qaTask();
    claimTask(task.id, 'dev@corp');
    const reported = reportTask(task.id, 'dev@corp', {
      summary: 'Тест на акт без суми',
      checks: ['Форма не зберігається', 'Поле суми підсвічене'],
      prUrl: 'https://github.com/acme/app/pull/42',
      tests: [{ file: 'tests/acts.test.ts', name: 'CYBER-AKT-001 акт без суми', caseIds: [] }],
    });
    expect(reported.state).toBe('review');
    expect(reported.prNumber).toBe(42);

    expect(confirmTask(task.id, 'qa@corp').state).toBe('review');
    expect(applyPrEvent(fx.project.id, 42, 'merged')).toBe(1);
    const done = requireTask(task.id);
    expect(done.state).toBe('done');
    expect(done.mergedAt).toBeDefined();
  });

  it('злиття до підтвердження чекає QA, а підтвердження після злиття закриває', () => {
    const task = qaTask();
    claimTask(task.id, 'dev@corp');
    reportTask(task.id, 'dev@corp', { summary: 's', prUrl: 'https://github.com/acme/app/pull/7' });
    applyPrEvent(fx.project.id, 7, 'merged');
    expect(requireTask(task.id).state).toBe('review');
    expect(confirmTask(task.id, 'qa@corp').state).toBe('done');
  });

  it('після «інакше» новий PR має бути злитий сам: злиття старого не закриває задачу', () => {
    const task = qaTask();
    claimTask(task.id, 'dev@corp');
    reportTask(task.id, 'dev@corp', { summary: 's', prUrl: 'https://github.com/acme/app/pull/5' });
    applyPrEvent(fx.project.id, 5, 'merged');
    requestChanges(task.id, 'qa@corp', 'Ще перевірити нуль');
    claimTask(task.id, 'dev@corp');
    const second = reportTask(task.id, 'dev@corp', { summary: 's2', prUrl: 'https://github.com/acme/app/pull/7' });
    expect(second.mergedAt).toBeUndefined();
    expect(confirmTask(task.id, 'qa@corp').state).toBe('review');
    applyPrEvent(fx.project.id, 7, 'merged');
    expect(requireTask(task.id).state).toBe('done');
  });

  it('PR, злитий ще до звіту агента, зараховується одразу', () => {
    const task = qaTask();
    upsertPullRequest(fx.project.id, 11, { state: 'merged' });
    claimTask(task.id, 'dev@corp');
    const reported = reportTask(task.id, 'dev@corp', { summary: 's', prUrl: 'https://github.com/acme/app/pull/11' });
    expect(reported.mergedAt).toBeDefined();
    expect(confirmTask(task.id, 'qa@corp').state).toBe('done');
  });

  it('невдалу задачу QA повертає в чергу, і агент може взяти її знову', () => {
    const task = qaTask();
    claimTask(task.id, 'dev@corp');
    failTask(task.id, 'dev@corp', 'не збирається');
    expect(inbox(fx.project.id, { login: 'dev@corp' }).tasks.map((item) => item.id)).not.toContain(task.id);
    expect(retryTask(task.id, 'qa@corp', 'qa').state).toBe('queued');
    expect(claimTask(task.id, 'dev@corp').state).toBe('claimed');
  });

  it('повторне створення з тим самим ключем повертає невдалу задачу в чергу, а не мовчить', () => {
    const first = qaTask({ kind: 'triage', dedupKey: 'triage:t1', authorKind: 'system', author: 'jules' });
    claimTask(first.id, 'dev@corp');
    failTask(first.id, 'dev@corp', 'не вийшло');
    const again = createTask({ projectId: fx.project.id, kind: 'triage', title: 'Знову впав', author: 'jules', authorKind: 'system', dedupKey: 'triage:t1' });
    expect(again.created).toBe(false);
    expect(again.task.id).toBe(first.id);
    expect(again.task.state).toBe('queued');
  });

  it('PR закрито без злиття — задача знову в черзі', () => {
    const task = qaTask();
    claimTask(task.id, 'dev@corp');
    reportTask(task.id, 'dev@corp', { summary: 's', prUrl: 'https://github.com/acme/app/pull/9' });
    applyPrEvent(fx.project.id, 9, 'closed');
    const back = requireTask(task.id);
    expect(back.state).toBe('queued');
    expect(back.prNumber).toBeUndefined();
  });

  it('задача без PR закривається одразу підтвердженням QA', () => {
    const task = qaTask({ kind: 'read_asset', title: 'Прочитати схему' });
    claimTask(task.id, 'dev@corp');
    reportTask(task.id, 'dev@corp', { summary: 'Флоу: A → B' });
    expect(confirmTask(task.id, 'qa@corp').state).toBe('done');
  });

  it('QA просить інакше — задача повертається в чергу', () => {
    const task = qaTask();
    claimTask(task.id, 'dev@corp');
    reportTask(task.id, 'dev@corp', { summary: 's', prUrl: 'https://github.com/acme/app/pull/3' });
    expect(requestChanges(task.id, 'qa@corp', 'Треба ще перевірити 0').state).toBe('queued');
  });

  it('відхилену задачу не можна відхилити вдруге', () => {
    const task = qaTask();
    rejectTask(task.id, 'qa@corp', 'qa', 'не потрібна');
    expect(() => rejectTask(task.id, 'qa@corp', 'qa')).toThrow(/rejected/);
  });

  it('повернення в чергу без звіту закриває роботу агента', () => {
    const task = qaTask();
    claimTask(task.id, 'dev@corp');
    expect(releaseTask(task.id, 'dev@corp', 'немає часу').state).toBe('queued');
  });

  it('знаходить задачі, що чекають довше порогу', () => {
    const task = qaTask();
    execute('UPDATE tasks SET queued_at = ? WHERE id = ?', [new Date(Date.now() - 30 * 3_600_000).toISOString(), task.id]);
    const stale = staleTasks(fx.project.id, 24);
    expect(stale.map((item) => item.id)).toEqual([task.id]);
    expect(stale[0].ageHours).toBeGreaterThanOrEqual(30);
  });

  it('рахує прийняття з першої спроби в розрізі моделей', () => {
    const task = qaTask();
    claimTask(task.id, 'dev@corp', { model: 'model-a' });
    reportTask(task.id, 'dev@corp', { summary: 's', prUrl: 'https://github.com/acme/app/pull/5' });
    confirmTask(task.id, 'qa@corp');
    expect(acceptanceByModel(fx.project.id)).toEqual([{ model: 'model-a', reported: 1, firstTime: 1 }]);
  });

  it('хендл із CODEOWNERS збігається з логіном Tailscale за частиною до @', () => {
    expect(isOwner(['@alice'], 'alice@corp')).toBe(true);
    expect(isOwner(['@Alice'], 'alice@github')).toBe(true);
    expect(isOwner(['alice@corp'], 'alice@corp')).toBe(true);
    expect(isOwner(['@bob'], 'alice@corp')).toBe(false);
    expect(isOwner(['@org/team'], 'org@corp')).toBe(false);
    updateSection(fx.child.id, { owners: ['@alice'] });
    const task = qaTask({ anchor: { file: 'src/acts/form.ts' } });
    expect(task.owners).toEqual(['@alice']);
    expect(listTasks({ projectId: fx.project.id, owner: 'alice@corp' }).items.map((item) => item.id)).toContain(task.id);
  });

  it('фільтрує перелік за станом і власником', () => {
    updateSection(fx.child.id, { owners: ['dev@corp'] });
    qaTask({ anchor: { sectionId: fx.child.id } });
    qaTask({ title: 'інша' });
    expect(listTasks({ projectId: fx.project.id, owner: 'dev@corp' }).total).toBe(1);
    expect(listTasks({ projectId: fx.project.id, states: ['done'] }).total).toBe(0);
  });
});
