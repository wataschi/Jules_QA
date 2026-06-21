import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  aggregateReports,
  collectReportLinks,
  collectReportUrls,
  filePathToReportUrl,
} from '../../../src/reporting/aggregate-report.js';
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
    expect(outPath).toContain('agg-test-index.html');
    const html = await fs.readFile(outPath, 'utf-8');
    expect(html).toContain('Jules AI QA');
    expect(html).toContain('agg-test');
    expect(html).toContain('href="/reports/plans/agg-test.json"');
    expect(html).not.toContain('href="midscene_run/');
    expect(html).not.toContain('href="test-results/');
  });
});
