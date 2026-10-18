import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempRegistry, seedProject, type Fixture, type TempRegistry } from '../unit/registry/temp-db.js';
import { deliverNotifications, maybePublishWeekly } from '../../src/server/jobs.js';
import { enqueueNotification, pendingNotifications, recentNotifications } from '../../src/registry/notifications-store.js';
import { createProject, updateProject } from '../../src/registry/projects-store.js';
import { eventDedupKey } from '../../src/notify/telegram.js';
import { execute } from '../../src/registry/db.js';

describe('черга сповіщень: пропуск, повтори з паузою, тиждень по проєктах', () => {
  let temp: TempRegistry;
  let fx: Fixture;

  beforeEach(() => {
    temp = createTempRegistry();
    fx = seedProject();
    process.env.TELEGRAM_BOT_TOKEN = 'bot-secret';
    process.env.TELEGRAM_CHAT_ID = '-100global';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    temp.cleanup();
  });

  const ok = (async () =>
    new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  const broken = (async () =>
    new Response(JSON.stringify({ ok: false, error_code: 400, description: 'chat not found' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

  it('сповіщення вимкненого проєкту позначаються пропущеними й не блокують чергу', async () => {
    updateProject(fx.project.id, { settings: { telegram: { enabled: false } } as never });
    for (let i = 0; i < 25; i += 1) enqueueNotification({ kind: 'main_red', project: 'Кібер', sha: `sha${i}`, failed: 1 } as never, fx.project.id);
    const other = createProject({ key: 'OTHER', name: 'Інший' });
    updateProject(other.id, { settings: { telegram: { enabled: true } } as never });
    enqueueNotification({ kind: 'main_red', project: 'Інший', sha: 'live', failed: 1 } as never, other.id);

    expect(await deliverNotifications(ok)).toEqual({ sent: 0, failed: 0 });
    expect(await deliverNotifications(ok)).toEqual({ sent: 1, failed: 0 });
    expect(pendingNotifications()).toHaveLength(0);
    const skipped = recentNotifications(100).filter((item) => item.projectId === fx.project.id);
    expect(skipped).toHaveLength(25);
    expect(skipped.every((item) => item.skippedReason === 'disabled' && item.sentAt)).toBe(true);
  });

  it('невдала відправка повторюється з паузою, а після 8 спроб — здається', async () => {
    updateProject(fx.project.id, { settings: { telegram: { enabled: true } } as never });
    enqueueNotification({ kind: 'main_red', project: 'Кібер', sha: 'bad', failed: 1 } as never, fx.project.id);
    expect(await deliverNotifications(broken)).toEqual({ sent: 0, failed: 1 });
    const [first] = recentNotifications();
    expect(first.attempts).toBe(1);
    expect(first.sentAt).toBeUndefined();
    expect(Date.parse(first.nextTryAt ?? '')).toBeGreaterThan(Date.now() + 30_000);
    // Пауза ще не минула — не чіпаємо.
    expect(pendingNotifications()).toHaveLength(0);
    expect(await deliverNotifications(broken)).toEqual({ sent: 0, failed: 0 });

    for (let attempt = 2; attempt <= 8; attempt += 1) {
      execute('UPDATE notifications SET next_try_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), first.id]);
      expect(await deliverNotifications(broken)).toEqual({ sent: 0, failed: 1 });
    }
    const [last] = recentNotifications();
    expect(last.attempts).toBe(8);
    expect(last.skippedReason).toBe('failed');
    expect(last.sentAt).toBeDefined();
    expect(last.error).toMatch(/chat not found/);
    expect(pendingNotifications()).toHaveLength(0);
  });

  it('пауза між спробами росте: 1, 2, 4… хвилин, не більше 60', async () => {
    updateProject(fx.project.id, { settings: { telegram: { enabled: true } } as never });
    enqueueNotification({ kind: 'main_red', project: 'Кібер', sha: 'slow', failed: 1 } as never, fx.project.id);
    const gaps: number[] = [];
    for (let attempt = 1; attempt <= 7; attempt += 1) {
      const before = Date.now();
      await deliverNotifications(broken);
      const [item] = recentNotifications();
      gaps.push(Math.round((Date.parse(item.nextTryAt ?? '') - before) / 60_000));
      execute('UPDATE notifications SET next_try_at = ? WHERE id = ?', [new Date(Date.now() - 1000).toISOString(), item.id]);
    }
    expect(gaps).toEqual([1, 2, 4, 8, 16, 32, 60]);
  });

  it('друге падіння тієї самої тривалості не губить «піднялось»', () => {
    const a = eventDedupKey({ kind: 'source_up', source: 'Jira', downMinutes: 5, since: '2026-10-01T10:00:00.000Z' });
    const b = eventDedupKey({ kind: 'source_up', source: 'Jira', downMinutes: 5, since: '2026-10-02T10:00:00.000Z' });
    expect(a).not.toBe(b);
  });

  it('помилка тижневого звіту одного проєкту не зупиняє інших', async () => {
    const second = createProject({ key: 'SECOND', name: 'Другий' });
    for (const id of [fx.project.id, second.id]) {
      updateProject(id, { settings: { jira: { projectKey: 'CYB', issueType: 'Task', createBugs: false } } as never });
    }
    process.env.JIRA_BASE_URL = 'https://jira.corp.local';
    process.env.JIRA_TOKEN = 'jira-pat';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    vi.stubGlobal('fetch', (async (url: string, init?: RequestInit) => {
      calls += 1;
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
      // Перший проєкт: Jira відповідає помилкою.
      if (calls === 1) return json({ errorMessages: ['Jira 500'] }, 500);
      if (String(url).includes('/rest/api/2/search')) return json({ issues: [], total: 0, startAt: 0, maxResults: 50 });
      if ((init?.method ?? 'GET') === 'POST') return json({ key: 'CYB-1', id: '10' }, 201);
      return json({ errorMessages: ['unexpected'] }, 500);
    }) as unknown as typeof fetch);
    const done = await maybePublishWeekly(new Date('2026-10-12T10:00:00'));
    expect(done).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    vi.unstubAllGlobals();
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_TOKEN;
  });
});
