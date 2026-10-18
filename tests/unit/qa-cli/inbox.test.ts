import { afterEach, describe, expect, it } from 'vitest';
import { formatInboxBrief, pluralTasks, type InboxTask } from '../../../src/qa-cli/commands/inbox.js';
import { runCli } from '../../../src/qa-cli/main.js';
import { fakeFetch, fakeGitExec, jsonResponse, makeCtx, makeTempRepo, offlineFetch, writeConfig, writeFile } from './_helpers.js';

const task = (id: string, module?: string, ageHours = 2): InboxTask => ({ id, kind: 'add_test', title: `Задача ${id}`, state: 'queued', module, ageHours });

describe('qa-cli / inbox --brief: формат', () => {
  it('одна тема — «по модулю», ID у дужках', () => {
    expect(formatInboxBrief({ tasks: [task('CYBER-T-12', 'Акти'), task('CYBER-T-15', 'Акти')], total: 2 })).toBe(
      'Jules: 2 задачі QA по модулю Акти (CYBER-T-12, CYBER-T-15). Взяти: /qa-inbox',
    );
  });

  it('більше трьох — перші три ID і «…», кілька модулів і найстаріша задача другим рядком', () => {
    const line = formatInboxBrief({
      tasks: [task('T-1', 'Акти', 80), task('T-2', 'Оплати'), task('T-3', 'Акти'), task('T-4')],
      total: 5,
    });
    expect(line).toBe('Jules: 5 задач QA по модулях Акти, Оплати (T-1, T-2, T-3 …). Взяти: /qa-inbox\nНайстаріша чекає 3 дн.');
  });

  it('без модулів — без «по модулю»', () => {
    expect(formatInboxBrief({ tasks: [task('T-1')], total: 1 })).toBe('Jules: 1 задача QA (T-1). Взяти: /qa-inbox');
  });

  it('порожньо — null', () => {
    expect(formatInboxBrief({ tasks: [], total: 0 })).toBeNull();
  });

  it('відмінювання «задача»', () => {
    expect([1, 2, 4, 5, 11, 12, 21, 22, 25].map(pluralTasks)).toEqual(['задача', 'задачі', 'задачі', 'задач', 'задач', 'задач', 'задача', 'задачі', 'задач']);
  });
});

describe('qa-cli / inbox через хаб', () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  function repo(): string {
    const r = makeTempRepo();
    cleanup = r.cleanup;
    writeConfig(r.root, { hub: 'https://mac.tail.ts.net', projectId: 'cyber' });
    writeFile(r.root, 'src/acts/acts.ts', '');
    writeFile(r.root, 'src/pay.ts', '');
    return r.root;
  }

  it('передає змінені файли в paths', async () => {
    const root = repo();
    const fetch = fakeFetch(() => jsonResponse({ tasks: [task('CYBER-T-12', 'Акти')], total: 1 }));
    const io = makeCtx({ cwd: root, fetch, exec: fakeGitExec({ changed: ['src/acts/acts.ts'], untracked: ['src/pay.ts'] }) });
    expect(await runCli(['inbox', '--brief'], io.ctx)).toBe(0);
    const url = new URL(fetch.calls[0]!.url);
    expect(url.pathname).toBe('/api/registry/inbox');
    expect(url.searchParams.get('projectId')).toBe('cyber');
    expect(url.searchParams.get('paths')).toBe('src/acts/acts.ts,src/pay.ts');
    expect(io.out()).toContain('Jules: 1 задача QA по модулю Акти');
  });

  it('задач немає — нічого не друкує', async () => {
    const root = repo();
    const io = makeCtx({ cwd: root, fetch: fakeFetch(() => jsonResponse({ tasks: [], total: 0 })) });
    expect(await runCli(['inbox', '--brief'], io.ctx)).toBe(0);
    expect(io.out()).toBe('');
  });

  it('мережа недоступна — тиша й код 0 (і в повному режимі)', async () => {
    const root = repo();
    for (const args of [['inbox', '--brief'], ['inbox']]) {
      const io = makeCtx({ cwd: root, fetch: offlineFetch() });
      expect(await runCli(args, io.ctx)).toBe(0);
      expect(io.out()).toBe('');
      expect(io.err()).toBe('');
    }
  });

  it('повний режим — список задач', async () => {
    const root = repo();
    const io = makeCtx({ cwd: root, fetch: fakeFetch(() => jsonResponse({ tasks: [task('CYBER-T-12', 'Акти', 30)], total: 1 })) });
    expect(await runCli(['inbox'], io.ctx)).toBe(0);
    expect(io.out()).toContain('CYBER-T-12  add_test  queued  [Акти]  чекає 1 дн');
  });
});

describe('qa-cli / affected', () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  it("друкує змінені файли й команду пов'язаних тестів без службових файлів", async () => {
    const r = makeTempRepo();
    cleanup = r.cleanup;
    writeConfig(r.root, { projectId: 'cyber', commands: { related: 'npx vitest related --run {files}' } });
    writeFile(r.root, 'src/a b.ts', '');
    writeFile(r.root, 'src/a.test.ts', '');
    writeFile(r.root, 'AGENTS.md', '');
    const io = makeCtx({ cwd: r.root, exec: fakeGitExec({ changed: ['src/a b.ts', 'AGENTS.md'], uncommitted: ['src/a.test.ts'] }) });
    expect(await runCli(['affected', '--json'], io.ctx)).toBe(0);
    expect(JSON.parse(io.out())).toEqual({
      base: 'origin/main',
      files: ['AGENTS.md', 'src/a b.ts', 'src/a.test.ts'],
      testFiles: ['src/a.test.ts'],
      command: "npx vitest related --run 'src/a b.ts' src/a.test.ts",
    });
  });

  it('змін немає — так і каже', async () => {
    const r = makeTempRepo();
    cleanup = r.cleanup;
    const io = makeCtx({ cwd: r.root, exec: fakeGitExec({}) });
    expect(await runCli(['affected'], io.ctx)).toBe(0);
    expect(io.out()).toContain('Змін відносно origin/main немає');
  });
});

describe('qa-cli / case reserve', () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  it('шле секцію, заголовок і поля й друкує лише ID у stdout', async () => {
    const r = makeTempRepo();
    cleanup = r.cleanup;
    writeConfig(r.root, { hub: 'https://mac.tail.ts.net', projectId: 'cyber' });
    const fetch = fakeFetch(() => jsonResponse({ caseId: 'CYBER-ACT-031', proposalId: 5 }));
    const io = makeCtx({ cwd: r.root, fetch });
    const code = await runCli(['case', 'reserve', '--section', 'ACT', '--title', 'Акт без суми', '--priority', 'p1', '--kind', 'negative', '--check', 'кнопка вимкнена'], io.ctx);
    expect(code).toBe(0);
    expect(fetch.calls[0]!.url).toBe('https://mac.tail.ts.net/api/registry/cases/reserve');
    expect(fetch.calls[0]!.body).toEqual({ projectId: 'cyber', section: 'ACT', title: 'Акт без суми', kind: 'negative', priority: 'P1', checks: ['кнопка вимкнена'] });
    expect(io.out()).toBe('CYBER-ACT-031\n');
  });

  it('невідомий пріоритет — помилка використання без запиту', async () => {
    const r = makeTempRepo();
    cleanup = r.cleanup;
    writeConfig(r.root, { hub: 'https://mac.tail.ts.net', projectId: 'cyber' });
    const fetch = fakeFetch(() => jsonResponse({}));
    const io = makeCtx({ cwd: r.root, fetch });
    expect(await runCli(['case', 'reserve', '--section', 'ACT', '--title', 'x', '--priority', 'P9'], io.ctx)).toBe(1);
    expect(fetch.calls).toHaveLength(0);
  });
});
