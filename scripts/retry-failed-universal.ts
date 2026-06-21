/**
 * Повторний запуск невдалих / незавершених прогонів universal suite.
 */
import dotenv from 'dotenv';

dotenv.config();

const API = process.env.UI_BASE_URL ?? 'http://localhost:3840';

const RETRY_MATRIX: Array<{ site: string; url: string; scenario: string }> = [
  { site: 'example.com', url: 'https://example.com', scenario: 'scenarios/universal-cookie-consent.yaml' },
  { site: 'example.com', url: 'https://example.com', scenario: 'scenarios/universal-accessibility-smoke.yaml' },
  { site: 'wikipedia.org', url: 'https://www.wikipedia.org', scenario: 'scenarios/universal-cookie-consent.yaml' },
  { site: 'github.com', url: 'https://github.com', scenario: 'scenarios/universal-cookie-consent.yaml' },
  { site: 'github.com', url: 'https://github.com', scenario: 'scenarios/universal-navigation.yaml' },
  { site: 'github.com', url: 'https://github.com', scenario: 'scenarios/universal-search-or-interact.yaml' },
  { site: 'github.com', url: 'https://github.com', scenario: 'scenarios/universal-accessibility-smoke.yaml' },
];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, init);
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function waitForRun(id: string): Promise<{ status: string; exitCode?: number; errorSummary?: string }> {
  for (let i = 0; i < 180; i++) {
    const run = await api<{ status: string; exitCode?: number; errorSummary?: string }>(`/api/runs/${id}`);
    if (['passed', 'failed', 'cancelled'].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`Timeout ${id}`);
}

async function main(): Promise<void> {
  const results: Array<{ site: string; scenario: string; status: string; error?: string }> = [];

  for (const item of RETRY_MATRIX) {
    const name = item.scenario.replace('scenarios/', '').replace('.yaml', '');
    console.log(`\n[retry] ▶ ${item.site} × ${name}`);
    const run = await api<{ id: string }>('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qaTargetUrl: item.url, qaMode: 'warm-up', qaScenarioPath: item.scenario }),
    });
    const finished = await waitForRun(run.id);
    console.log(`[retry] → ${finished.status}`);
    results.push({ site: item.site, scenario: name, status: finished.status, error: finished.errorSummary });
  }

  console.log('\n=== RETRY SUMMARY ===');
  for (const r of results) {
    console.log(`${r.status === 'passed' ? '✓' : '✗'} ${r.site} ${r.scenario} ${r.status}`);
  }

  const reportPath = 'midscene_run/universal-suite-retry-report.json';
  await import('node:fs/promises').then((fs) =>
    fs.writeFile(reportPath, JSON.stringify({ at: new Date().toISOString(), results }, null, 2)),
  );
  process.exit(results.every((r) => r.status === 'passed') ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
