import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../../src/qa-cli/main.js';
import { fakeFetch, fakeGitExec, jsonResponse, makeCtx, makeTempRepo, readFile, writeConfig } from './_helpers.js';

const HUB = 'https://mac.tail.ts.net';

describe('qa-cli / push-check', () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  function setup(event: Record<string, unknown>) {
    const r = makeTempRepo();
    cleanup = r.cleanup;
    writeConfig(r.root, { hub: HUB, projectId: 'cyber' });
    const eventPath = path.join(r.root, 'event.json');
    fs.writeFileSync(eventPath, JSON.stringify(event));
    const env = {
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'push',
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_SHA: 'sha1234567890',
      GITHUB_REF_NAME: 'main',
      GITHUB_REPOSITORY: 'acme/cyber',
      GITHUB_TOKEN: 'gh-token-abcdef',
      JULES_TOKEN: 'ci-token-123456',
    };
    return { root: r.root, env };
  }

  function routes(pulls: unknown) {
    return fakeFetch((call) => {
      if (call.url.startsWith('https://api.github.com/')) return jsonResponse(pulls);
      return jsonResponse({ ok: true, flagged: !(Array.isArray(pulls) && pulls.length) });
    });
  }

  it('коміт зі злитого PR — viaPr: true і номери PR', async () => {
    const { root, env } = setup({ head_commit: { id: 'sha1234567890', message: 'feat: акти (#12)', author: { username: 'dev1' } } });
    const fetch = routes([{ number: 12, merged_at: '2026-10-18T10:00:00Z', base: { ref: 'main' } }, { number: 9, merged_at: null }]);
    const io = makeCtx({ cwd: root, env, fetch });
    expect(await runCli(['push-check'], io.ctx)).toBe(0);

    const [gh, hub] = fetch.calls;
    expect(gh!.url).toBe('https://api.github.com/repos/acme/cyber/commits/sha1234567890/pulls?per_page=100');
    expect(gh!.headers.Authorization).toBe('Bearer gh-token-abcdef');
    expect(hub!.url).toBe(`${HUB}/api/registry/ingest/push-check`);
    expect(hub!.headers.Authorization).toBe('Bearer ci-token-123456');
    expect(hub!.body).toEqual({ projectId: 'cyber', sha: 'sha1234567890', branch: 'main', viaPr: true, prNumbers: [12], author: 'dev1' });
    expect(io.out()).toContain('через PR #12');
  });

  it('пуш повз PR — viaPr: false, попередження в stderr', async () => {
    const { root, env } = setup({ head_commit: { id: 'sha1234567890', message: 'fix: напряму', author: { username: 'agent' } } });
    const fetch = routes([]);
    const io = makeCtx({ cwd: root, env, fetch });
    expect(await runCli(['push-check'], io.ctx)).toBe(0);
    expect(fetch.calls[1]!.body).toMatchObject({ viaPr: false, prNumbers: [], author: 'agent' });
    expect(io.err()).toContain('без PR (agent) — позначено в Jules');
  });

  it('коміт бота з [skip ci] — пропуск без жодного запиту', async () => {
    const { root, env } = setup({ head_commit: { id: 'sha1234567890', message: 'chore(qa): оновити QA_STATUS.md [skip ci]' } });
    const fetch = routes([]);
    const io = makeCtx({ cwd: root, env, fetch });
    expect(await runCli(['push-check'], io.ctx)).toBe(0);
    expect(fetch.calls).toHaveLength(0);
    expect(io.out()).toContain('[skip ci]');
  });

  it('помилка GitHub API — код 1, у хаб нічого не йде', async () => {
    const { root, env } = setup({ head_commit: { id: 'sha1234567890', message: 'feat' } });
    const fetch = fakeFetch((call) => (call.url.includes('api.github.com') ? new Response('Not Found', { status: 404 }) : jsonResponse({})));
    const io = makeCtx({ cwd: root, env, fetch, exec: fakeGitExec() });
    expect(await runCli(['push-check'], io.ctx)).toBe(1);
    expect(io.err()).toContain('GitHub API відповів 404');
    expect(fetch.calls).toHaveLength(1);
  });
});

describe('qa-cli / pr-event', () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  it('злитий PR із GITHUB_EVENT_PATH → POST /ingest/pr-event', async () => {
    const r = makeTempRepo();
    cleanup = r.cleanup;
    writeConfig(r.root, { hub: HUB, projectId: 'cyber' });
    const eventPath = path.join(r.root, 'event.json');
    fs.writeFileSync(
      eventPath,
      JSON.stringify({ action: 'closed', pull_request: { number: 12, merged: true, title: 'Тести актів', html_url: 'https://github.com/acme/cyber/pull/12', head: { sha: 'h1', ref: 'qa/req-12' } } }),
    );
    const fetch = fakeFetch(() => jsonResponse({ ok: true, tasksUpdated: 2 }));
    const io = makeCtx({ cwd: r.root, env: { GITHUB_EVENT_PATH: eventPath }, fetch });
    expect(await runCli(['pr-event'], io.ctx)).toBe(0);
    expect(fetch.calls[0]!.body).toEqual({
      projectId: 'cyber',
      prNumber: 12,
      state: 'merged',
      sha: 'h1',
      headBranch: 'qa/req-12',
      title: 'Тести актів',
      url: 'https://github.com/acme/cyber/pull/12',
    });
    expect(io.out()).toContain('оновлено задач: 2');
    expect(readFile(r.root, 'event.json')).toContain('closed');
  });

  it('без події й без --state — помилка використання', async () => {
    const r = makeTempRepo();
    cleanup = r.cleanup;
    writeConfig(r.root, { hub: HUB, projectId: 'cyber' });
    const io = makeCtx({ cwd: r.root });
    expect(await runCli(['pr-event'], io.ctx)).toBe(1);
    expect(io.err()).toContain('--state');
  });
});

describe('qa-cli / assert-guard', () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  const DIFF = `diff --git a/src/a.test.ts b/src/a.test.ts
--- a/src/a.test.ts
+++ b/src/a.test.ts
@@ -1,3 +1,2 @@
 it('CYBER-ACT-1 x', () => {
-  expect(total).toBe(100);
 });
`;

  it('є змінені асерти — список і label=qa:assertion-change, код 0, рядок у GITHUB_OUTPUT', async () => {
    const r = makeTempRepo();
    cleanup = r.cleanup;
    writeConfig(r.root, { projectId: 'cyber' });
    const output = path.join(r.root, 'gh-output');
    const io = makeCtx({ cwd: r.root, exec: fakeGitExec({ diff: DIFF }), env: { GITHUB_OUTPUT: output } });
    expect(await runCli(['assert-guard', '--base', 'origin/main'], io.ctx)).toBe(0);
    expect(io.out()).toContain('src/a.test.ts:2  видалено: expect(total).toBe(100);');
    expect(io.out().trim().endsWith('label=qa:assertion-change')).toBe(true);
    expect(readFile(r.root, 'gh-output')).toBe('label=qa:assertion-change\ncount=1\n');
  });

  it('змін немає — код 0 і без мітки', async () => {
    const r = makeTempRepo();
    cleanup = r.cleanup;
    writeConfig(r.root, { projectId: 'cyber' });
    const io = makeCtx({ cwd: r.root, exec: fakeGitExec({ diff: '' }) });
    expect(await runCli(['assert-guard', '--json'], io.ctx)).toBe(0);
    expect(JSON.parse(io.out())).toEqual({ base: 'origin/main', label: null, changes: [] });
  });

  it('git недоступний — однаково код 0', async () => {
    const r = makeTempRepo();
    cleanup = r.cleanup;
    const io = makeCtx({ cwd: r.root, exec: fakeGitExec({ notRepo: true }) });
    expect(await runCli(['assert-guard'], io.ctx)).toBe(0);
    expect(io.err()).toContain('пропущено');
  });
});
