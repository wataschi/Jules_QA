/**
 * Запуск універсальних сценаріїв на кількох сайтах через Dashboard API.
 * Usage: npx tsx scripts/run-universal-suite.ts
 */
import dotenv from 'dotenv';

dotenv.config();

const API = process.env.UI_BASE_URL ?? 'http://localhost:3840';

const SCENARIOS = [
  'scenarios/universal-page-load.yaml',
  'scenarios/universal-cookie-consent.yaml',
  'scenarios/universal-navigation.yaml',
  'scenarios/universal-search-or-interact.yaml',
  'scenarios/universal-accessibility-smoke.yaml',
];

const SITES = [
  { name: 'example.com', url: 'https://example.com' },
  { name: 'wikipedia.org', url: 'https://www.wikipedia.org' },
  { name: 'github.com', url: 'https://github.com' },
];

interface RunSummary {
  id: string;
  status: string;
  qaTargetUrl: string;
  qaScenarioPath: string;
  scenarioName?: string;
  exitCode?: number;
  errorSummary?: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, init);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${path} → ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

async function waitForRun(id: string, timeoutMs = 900_000): Promise<RunSummary> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = await api<RunSummary & { logs?: string[] }>(`/api/runs/${id}`);
    if (run.status === 'passed' || run.status === 'failed' || run.status === 'cancelled') {
      return run;
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`Timeout waiting for run ${id}`);
}

async function main(): Promise<void> {
  console.log(`[suite] API: ${API}`);
  const health = await api<{ ok: boolean }>('/api/health');
  console.log('[suite] Health:', health);

  const llm = await api<{ ok: boolean; models?: string[] }>('/api/llm/check');
  if (!llm.ok) {
    console.error('[suite] LM Studio недоступний — тести не можуть виконатись');
    process.exit(1);
  }
  console.log('[suite] LLM OK, models:', llm.models?.slice(0, 3).join(', '));

  const results: Array<{
    site: string;
    scenario: string;
    status: string;
    exitCode?: number;
    error?: string;
    runId: string;
  }> = [];

  for (const site of SITES) {
    for (const scenarioPath of SCENARIOS) {
      const scenarioName = scenarioPath.replace('scenarios/', '').replace('.yaml', '');
      console.log(`\n[suite] ▶ ${site.name} × ${scenarioName}`);

      const run = await api<RunSummary>('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          qaTargetUrl: site.url,
          qaMode: 'warm-up',
          qaScenarioPath: scenarioPath,
        }),
      });

      console.log(`[suite] Run ID: ${run.id}`);
      const finished = await waitForRun(run.id);
      console.log(`\n[suite] Result: ${finished.status} (exit ${finished.exitCode ?? '?'})`);

      results.push({
        site: site.name,
        scenario: scenarioName,
        status: finished.status,
        exitCode: finished.exitCode,
        error: finished.errorSummary,
        runId: finished.id,
      });
    }
  }

  console.log('\n\n========== SUMMARY ==========');
  const passed = results.filter((r) => r.status === 'passed').length;
  console.log(`Passed: ${passed}/${results.length}\n`);

  for (const r of results) {
    const icon = r.status === 'passed' ? '✓' : '✗';
    console.log(`${icon} ${r.site.padEnd(16)} ${r.scenario.padEnd(32)} ${r.status}${r.error ? ` — ${r.error}` : ''}`);
  }

  const reportPath = 'midscene_run/universal-suite-report.json';
  await import('node:fs/promises').then((fs) =>
    fs.writeFile(reportPath, JSON.stringify({ at: new Date().toISOString(), results }, null, 2)),
  );
  console.log(`\nReport: ${reportPath}`);

  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
