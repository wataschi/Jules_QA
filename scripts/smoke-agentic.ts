/**
 * Наскрізна перевірка циклу «QA направляє, агент робить» проти живого Jules.
 *
 * Проходить шлях з усіма справжніми частинами: QA створює запит → агент бере
 * його через MCP і звітує з PR → CLI з репо продукту (бандл, який роздає сам
 * Jules) шле результати PR → коментар у PR → QA підтверджує → PR злито →
 * результати main → кейс автоматизовано, QA_STATUS.md; падіння на main дає
 * задачу розбору. Створює окремий проєкт SMK… і тимчасове git-репо.
 *
 *   npm run start                  # у окремому терміналі (або Jules на Mac Studio)
 *   npm run smoke:agentic          # npx tsx scripts/smoke-agentic.ts
 *
 * Змінні: JULES_URL (дефолт http://127.0.0.1:3840), JULES_API_TOKEN (адмін-токен,
 * якщо ввімкнено JULES_REQUIRE_AUTH).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = (process.env.JULES_URL ?? 'http://127.0.0.1:3840').replace(/\/$/, '');
const API = `${BASE}/api/registry`;
const ADMIN = process.env.JULES_API_TOKEN;
const DEV = 'smoke-dev';

let failures = 0;
let checks = 0;

function expect(condition: unknown, label: string, detail = ''): void {
  checks += 1;
  if (condition) {
    console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`  ✕ ${label} — ${detail || 'умова не виконалась'}`);
  }
}

async function call<T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: T; text: string }> {
  const all: Record<string, string> = { 'X-Jules-User': DEV, ...headers };
  if (ADMIN && !all.Authorization) all.Authorization = `Bearer ${ADMIN}`;
  if (body !== undefined) all['Content-Type'] = 'application/json';
  const response = await fetch(url.startsWith('http') ? url : `${API}${url}`, {
    method,
    headers: all,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* markdown або JS */
  }
  return { status: response.status, data: data as T, text };
}

function cli(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync(process.execPath, ['jules-qa.mjs', ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function junit(caseId: string, failing: boolean): string {
  return `<?xml version="1.0"?><testsuites><testsuite name="tests/acts.test.ts" file="tests/acts.test.ts" tests="2">
<testcase classname="tests/acts.test.ts" file="tests/acts.test.ts" name="${caseId} акт без суми не зберігається" time="0.1"/>
<testcase classname="tests/acts.test.ts" file="tests/acts.test.ts" name="форматує суму" time="0.01">${failing ? '<failure message="expected 1">boom</failure>' : ''}</testcase>
</testsuite></testsuites>`;
}

async function main(): Promise<void> {
  console.log(`Наскрізна перевірка циклу з агентами: ${BASE}\n`);
  const health = await call('GET', `${BASE}/api/health`);
  expect(health.status === 200, 'сервер живий');
  if (health.status !== 200) return;

  const key = `SMK${Date.now().toString(36).toUpperCase().slice(-5)}`.replace(/[^A-Z0-9]/g, '').slice(0, 10);
  const project = await call('POST', '/projects', { key, name: `Смоук ${key}` });
  expect(project.status === 201, 'проєкт створено', key);
  const projectId = project.data.id as string;
  const section = await call('POST', '/sections', { projectId, name: 'Акти', code: 'AKT' });
  await call('PATCH', `/sections/${section.data.id}`, { paths: ['src/acts/**', 'tests/acts*'], owners: [DEV] });
  const created = await call('POST', '/cases', { projectId, sectionId: section.data.id, title: 'Акт без суми не зберігається', status: 'approved', priority: 'P1' });
  const caseId = created.data.id as string;
  expect(/^SMK.*-AKT-\d{3}$/.test(caseId), 'кейс зі стабільним ID', caseId);

  const token = await call('POST', '/tokens', { name: 'CI smoke', role: 'ci', projectId });
  expect(token.status === 201 && String(token.data.token).startsWith('jqa_'), 'токен CI видано');
  const ci = { Authorization: `Bearer ${token.data.token}` };
  const forbidden = await call('GET', `/cases?projectId=${projectId}`, undefined, ci);
  expect(forbidden.status === 403, 'токен CI не бачить реєстр', `HTTP ${forbidden.status}`);

  const task = await call('POST', '/tasks', { projectId, kind: 'add_test', title: 'Акт без суми не має зберігатися', anchor: { caseId } });
  expect(task.status === 201 && task.data.state === 'queued', 'QA створив запит', task.data.id);
  const taskId = task.data.id as string;

  // ── агент через MCP ──
  const client = new Client({ name: 'smoke-agent', version: '1.0.0' });
  const headers: Record<string, string> = { 'X-Jules-User': DEV };
  if (ADMIN) headers.Authorization = `Bearer ${ADMIN}`;
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers } }));
  const tools = await client.listTools();
  expect(tools.tools.some((tool) => tool.name === 'qa_claim'), 'MCP віддає інструменти', `${tools.tools.length} шт.`);
  const text = (result: Awaited<ReturnType<typeof client.callTool>>) => (result.content as Array<{ text?: string }>)[0]?.text ?? '';
  const inbox = JSON.parse(text(await client.callTool({ name: 'qa_inbox', arguments: { projectId, paths: ['src/acts/form.ts'] } })));
  expect(inbox.tasks.some((item: { id: string; mine: boolean }) => item.id === taskId && item.mine), 'задача у вхідних власника модуля');
  const claim = JSON.parse(text(await client.callTool({ name: 'qa_claim', arguments: { taskId, agent: 'smoke', model: 'none' } })));
  expect(claim.task.state === 'claimed' && claim.context.case.id === caseId, 'агент узяв задачу з контекстом кейса');
  const report = await client.callTool({
    name: 'qa_report',
    arguments: {
      taskId,
      summary: 'Тест на акт без суми',
      checks: ['Форма не зберігається', 'Поле суми підсвічене'],
      tests: [{ file: 'tests/acts.test.ts', name: `${caseId} акт без суми не зберігається`, caseIds: [caseId] }],
      prUrl: 'https://github.com/acme/app/pull/77',
    },
  });
  expect(!report.isError && JSON.parse(text(report)).task.state === 'review', 'агент звітував із PR');
  await client.close();

  // ── CI репо продукту з бандлом CLI від Jules ──
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'jules-smoke-repo-'));
  try {
    const bundle = await call('GET', `${BASE}/cli/jules-qa.mjs`);
    expect(bundle.status === 200 && bundle.text.includes('jules-qa'), 'Jules роздає зібраний CLI');
    fs.writeFileSync(path.join(repo, 'jules-qa.mjs'), bundle.text);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'smoke@jules');
    git(repo, 'config', 'user.name', 'smoke');
    fs.mkdirSync(path.join(repo, 'test-results'));
    fs.writeFileSync(path.join(repo, 'test-results/junit.xml'), junit(caseId, false));
    cli(repo, ['init', '--hub', BASE, '--project', projectId]);
    expect(fs.existsSync(path.join(repo, 'qa/jules.config.json')) && fs.existsSync(path.join(repo, '.mcp.json')), 'init підключив репо');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'init');
    const sha = git(repo, 'rev-parse', 'HEAD');
    const env = { JULES_TOKEN: String(token.data.token) };

    cli(repo, ['manifest']);
    const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'qa/manifest.json'), 'utf8'));
    expect(manifest.tests.length === 2, 'маніфест зібрано зі звіту', `${manifest.tests.length} тестів`);
    cli(repo, ['sync', '--event', 'pr', '--pr', '77', '--branch', 'qa/req', '--sha', sha], env);
    cli(repo, ['pr-comment', '--pr', '77', '--out', 'comment.md'], env);
    const comment = fs.readFileSync(path.join(repo, 'comment.md'), 'utf8');
    expect(comment.startsWith('<!-- jules-qa -->') && comment.includes(caseId), 'коментар у PR з кейсом');

    const tests = await call('GET', `/tests?projectId=${projectId}&caseId=${caseId}`);
    expect(tests.data.items?.[0]?.author === 'agent', 'тест позначено як написаний агентом');
    const confirmed = await call('POST', `/tasks/${taskId}/confirm`, {});
    expect(confirmed.data.state === 'review', 'QA підтвердив намір, чекаємо злиття');

    const eventFile = path.join(repo, 'event.json');
    fs.writeFileSync(eventFile, JSON.stringify({ pull_request: { number: 77, merged: true, head: { ref: 'qa/req', sha }, title: 'test', html_url: 'https://github.com/acme/app/pull/77' } }));
    cli(repo, ['pr-event', '--state', 'merged'], { ...env, GITHUB_EVENT_PATH: eventFile });
    cli(repo, ['sync', '--event', 'main', '--branch', 'main', '--sha', sha], env);
    const done = await call('GET', `/tasks/${taskId}`);
    expect(done.data.task?.state === 'done', 'задача закрита після злиття', done.data.task?.state);
    const caseAfter = await call('GET', `/cases/${caseId}`);
    expect(caseAfter.data.automation?.status === 'automated', 'кейс автоматизовано тестом із main');

    fs.writeFileSync(path.join(repo, 'test-results/junit.xml'), junit(caseId, true));
    cli(repo, ['sync', '--event', 'main', '--branch', 'main', '--sha', `${sha.slice(0, 30)}ffffffffff`], env);
    const triage = await call('GET', `/tasks?projectId=${projectId}&kind=triage`);
    expect(triage.data.total === 1, 'падіння на main дало задачу розбору');

    cli(repo, ['status', '--out', 'QA_STATUS.md'], env);
    const status = fs.readFileSync(path.join(repo, 'QA_STATUS.md'), 'utf8');
    expect(status.includes('# Стан тестування · main') && status.includes('Впали'), 'QA_STATUS.md згенеровано');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }

  console.log(`\n${checks - failures} з ${checks} перевірок пройшли${failures ? `, ${failures} — ні` : ''}.`);
  if (failures) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
