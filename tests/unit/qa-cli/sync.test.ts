import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../../src/qa-cli/main.js';
import { createHubClient, HubError, HubUnavailable } from '../../../src/qa-cli/hub.js';
import { FIXTURES, fakeFetch, fakeGitExec, jsonResponse, makeCtx, makeTempRepo, offlineFetch, readFile, writeConfig, writeFile } from './_helpers.js';

const HUB = 'https://mac.tail.ts.net';

const PR_DIFF = `diff --git a/src/acts/acts.test.ts b/src/acts/acts.test.ts
index 1111111..2222222 100644
--- a/src/acts/acts.test.ts
+++ b/src/acts/acts.test.ts
@@ -10,3 +10,3 @@ describe('Акти', () => {
   it('CYBER-ACT-014 акт без суми не зберігається', () => {
-    expect(save(act)).toBe(false);
+    expect(save(act)).toBe(true);
   });
`;

describe('qa-cli / sync', () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  function repo(): string {
    const r = makeTempRepo();
    cleanup = r.cleanup;
    writeConfig(r.root, {
      hub: HUB,
      projectId: 'cyber',
      reports: { tests: ['test-results/junit.xml'], coverage: ['coverage/lcov.info'], mutation: ['reports/mutation/mutation.json'] },
      levels: { e2e: ['e2e/**'] },
    });
    writeFile(r.root, 'test-results/junit.xml', fs.readFileSync(path.join(FIXTURES, 'junit.xml'), 'utf-8'));
    writeFile(r.root, 'coverage/lcov.info', fs.readFileSync(path.join(FIXTURES, 'lcov.info'), 'utf-8'));
    return r.root;
  }

  const hubOk = () => fakeFetch(() => jsonResponse({ runId: 42, tests: 4, failed: 1, unknownCases: ['CYBER-AUTH-001'] }));

  it('на PR у GitHub Actions будує тіло з head SHA, гілкою, номером PR і змінами асертів', async () => {
    const root = repo();
    const eventPath = path.join(root, 'event.json');
    fs.writeFileSync(eventPath, JSON.stringify({ action: 'synchronize', number: 7, pull_request: { number: 7, head: { sha: 'headsha123456', ref: 'feature/acts' } } }));
    const fetch = hubOk();
    const io = makeCtx({
      cwd: root,
      fetch,
      exec: fakeGitExec({ diff: PR_DIFF }),
      env: {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_SHA: 'mergesha',
        GITHUB_REF_NAME: '7/merge',
        GITHUB_HEAD_REF: 'feature/acts',
        GITHUB_REPOSITORY: 'acme/cyber',
        GITHUB_RUN_ID: '99',
        JULES_TOKEN: 'ci-token-123456',
      },
    });
    expect(await runCli(['sync', '--base', 'origin/main'], io.ctx)).toBe(0);

    expect(fetch.calls).toHaveLength(1);
    const call = fetch.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${HUB}/api/registry/ingest/run`);
    expect(call.headers.Authorization).toBe('Bearer ci-token-123456');
    const body = call.body as Record<string, unknown> & { results: Array<Record<string, unknown>> };
    expect(body).toMatchObject({
      projectId: 'cyber',
      repo: 'acme/cyber',
      sha: 'headsha123456',
      branch: 'feature/acts',
      prNumber: 7,
      event: 'pr',
      source: 'ci',
      runUrl: 'https://github.com/acme/cyber/actions/runs/99',
      finishedAt: '2026-10-18T12:00:00.000Z',
    });
    expect(body.results).toHaveLength(4);
    const failed = body.results.find((r) => r.status === 'failed')!;
    expect(failed).toMatchObject({ file: 'src/acts/acts.test.ts', caseIds: ['CYBER-ACT-021'], level: 'unit' });
    expect(failed.key).toMatch(/^[0-9a-f]{16}$/);
    expect(body.results.find((r) => r.file === 'e2e/login.spec.ts')?.level).toBe('e2e');
    expect(body.coverage).toEqual([{ path: 'src/acts/acts.ts', linesFound: 10, linesHit: 8, branchesFound: 4, branchesHit: 3 }]);
    expect(body.mutation).toBeUndefined();
    expect((body.manifest as { tests: unknown[] }).tests).toHaveLength(4);
    expect(body.assertionChanges).toEqual([
      expect.objectContaining({ file: 'src/acts/acts.test.ts', kind: 'modified' }),
    ]);
    expect(io.out()).toContain('прогін 42');
    expect(io.out()).toContain('Невідомі ID кейсів у назвах тестів: CYBER-AUTH-001');
    expect(io.out()).toContain('qa:assertion-change');
  });

  it('локально бере SHA і гілку з git, event local, без змін асертів', async () => {
    const root = repo();
    const fetch = hubOk();
    const io = makeCtx({ cwd: root, fetch, exec: fakeGitExec({ head: 'localsha999', branch: 'wip', diff: PR_DIFF }) });
    expect(await runCli(['sync'], io.ctx)).toBe(0);
    const body = fetch.calls[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ sha: 'localsha999', branch: 'wip', event: 'local', source: 'local' });
    expect(body).not.toHaveProperty('prNumber');
    expect(body).not.toHaveProperty('assertionChanges');
    expect(body).not.toHaveProperty('repo');
    expect(fetch.calls[0]!.headers.Authorization).toBeUndefined();
  });

  it('прапорці перекривають оточення', async () => {
    const root = repo();
    const fetch = hubOk();
    const io = makeCtx({ cwd: root, fetch, env: { GITHUB_SHA: 'envsha', GITHUB_REF_NAME: 'main', GITHUB_EVENT_NAME: 'push' } });
    expect(await runCli(['sync', '--event', 'main', '--source', 'ci', '--sha', 'flagsha', '--branch', 'main', '--run-url', 'https://ci/1'], io.ctx)).toBe(0);
    expect(fetch.calls[0]!.body).toMatchObject({ sha: 'flagsha', branch: 'main', event: 'main', source: 'ci', runUrl: 'https://ci/1' });
  });

  it('хаб недоступний — код 1 і зрозуміле повідомлення (CI має впасти явно)', async () => {
    const root = repo();
    const io = makeCtx({ cwd: root, fetch: offlineFetch() });
    expect(await runCli(['sync', '--event', 'main'], io.ctx)).toBe(1);
    expect(io.err()).toContain('Jules недоступний');
  });

  it('без звітів — код 1, у хаб нічого не йде', async () => {
    const root = repo();
    fs.rmSync(path.join(root, 'test-results'), { recursive: true });
    const fetch = hubOk();
    const io = makeCtx({ cwd: root, fetch });
    expect(await runCli(['sync'], io.ctx)).toBe(1);
    expect(io.err()).toContain('Звітів тестів не знайдено');
    expect(fetch.calls).toHaveLength(0);
  });

  it('невалідний --event — помилка використання', async () => {
    const root = repo();
    const io = makeCtx({ cwd: root, fetch: hubOk() });
    expect(await runCli(['sync', '--event', 'nightly'], io.ctx)).toBe(1);
    expect(io.err()).toContain('--event');
  });
});

describe('qa-cli / status і pr-comment', () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  it('status пише файл лише коли вміст змінився', async () => {
    const r = makeTempRepo();
    cleanup = r.cleanup;
    writeConfig(r.root, { hub: HUB, projectId: 'cyber' });
    let text = '# Стан тестування · main @ 3f2a91c\n';
    const fetch = fakeFetch(() => new Response(text, { headers: { 'Content-Type': 'text/markdown' } }));

    const first = makeCtx({ cwd: r.root, fetch });
    expect(await runCli(['status', '--out', 'QA_STATUS.md'], first.ctx)).toBe(0);
    expect(first.out().trim()).toBe('changed');
    expect(readFile(r.root, 'QA_STATUS.md')).toBe(text);
    expect(fetch.calls[0]!.url).toBe(`${HUB}/api/registry/status.md?projectId=cyber&branch=main`);

    const second = makeCtx({ cwd: r.root, fetch });
    await runCli(['status', '--out', 'QA_STATUS.md'], second.ctx);
    expect(second.out().trim()).toBe('unchanged');

    text = '# Стан тестування · main @ 4b00000\n';
    const third = makeCtx({ cwd: r.root, fetch });
    await runCli(['status', '--out', 'QA_STATUS.md', '--branch', 'main'], third.ctx);
    expect(third.out().trim()).toBe('changed');
  });

  it('pr-comment бере номер PR і SHA з прапорців і пише файл', async () => {
    const r = makeTempRepo();
    cleanup = r.cleanup;
    writeConfig(r.root, { hub: HUB, projectId: 'cyber' });
    const fetch = fakeFetch(() => new Response('<!-- jules-qa -->\n## Jules QA\n'));
    const io = makeCtx({ cwd: r.root, fetch });
    expect(await runCli(['pr-comment', '--pr', '7', '--sha', 'abc', '--out', 'c.md'], io.ctx)).toBe(0);
    expect(fetch.calls[0]!.url).toBe(`${HUB}/api/registry/pr-comment.md?projectId=cyber&prNumber=7&sha=abc`);
    expect(readFile(r.root, 'c.md').startsWith('<!-- jules-qa -->')).toBe(true);
  });

  it('pr-comment без номера PR — помилка використання', async () => {
    const r = makeTempRepo();
    cleanup = r.cleanup;
    writeConfig(r.root, { hub: HUB, projectId: 'cyber' });
    const io = makeCtx({ cwd: r.root });
    expect(await runCli(['pr-comment'], io.ctx)).toBe(1);
    expect(io.err()).toContain('--pr');
  });
});

describe('qa-cli / клієнт хаба', () => {
  it('повторює на 429 з Retry-After і зрештою віддає відповідь', async () => {
    let n = 0;
    const waits: number[] = [];
    const fetch = fakeFetch(() => (++n < 3 ? new Response('slow', { status: 429, headers: { 'Retry-After': '2' } }) : jsonResponse({ ok: true })));
    const hub = createHubClient({ hub: HUB, fetch, sleep: async (ms) => void waits.push(ms) });
    expect(await hub.getJson('/inbox')).toEqual({ ok: true });
    expect(waits).toEqual([2000, 2000]);
  });

  it('502 від tailscale serve — HubUnavailable, 401 — HubError з підказкою про токен', async () => {
    const down = createHubClient({ hub: HUB, fetch: fakeFetch(() => new Response('', { status: 502 })) });
    await expect(down.getText('/status.md')).rejects.toBeInstanceOf(HubUnavailable);
    const denied = createHubClient({ hub: HUB, fetch: fakeFetch(() => jsonResponse({ error: 'Потрібен токен' }, 401)) });
    await expect(denied.postJson('/ingest/run', {})).rejects.toThrow(/401.*Потрібен токен.*JULES_TOKEN/);
    await expect(denied.postJson('/ingest/run', {})).rejects.toBeInstanceOf(HubError);
  });

  it('таймаут — HubUnavailable', async () => {
    const fetch = fakeFetch(() => {
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    });
    await expect(createHubClient({ hub: HUB, fetch, timeoutMs: 1000 }).getJson('/inbox')).rejects.toThrow(/немає відповіді за 1 с/);
  });
});
