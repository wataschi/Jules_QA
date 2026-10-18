import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../../src/qa-cli/main.js';
import { fakeFetch, fakeGitExec, fakeShell, jsonResponse, makeCtx, makeTempRepo, offlineFetch, writeConfig, writeFile } from './_helpers.js';

const CONFIG = {
  hub: 'https://mac.tail.ts.net',
  projectId: 'cyber',
  testFileGlobs: ['**/*.test.*', 'e2e/**'],
  commands: { testFile: 'npx vitest run {files}', related: 'npx vitest related --run {files}' },
};

describe('qa-cli / hook post-edit', () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  function repo(config: Record<string, unknown> | null = CONFIG): string {
    const r = makeTempRepo();
    cleanup = r.cleanup;
    if (config) writeConfig(r.root, config);
    writeFile(r.root, 'src/acts/acts.test.ts', "it('x', () => {})\n");
    writeFile(r.root, 'src/acts/acts.ts', 'export {}\n');
    return r.root;
  }

  const payload = (file: string) => JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: file } });

  it('зелений тест-файл — код 0, команда з шляхом відносно кореня', async () => {
    const root = repo();
    const shell = fakeShell({ code: 0 });
    const io = makeCtx({ cwd: root, shell, stdin: payload(path.join(root, 'src/acts/acts.test.ts')) });
    expect(await runCli(['hook', 'post-edit'], io.ctx)).toBe(0);
    expect(shell.commands).toEqual(['npx vitest run src/acts/acts.test.ts']);
    expect(io.err()).toBe('');
  });

  it('червоний тест-файл — код 2 і хвіст виводу в stderr', async () => {
    const root = repo();
    const output = Array.from({ length: 100 }, (_, i) => `рядок ${i + 1}`).join('\n');
    const io = makeCtx({ cwd: root, shell: fakeShell({ code: 1, output: `\x1b[31m${output}\x1b[0m` }), stdin: payload(path.join(root, 'src/acts/acts.test.ts')) });
    expect(await runCli(['hook', 'post-edit'], io.ctx)).toBe(2);
    expect(io.err()).toContain('тест-файл src/acts/acts.test.ts червоний');
    expect(io.err()).toContain('рядок 100');
    expect(io.err()).toContain('рядок 41');
    expect(io.err()).not.toContain('рядок 40\n');
    expect(io.err()).not.toContain('\x1b[');
  });

  it('не тест-файл — нічого не запускає', async () => {
    const root = repo();
    const shell = fakeShell({ code: 1 });
    const io = makeCtx({ cwd: root, shell, stdin: payload(path.join(root, 'src/acts/acts.ts')) });
    expect(await runCli(['hook', 'post-edit'], io.ctx)).toBe(0);
    expect(shell.commands).toEqual([]);
  });

  it('без конфігу, з битим JSON або порожнім stdin — тихий код 0', async () => {
    const root = repo(null);
    const shell = fakeShell({ code: 1 });
    for (const stdin of [payload(path.join(root, 'src/acts/acts.test.ts')), '{oops', '']) {
      const io = makeCtx({ cwd: root, shell, stdin });
      expect(await runCli(['hook', 'post-edit'], io.ctx)).toBe(0);
      expect(io.err()).toBe('');
    }
    expect(shell.commands).toEqual([]);
  });

  it('файл поза репо — пропуск', async () => {
    const root = repo();
    const shell = fakeShell({ code: 1 });
    const io = makeCtx({ cwd: root, shell, stdin: payload('/elsewhere/a.test.ts') });
    expect(await runCli(['hook', 'post-edit'], io.ctx)).toBe(0);
    expect(shell.commands).toEqual([]);
  });
});

describe('qa-cli / hook stop', () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  function repo(): string {
    const r = makeTempRepo();
    cleanup = r.cleanup;
    writeConfig(r.root, CONFIG);
    writeFile(r.root, 'src/acts/acts.ts', 'export {}\n');
    writeFile(r.root, 'src/acts/acts.test.ts', "it('x', () => {})\n");
    return r.root;
  }

  it('stop_hook_active — одразу 0, без прогону', async () => {
    const root = repo();
    const shell = fakeShell({ code: 1 });
    const io = makeCtx({ cwd: root, shell, exec: fakeGitExec({ uncommitted: ['src/acts/acts.ts'] }), stdin: JSON.stringify({ stop_hook_active: true }) });
    expect(await runCli(['hook', 'stop'], io.ctx)).toBe(0);
    expect(shell.commands).toEqual([]);
  });

  it('змін немає — 0, без прогону', async () => {
    const root = repo();
    const shell = fakeShell({ code: 1 });
    const io = makeCtx({ cwd: root, shell, exec: fakeGitExec({}), stdin: JSON.stringify({ stop_hook_active: false }) });
    expect(await runCli(['hook', 'stop'], io.ctx)).toBe(0);
    expect(shell.commands).toEqual([]);
  });

  it("червоні пов'язані тести — код 2; видалені файли в команду не йдуть", async () => {
    const root = repo();
    const shell = fakeShell({ code: 1, output: 'FAIL src/acts/acts.test.ts\nAssertionError' });
    const io = makeCtx({
      cwd: root,
      shell,
      exec: fakeGitExec({ changed: ['src/acts/acts.ts', 'src/gone.ts'], untracked: ['src/acts/acts.test.ts'] }),
      stdin: JSON.stringify({ stop_hook_active: false }),
    });
    expect(await runCli(['hook', 'stop'], io.ctx)).toBe(2);
    expect(shell.commands).toEqual(['npx vitest related --run src/acts/acts.test.ts src/acts/acts.ts']);
    expect(io.err()).toContain("пов'язані зі змінами тести червоні");
    expect(io.err()).toContain('AssertionError');
  });

  it('змінено лише службові файли (.md, .claude, qa) — 0, без прогону', async () => {
    const root = repo();
    writeFile(root, 'README.md', '#');
    writeFile(root, '.claude/settings.json', '{}');
    const shell = fakeShell({ code: 1 });
    const io = makeCtx({ cwd: root, shell, exec: fakeGitExec({ uncommitted: ['README.md', '.claude/settings.json', 'qa/jules.config.json'] }), stdin: '{}' });
    expect(await runCli(['hook', 'stop'], io.ctx)).toBe(0);
    expect(shell.commands).toEqual([]);
  });

  it('зелені тести — 0', async () => {
    const root = repo();
    const io = makeCtx({ cwd: root, shell: fakeShell({ code: 0 }), exec: fakeGitExec({ uncommitted: ['src/acts/acts.ts'] }), stdin: '{}' });
    expect(await runCli(['hook', 'stop'], io.ctx)).toBe(0);
  });

  it('не git-репо — тихий 0', async () => {
    const root = repo();
    const shell = fakeShell({ code: 1 });
    const io = makeCtx({ cwd: root, shell, exec: fakeGitExec({ notRepo: true }), stdin: '{}' });
    expect(await runCli(['hook', 'stop'], io.ctx)).toBe(0);
    expect(shell.commands).toEqual([]);
  });
});

describe('qa-cli / hook session-start', () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  it('хаб недоступний — тиша й код 0', async () => {
    const r = makeTempRepo();
    cleanup = r.cleanup;
    writeConfig(r.root, CONFIG);
    const io = makeCtx({ cwd: r.root, fetch: offlineFetch(), stdin: JSON.stringify({ hook_event_name: 'SessionStart' }) });
    expect(await runCli(['hook', 'session-start'], io.ctx)).toBe(0);
    expect(io.out()).toBe('');
    expect(io.err()).toBe('');
  });

  it('є задачі — короткий рядок у stdout (потрапляє в контекст агента)', async () => {
    const r = makeTempRepo();
    cleanup = r.cleanup;
    writeConfig(r.root, CONFIG);
    const fetch = fakeFetch(() => jsonResponse({ tasks: [{ id: 'CYBER-T-12', kind: 'add_test', title: 'x', state: 'queued', module: 'Акти', ageHours: 3 }], total: 1 }));
    const io = makeCtx({ cwd: r.root, fetch, env: { CLAUDE_PROJECT_DIR: r.root }, stdin: '{}' });
    expect(await runCli(['hook', 'session-start'], io.ctx)).toBe(0);
    expect(io.out().trim()).toBe('Jules: 1 задача QA по модулю Акти (CYBER-T-12). Взяти: /qa-inbox');
  });

  it('невідомий хук — помилка використання', async () => {
    const io = makeCtx({ stdin: '{}' });
    expect(await runCli(['hook', 'pre-push'], io.ctx)).toBe(1);
  });
});
