import fs from 'node:fs/promises';
import path from 'node:path';
import { artifactNameCandidates, scenarioKey } from '../config/env.js';
import { getMidsceneRunRoot } from '../server/data-paths.js';
import { loadRunResults, type RunResults } from '../engine/results.js';

/**
 * Опції збору артефактів.
 *
 * `since` робить збір ПРОГОНО-орієнтованим: у звіт потрапляють лише відео та
 * Midscene-звіти, створені після старту цього прогону. Без цього кожен звіт
 * тягнув усе, що лежить у каталозі, і «докази» падіння тонули серед чужих.
 */
export interface CollectOptions {
  /** ISO-час або мілісекунди старту прогону. */
  since?: string | number;
}

function toEpoch(since: CollectOptions['since']): number | null {
  if (since === undefined) return null;
  const value = typeof since === 'number' ? since : Date.parse(since);
  return Number.isFinite(value) ? value : null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderEvidence(results: RunResults | null): string {
  if (!results) {
    return '<p>No structured results captured for this run.</p>';
  }

  const { summary } = results;
  const badge = (status: string): string => {
    const color =
      status === 'passed'
        ? '#137333'
        : status === 'healed'
          ? '#9a6700'
          : status === 'failed'
            ? '#b3261e'
            : '#5f6368';
    return `<span style="color:#fff;background:${color};padding:1px 8px;border-radius:10px;font-size:.8rem">${status}</span>`;
  };

  const rows = results.steps
    .map(
      (s) => `<tr>
        <td>${s.index + 1}</td>
        <td>${s.kind}</td>
        <td>${escapeHtml(s.instruction)}</td>
        <td>${badge(s.status)}</td>
        <td>${s.handledBy}</td>
        <td>${s.attempts}${s.healed ? ' 🩹' : ''}</td>
        <td>${s.durationMs} ms</td>
        <td>${s.modelCalls ?? '—'}</td>
        <td>${s.error ? escapeHtml(s.error) : s.thought ? escapeHtml(s.thought) : ''}</td>
      </tr>`,
    )
    .join('');

  const bugs = results.bugReports.length
    ? results.bugReports
        .map(
          (b) => `<div class="bug">
        <strong>[${b.severity}]</strong> ${escapeHtml(b.assertion)}
        <p>${escapeHtml(b.rootCauseHypothesis)}</p>
      </div>`,
        )
        .join('')
    : '<p>No application defects detected by assertions.</p>';

  return `
    <p>
      <strong>Summary:</strong> total ${summary.total},
      passed ${summary.passed}, failed ${summary.failed}, healed ${summary.healed},
      skipped ${summary.skipped} ·
      <strong>model calls:</strong> ${summary.modelCalls} ·
      <strong>verdict:</strong> ${results.passed ? '✅ passed' : '❌ failed'}
    </p>
    ${results.generatedSpecPath ? `<p><strong>Deterministic spec:</strong> <code>${escapeHtml(results.generatedSpecPath)}</code></p>` : ''}
    <table>
      <thead><tr><th>#</th><th>Kind</th><th>Instruction</th><th>Status</th><th>Handled by</th><th>Attempts</th><th>Duration</th><th>LLM calls</th><th>Detail</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <h3>Bug reports</h3>
    ${bugs}
  `;
}

interface ReportLinks {
  midsceneReports: string[];
  playwrightReport: string | null;
  videos: string[];
  plans: string[];
}

export interface ReportUrls {
  midsceneReports: string[];
  playwrightReport: string | null;
  videos: string[];
  plans: string[];
}

async function findFiles(
  dir: string,
  predicate: (name: string) => boolean,
  modifiedAfter?: number | null,
): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && predicate(entry.name)) {
        if (modifiedAfter !== undefined && modifiedAfter !== null) {
          // Артефакт належить прогону лише якщо створений/оновлений після старту.
          // 1 с допуску — на розбіжність таймстемпів файлової системи.
          const stat = await fs.stat(full).catch(() => null);
          if (!stat || stat.mtimeMs < modifiedAfter - 1000) continue;
        }
        results.push(full);
      }
    }
  }

  await walk(dir);
  return results.sort();
}

export async function collectReportLinks(
  scenarioIdOrKey: string,
  opts?: CollectOptions,
): Promise<ReportLinks> {
  const root = process.cwd();
  const midsceneRoot = getMidsceneRunRoot();
  const since = toEpoch(opts?.since);

  const midsceneReports = await findFiles(
    path.join(midsceneRoot, 'report'),
    (name) => name.endsWith('.html') && name.includes('report'),
    since,
  );

  const playwrightIndex = path.join(root, 'playwright-report', 'index.html');
  let playwrightReport: string | null = null;
  try {
    await fs.access(playwrightIndex);
    playwrightReport = playwrightIndex;
  } catch {
    playwrightReport = null;
  }

  const videos = await findFiles(
    path.join(root, 'test-results'),
    (name) => name.endsWith('.webm'),
    since,
  );

  // План читаємо за ключем, з fallback на стару назву без хеша.
  const plans: string[] = [];
  for (const name of artifactNameCandidates(scenarioIdOrKey)) {
    const planFile = path.join(midsceneRoot, 'plans', `${name}.json`);
    try {
      await fs.access(planFile);
      plans.push(planFile);
      break;
    } catch {
      /* пробуємо наступного кандидата */
    }
  }

  return { midsceneReports, playwrightReport, videos, plans };
}

function toRelative(filePath: string): string {
  return path.relative(process.cwd(), filePath).replace(/\\/g, '/');
}

export function filePathToReportUrl(filePath: string): string {
  const rel = toRelative(filePath);
  const midscenePrefix = `${toRelative(getMidsceneRunRoot())}/`;

  if (rel.startsWith('playwright-report/')) {
    return `/reports/playwright/${rel.slice('playwright-report/'.length)}`;
  }
  if (rel.startsWith('test-results/')) {
    return `/reports/videos/${rel.slice('test-results/'.length)}`;
  }
  if (rel.startsWith(`${midscenePrefix}report/`)) {
    return `/reports/midscene/${rel.slice(`${midscenePrefix}report/`.length)}`;
  }
  if (rel.startsWith(`${midscenePrefix}plans/`)) {
    return `/reports/plans/${rel.slice(`${midscenePrefix}plans/`.length)}`;
  }

  return `/${rel}`;
}

export async function collectReportUrls(
  scenarioIdOrKey: string,
  opts?: CollectOptions,
): Promise<ReportUrls> {
  const links = await collectReportLinks(scenarioIdOrKey, opts);
  return {
    midsceneReports: links.midsceneReports.map(filePathToReportUrl),
    playwrightReport: links.playwrightReport ? filePathToReportUrl(links.playwrightReport) : null,
    videos: links.videos.map(filePathToReportUrl),
    plans: links.plans.map(filePathToReportUrl),
  };
}

function renderHtml(scenarioId: string, urls: ReportUrls, results: RunResults | null): string {
  const list = (items: string[], empty: string) =>
    items.length > 0
      ? `<ul>${items.map((item) => `<li><a href="${item}">${item}</a></li>`).join('')}</ul>`
      : `<p>${empty}</p>`;

  const videoBlock =
    urls.videos.length > 0
      ? urls.videos
          .map(
            (src) =>
              `<div class="video-wrap"><video controls preload="metadata" src="${src}"></video><p><a href="${src}">${src}</a></p></div>`,
          )
          .join('')
      : '<p>No videos recorded.</p>';

  return `<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8" />
  <title>Jules QA Report — ${scenarioId}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; }
    h1 { font-size: 1.5rem; }
    section { margin: 1.5rem 0; padding: 1rem; border: 1px solid #ddd; border-radius: 8px; }
    a { color: #0066cc; }
    .video-wrap { margin: 1rem 0; }
    video { max-width: 100%; border-radius: 8px; background: #000; }
    table { width: 100%; border-collapse: collapse; font-size: .9rem; }
    th, td { border: 1px solid #e0e0e0; padding: 6px 8px; text-align: left; vertical-align: top; }
    th { background: #f5f5f5; }
    code { background: #f0f0f0; padding: 1px 5px; border-radius: 4px; }
    .bug { border-left: 4px solid #b3261e; padding: .5rem .75rem; margin: .5rem 0; background: #fff4f3; }
  </style>
</head>
<body>
  <h1>Jules AI QA — Aggregate Report</h1>
  <p><strong>Scenario:</strong> ${scenarioId}</p>
  <p><strong>Generated:</strong> ${new Date().toISOString()}</p>

  <section>
    <h2>Evidence — Steps &amp; Assertions</h2>
    ${renderEvidence(results)}
  </section>

  <section>
    <h2>Midscene HTML Reports</h2>
    ${list(urls.midsceneReports, 'No Midscene reports found yet.')}
  </section>

  <section>
    <h2>Playwright Report</h2>
    ${
      urls.playwrightReport
        ? `<p><a href="${urls.playwrightReport}">Open Playwright report</a></p>`
        : '<p>No Playwright report found. Run tests first.</p>'
    }
  </section>

  <section>
    <h2>Test Videos</h2>
    ${videoBlock}
  </section>

  <section>
    <h2>Generated Plans</h2>
    ${list(urls.plans, 'No plan JSON saved.')}
  </section>
</body>
</html>`;
}

export async function aggregateReports(
  scenarioIdOrKey: string,
  opts?: CollectOptions,
): Promise<string> {
  const urls = await collectReportUrls(scenarioIdOrKey, opts);
  const results = await loadRunResults(scenarioIdOrKey);
  const outDir = path.join(getMidsceneRunRoot(), 'aggregate');
  await fs.mkdir(outDir, { recursive: true });

  // Ім'я звіту — той самий ключ, що й у cache/plans/results/generated.
  const key = scenarioKey(scenarioIdOrKey);
  const outPath = path.join(outDir, `${key}-index.html`);
  await fs.writeFile(outPath, renderHtml(key, urls, results), 'utf-8');

  console.log(`[report] Aggregate report: ${toRelative(outPath)}`);
  return outPath;
}

async function main(): Promise<void> {
  const scenarioId = process.argv[2] ?? 'invalid-password-registration';
  await aggregateReports(scenarioId);
}

const entryArg = process.argv[1]?.replace(/\\/g, '/');
if (entryArg?.endsWith('aggregate-report.ts')) {
  main().catch(console.error);
}
