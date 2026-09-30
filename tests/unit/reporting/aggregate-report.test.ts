import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  aggregateReports,
  collectReportLinks,
  collectReportUrls,
  filePathToReportUrl,
} from '../../../src/reporting/aggregate-report.js';
import { scenarioKey } from '../../../src/config/env.js';
import { createTempWorkspace, type TempWorkspace } from '../../helpers/temp-workspace.js';

describe('aggregate-report', () => {
  let ws: TempWorkspace;
  const originalMidsceneRoot = process.env.MIDSCENE_RUN_ROOT;

  beforeEach(async () => {
    ws = await createTempWorkspace();
    process.env.MIDSCENE_RUN_ROOT = ws.midsceneDir;
  });

  afterEach(async () => {
    if (originalMidsceneRoot === undefined) delete process.env.MIDSCENE_RUN_ROOT;
    else process.env.MIDSCENE_RUN_ROOT = originalMidsceneRoot;
    await ws.cleanup();
  });

  it('collectReportLinks finds plan file', async () => {
    const planPath = path.join(ws.midsceneDir, 'plans', 'test-scenario.json');
    await fs.writeFile(planPath, '{}', 'utf-8');

    const links = await collectReportLinks('test-scenario');
    expect(links.plans).toHaveLength(1);
    expect(links.plans[0]).toContain('test-scenario.json');
  });

  it('filePathToReportUrl maps filesystem paths to served URLs', () => {
    expect(filePathToReportUrl(path.join(process.cwd(), 'playwright-report', 'index.html'))).toBe(
      '/reports/playwright/index.html',
    );
    expect(
      filePathToReportUrl(path.join(process.cwd(), 'test-results', 'run-1', 'video.webm')),
    ).toBe('/reports/videos/run-1/video.webm');
    expect(filePathToReportUrl(path.join(ws.midsceneDir, 'plans', 'x.json'))).toBe('/reports/plans/x.json');
  });

  it('collectReportLinks with `since` keeps only artifacts from this run', async () => {
    const reportDir = path.join(ws.midsceneDir, 'report');
    await fs.mkdir(reportDir, { recursive: true });

    const oldReport = path.join(reportDir, 'old-report.html');
    await fs.writeFile(oldReport, '<html></html>', 'utf-8');
    // Штучно «старимо» файл на годину — він належить попередньому прогону.
    const hourAgo = new Date(Date.now() - 3_600_000);
    await fs.utimes(oldReport, hourAgo, hourAgo);

    const runStart = new Date().toISOString();
    const freshReport = path.join(reportDir, 'fresh-report.html');
    await fs.writeFile(freshReport, '<html></html>', 'utf-8');

    const all = await collectReportLinks('since-test');
    expect(all.midsceneReports).toHaveLength(2);

    const scoped = await collectReportLinks('since-test', { since: runStart });
    expect(scoped.midsceneReports).toHaveLength(1);
    expect(scoped.midsceneReports[0]).toContain('fresh-report.html');
  });

  it('collectReportUrls returns server URLs', async () => {
    const planPath = path.join(ws.midsceneDir, 'plans', 'agg-test.json');
    await fs.writeFile(planPath, '{"scenarioId":"agg-test"}', 'utf-8');

    const urls = await collectReportUrls('agg-test');
    expect(urls.plans).toEqual(['/reports/plans/agg-test.json']);
  });

  it('aggregateReports generates HTML index with correct links', async () => {
    const planPath = path.join(ws.midsceneDir, 'plans', 'agg-test.json');
    await fs.writeFile(planPath, '{"scenarioId":"agg-test"}', 'utf-8');

    const outPath = await aggregateReports('agg-test');
    // Ім'я звіту тепер містить хеш цілі (scenarioKey), а план читається з
    // fallback на стару назву без хеша.
    expect(path.basename(outPath)).toBe(`${scenarioKey('agg-test')}-index.html`);
    const html = await fs.readFile(outPath, 'utf-8');
    expect(html).toContain('Jules AI QA');
    expect(html).toContain('agg-test');
    expect(html).toContain(scenarioKey('agg-test'));
    expect(html).toContain('href="/reports/plans/agg-test.json"');
    expect(html).not.toContain('href="midscene_run/');
    expect(html).not.toContain('href="test-results/');
  });
});
