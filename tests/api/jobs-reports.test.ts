import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRegistry, seedProject, type Fixture, type TempRegistry } from '../unit/registry/temp-db.js';
import { recordHealth } from '../../src/server/health.js';
import { deliverNotifications, maybePublishWeekly, notifyStaleTasks } from '../../src/server/jobs.js';
import { publishWeekly, publishedWeekly } from '../../src/server/weekly.js';
import { buildStatusData } from '../../src/server/status-data.js';
import { createTask } from '../../src/registry/tasks-store.js';
import { pendingNotifications, recentNotifications } from '../../src/registry/notifications-store.js';
import { updateProject } from '../../src/registry/projects-store.js';
import { updateSection } from '../../src/registry/sections-store.js';
import { ingestRun } from '../../src/registry/code-tests-store.js';
import { execute } from '../../src/registry/db.js';
import { seedCase } from '../unit/registry/temp-db.js';

describe('фонові задачі, звіти й сповіщення', () => {
  let temp: TempRegistry;
  let fx: Fixture;

  beforeEach(() => {
    temp = createTempRegistry();
    fx = seedProject();
  });

  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_TOKEN;
    temp.cleanup();
  });

  it('стан інтеграції сповіщає лише про зміну: упала й піднялась', () => {
    recordHealth('confluence', true);
    expect(pendingNotifications()).toHaveLength(0);
    recordHealth('confluence', false, 'ECONNREFUSED');
    recordHealth('confluence', false, 'ECONNREFUSED');
    const afterDown = pendingNotifications();
    expect(afterDown.map((item) => item.kind)).toEqual(['source_down']);
    recordHealth('confluence', true);
    expect(pendingNotifications().map((item) => item.kind)).toEqual(['source_down', 'source_up']);
  });

  it('нагадує про задачу, що чекає довше порогу, один раз на добу очікування', () => {
    const { task } = createTask({ projectId: fx.project.id, kind: 'add_test', title: 'Чекає', author: 'qa', authorKind: 'qa' });
    execute('UPDATE tasks SET queued_at = ? WHERE id = ?', [new Date(Date.now() - 30 * 3_600_000).toISOString(), task.id]);
    expect(notifyStaleTasks()).toBe(1);
    expect(notifyStaleTasks()).toBe(0);
    expect(pendingNotifications()[0].event).toMatchObject({ kind: 'stale_task', taskId: task.id });
  });

  it('без Telegram нічого не шле й нічого не позначає', async () => {
    createTask({ projectId: fx.project.id, kind: 'add_test', title: 'x', author: 'qa', authorKind: 'qa' });
    recordHealth('jira', true);
    recordHealth('jira', false, 'down');
    expect(await deliverNotifications()).toEqual({ sent: 0, failed: 0 });
    expect(pendingNotifications()).toHaveLength(1);
  });

  it('шле в Telegram чат проєкту, а вимкнені для проєкту — пропускає', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'bot-secret';
    process.env.TELEGRAM_CHAT_ID = '-100global';
    updateProject(fx.project.id, { settings: { ...fx.project.settings, telegram: { enabled: true, chatId: '-100project' } } });
    const { task } = createTask({ projectId: fx.project.id, kind: 'add_test', title: 'Чекає', author: 'qa', authorKind: 'qa' });
    execute('UPDATE tasks SET queued_at = ? WHERE id = ?', [new Date(Date.now() - 30 * 3_600_000).toISOString(), task.id]);
    notifyStaleTasks();

    const sent: Array<{ url: string; body: { chat_id: string; text: string } }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    expect(await deliverNotifications(fetchImpl)).toEqual({ sent: 1, failed: 0 });
    expect(sent[0].body.chat_id).toBe('-100project');
    expect(sent[0].body.text).toContain('Чекає');
    expect(recentNotifications()[0].sentAt).toBeDefined();

    updateProject(fx.project.id, { settings: { telegram: { enabled: false } } as never });
    const { task: second } = createTask({ projectId: fx.project.id, kind: 'add_test', title: 'Друга', author: 'qa', authorKind: 'qa' });
    execute('UPDATE tasks SET queued_at = ? WHERE id = ?', [new Date(Date.now() - 30 * 3_600_000).toISOString(), second.id]);
    notifyStaleTasks();
    expect(await deliverNotifications(fetchImpl)).toEqual({ sent: 0, failed: 0 });
    expect(sent).toHaveLength(1);
  });

  it('тижнева задача в Jira створюється раз і оновлюється без дублів', async () => {
    process.env.JIRA_BASE_URL = 'https://jira.corp.local';
    process.env.JIRA_TOKEN = 'jira-pat';
    updateProject(fx.project.id, { settings: { jira: { projectKey: 'CYB', issueType: 'Task', createBugs: false } } as never });

    const issues = new Map<string, { key: string; labels: string[]; summary: string }>();
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${new URL(url).pathname}`);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
      if (url.includes('/rest/api/2/search')) {
        const label = /labels = "([^"]+)"/.exec(body.jql ?? decodeURIComponent(url))?.[1];
        const found = [...issues.values()].filter((issue) => label && issue.labels.includes(label));
        return json({ issues: found.map((issue) => ({ key: issue.key, id: '1', fields: { labels: issue.labels } })), total: found.length, startAt: 0, maxResults: 50 });
      }
      if (method === 'POST' && url.endsWith('/rest/api/2/issue')) {
        const key = `CYB-${issues.size + 1}`;
        issues.set(key, { key, labels: body.fields.labels, summary: body.fields.summary });
        return json({ key, id: '10' }, 201);
      }
      if (method === 'PUT') return new Response(null, { status: 204 });
      return json({ errorMessages: ['unexpected'] }, 500);
    }) as unknown as typeof fetch;

    const first = await publishWeekly(fx.project.id, { week: '2026-W41', insights: 'Падінь менше', fetch: fetchImpl });
    expect(first.jira).toMatchObject({ key: 'CYB-1', created: true });
    expect(first.report.summary).toContain('2026-W41');
    const again = await publishWeekly(fx.project.id, { week: '2026-W41', fetch: fetchImpl });
    expect(again.jira).toMatchObject({ key: 'CYB-1', created: false });
    expect(issues.size).toBe(1);
    expect(publishedWeekly(fx.project.id, '2026-W41')?.key).toBe('CYB-1');
    expect(calls.filter((call) => call.startsWith('PUT'))).toHaveLength(1);
  });

  it('тижневий звіт публікується лише в понеділок після 9:00', async () => {
    expect(await maybePublishWeekly(new Date('2026-10-13T12:00:00'))).toEqual([]);
    expect(await maybePublishWeekly(new Date('2026-10-12T08:00:00'))).toEqual([]);
  });

  it('статус рахує модулі, падіння, P1 без тестів і mutation score з main', () => {
    updateSection(fx.section.id, { paths: ['src/acts/**'] });
    const p1 = seedCase(fx.project.id, fx.child.id, { title: 'P1 без тесту', priority: 'P1', status: 'approved' });
    const tested = seedCase(fx.project.id, fx.child.id, { title: 'З тестом', status: 'approved' });
    ingestRun({
      projectId: fx.project.id,
      sha: 'abcdef1234',
      branch: 'main',
      event: 'main',
      source: 'ci',
      results: [
        { key: 'k1', file: 'tests/a.test.ts', name: 'a', fullName: `${tested.id} a`, status: 'passed', framework: 'vitest', caseIds: [tested.id], level: 'unit' },
        { key: 'k2', file: 'tests/b.test.ts', name: 'b', fullName: 'b', status: 'failed', framework: 'vitest', caseIds: [], level: 'unit' },
      ],
      mutation: [{ path: 'src/acts/form.ts', killed: 7, survived: 3, noCoverage: 0, timeout: 0, total: 10, score: 70 }],
    });
    const status = buildStatusData(fx.project.id);
    expect(status.sha).toBe('abcdef1234');
    expect(status.modules).toHaveLength(1);
    expect(status.modules[0]).toMatchObject({ cases: 2, withTests: 1, passed: 1, failed: 0, mutationScore: 70 });
    expect(status.failed.map((item) => item.file)).toEqual(['tests/b.test.ts']);
    expect(status.p1WithoutTests.map((item) => item.caseId)).toEqual([p1.id]);
    expect(status.testsWithoutCase).toBe(1);
  });
});
