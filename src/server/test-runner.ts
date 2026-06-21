import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { aggregateReports, collectReportUrls } from '../reporting/aggregate-report.js';
import { bootstrapMidsceneEnv } from '../config/midscene-env.js';
import { loadScenarioYaml } from '../planning/scenario-planner.js';
import { loadRunResults } from '../engine/results.js';
import { transpileScenario } from '../codegen/transpile.js';
import { extractHitlReason, isHitlPausedLog, signalResume } from '../engine/hitl.js';
import { appendRunLog, getRun, patchRun, saveRun, updateRunStatus } from './runs-store.js';
import { applySettingsToProcessEnv, loadSettings } from './settings-store.js';
import { resolveScenarioPath } from './scenarios-store.js';
import { getSuite } from './suites-store.js';
import type { RunRecord, RunStatus, UiSettings } from './types.js';

dotenv.config();
bootstrapMidsceneEnv();

const activeProcesses = new Map<string, ReturnType<typeof spawn>>();
const pausedRuns = new Set<string>();
const queue: Array<{ runId: string; settings: UiSettings; resolve: (result: { exitCode: number; status: RunStatus }) => void }> = [];
let draining = false;

function scenarioNeedsHeaded(scenario: Awaited<ReturnType<typeof loadScenarioYaml>>): boolean {
  if (scenario.auth?.profile) return true;
  const humanPattern = /^\s*human:/i;
  return scenario.steps.some((s) => humanPattern.test(s));
}

async function buildPlaywrightEnv(
  runId: string,
  settings: UiSettings,
): Promise<Record<string, string | undefined>> {
  const base = {
    ...bootstrapMidsceneEnv(),
    QA_TARGET_URL: settings.qaTargetUrl,
    QA_MODE: settings.qaMode,
    QA_SCENARIO_PATH: settings.qaScenarioPath,
    QA_RUN_ID: runId,
    DEBUG: settings.debugCache ? 'midscene:cache:*' : '',
  };

  try {
    const scenario = await loadScenarioYaml(resolveScenarioPath(settings.qaScenarioPath));
    if (scenarioNeedsHeaded(scenario) || process.env.QA_HEADED === 'true') {
      return { ...base, QA_HEADED: 'true' };
    }
  } catch {
    /* fall through */
  }

  return base;
}

async function collectReportPaths(scenarioName: string): Promise<RunRecord['reportPaths']> {
  const root = process.cwd();
  const aggregate = path.join(root, 'midscene_run', 'aggregate', `${scenarioName}-index.html`);
  const reportPaths: NonNullable<RunRecord['reportPaths']> = {};

  try {
    await fs.access(aggregate);
    reportPaths.aggregate = `/reports/aggregate/${scenarioName}-index.html`;
  } catch { /* empty */ }

  const urls = await collectReportUrls(scenarioName);
  if (urls.playwrightReport) reportPaths.playwright = urls.playwrightReport;
  if (urls.midsceneReports.length) reportPaths.midscene = urls.midsceneReports;
  if (urls.videos.length) reportPaths.videos = urls.videos;
  if (urls.plans.length) reportPaths.plans = urls.plans;

  return reportPaths;
}

/**
 * Ingests structured evidence after a run: per-step results, bug reports, and —
 * for a successful warm-up — a freshly transpiled deterministic spec.
 */
async function applyEvidence(
  runId: string,
  scenarioName: string,
  mode: UiSettings['qaMode'],
  exitCode: number,
): Promise<void> {
  try {
    let generatedSpec: string | undefined;
    if (mode === 'warm-up' && exitCode === 0) {
      const transpiled = await transpileScenario(scenarioName).catch(() => null);
      if (transpiled) {
        generatedSpec = path.relative(process.cwd(), transpiled.specPath).replace(/\\/g, '/');
        await appendRunLog(
          runId,
          `[transpile] ${generatedSpec} — actions=${transpiled.actions}, locators ${transpiled.resolvedLocators}/${transpiled.resolvedLocators + transpiled.unresolvedLocators}`,
        );
      }
    }

    const results = await loadRunResults(scenarioName);
    if (!results && !generatedSpec) return;

    await patchRun(runId, (record) => {
      if (results) {
        record.stepResults = results.steps;
        record.evidence = {
          summary: results.summary,
          bugReports: results.bugReports.map((b) => ({
            id: b.id,
            assertion: b.assertion,
            severity: b.severity,
            thought: b.thought,
            rootCauseHypothesis: b.rootCauseHypothesis,
          })),
          generatedSpec: generatedSpec ?? results.generatedSpecPath,
        };
      } else if (generatedSpec) {
        record.evidence = { ...(record.evidence ?? {}), generatedSpec };
      }
    });

    if (results?.bugReports.length) {
      await appendRunLog(runId, `[bug] ${results.bugReports.length} bug report(s) generated`);
    }
  } catch (error) {
    await appendRunLog(runId, `[evidence] collect failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function runPlaywrightOnce(runId: string, settings: UiSettings): Promise<{ exitCode: number; status: RunStatus }> {
  return new Promise((resolve) => {
    void (async () => {
      await updateRunStatus(runId, { status: 'running' });
      await appendRunLog(runId, `[run] Starting ${settings.qaMode} → ${settings.qaTargetUrl}`);

      if (process.env.QA_TEST_MOCK_RUNNER === '1') {
        const mockExit = Number(process.env.QA_TEST_MOCK_EXIT_CODE ?? '0');
        const status: RunStatus = mockExit === 0 ? 'passed' : 'failed';
        let scenarioName = 'mock-scenario';
        try {
          const scenario = await loadScenarioYaml(resolveScenarioPath(settings.qaScenarioPath));
          scenarioName = scenario.name;
          if (mockExit === 0) await aggregateReports(scenario.name);
        } catch { /* empty */ }
        const reportPaths = await collectReportPaths(scenarioName);
        await appendRunLog(runId, '[mock] Playwright mock completed');
        await updateRunStatus(runId, {
          status,
          finishedAt: new Date().toISOString(),
          exitCode: mockExit,
          errorSummary: mockExit === 0 ? undefined : `Mock exit code ${mockExit}`,
          reportPaths,
          scenarioName,
        });
        await applyEvidence(runId, scenarioName, settings.qaMode, mockExit);
        resolve({ exitCode: mockExit, status });
        return;
      }

      const env = await buildPlaywrightEnv(runId, settings);

      const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
      const child = spawn(cmd, ['playwright', 'test', 'e2e/ai-scenario.spec.ts'], {
        cwd: process.cwd(),
        env: env as NodeJS.ProcessEnv,
        shell: process.platform === 'win32',
      });

      activeProcesses.set(runId, child);
      pausedRuns.delete(runId);

      const onData = (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          void appendRunLog(runId, line);
          if (isHitlPausedLog(line)) {
            pausedRuns.add(runId);
            const reason = extractHitlReason(line);
            void updateRunStatus(runId, {
              status: 'paused',
              hitlReason: reason,
              errorSummary: reason ? `Очікує оператора: ${reason}` : 'Очікує оператора',
            });
          }
        }
      };

      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);

      child.on('close', async (code) => {
        activeProcesses.delete(runId);
        pausedRuns.delete(runId);
        const exitCode = code ?? 1;
        const status: RunStatus = exitCode === 0 ? 'passed' : 'failed';

        let scenarioName = 'unknown';
        try {
          const scenario = await loadScenarioYaml(resolveScenarioPath(settings.qaScenarioPath));
          scenarioName = scenario.name;
          if (exitCode === 0) await aggregateReports(scenario.name);
        } catch { /* empty */ }

        const reportPaths = await collectReportPaths(scenarioName);
        await updateRunStatus(runId, {
          status,
          finishedAt: new Date().toISOString(),
          exitCode,
          errorSummary: exitCode === 0 ? undefined : `Test exited with code ${exitCode}`,
          reportPaths,
          scenarioName,
        });
        await applyEvidence(runId, scenarioName, settings.qaMode, exitCode);
        await appendRunLog(runId, `[run] Finished with code ${exitCode}`);
        resolve({ exitCode, status });
      });

      child.on('error', async (error) => {
        activeProcesses.delete(runId);
        await updateRunStatus(runId, {
          status: 'failed',
          finishedAt: new Date().toISOString(),
          errorSummary: error.message,
        });
        await appendRunLog(runId, `[run] Error: ${error.message}`);
        resolve({ exitCode: 1, status: 'failed' });
      });
    })();
  });
}

async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  while (queue.length > 0) {
    const job = queue.shift()!;
    const result = await runPlaywrightOnce(job.runId, job.settings);
    job.resolve(result);
  }
  draining = false;
}

function enqueueRun(runId: string, settings: UiSettings): Promise<{ exitCode: number; status: RunStatus }> {
  return new Promise((resolve) => {
    queue.push({ runId, settings, resolve });
    void drainQueue();
  });
}

async function buildSettings(overrides?: Partial<UiSettings>): Promise<UiSettings> {
  const settings = { ...(await loadSettings()), ...overrides };
  applySettingsToProcessEnv(settings);
  return settings;
}

export async function startTestRun(overrides?: Partial<UiSettings>): Promise<RunRecord> {
  const settings = await buildSettings(overrides);
  const scenario = await loadScenarioYaml(resolveScenarioPath(settings.qaScenarioPath));

  const run: RunRecord = {
    id: randomUUID(),
    status: 'queued',
    runType: 'single',
    qaTargetUrl: settings.qaTargetUrl,
    qaScenarioPath: settings.qaScenarioPath,
    qaMode: settings.qaMode,
    scenarioName: scenario.name,
    startedAt: new Date().toISOString(),
    logs: [],
  };

  await saveRun(run);
  void enqueueRun(run.id, settings);
  return run;
}

async function createSuiteStepRun(
  parentId: string,
  settings: UiSettings,
  stepIndex: number,
  totalSteps: number,
  suiteId: string,
): Promise<RunRecord> {
  const scenario = await loadScenarioYaml(resolveScenarioPath(settings.qaScenarioPath));
  const run: RunRecord = {
    id: randomUUID(),
    status: 'queued',
    runType: 'suite-step',
    parentRunId: parentId,
    suiteId,
    stepIndex,
    totalSteps,
    qaTargetUrl: settings.qaTargetUrl,
    qaScenarioPath: settings.qaScenarioPath,
    qaMode: settings.qaMode,
    scenarioName: scenario.name,
    startedAt: new Date().toISOString(),
    logs: [],
  };
  await saveRun(run);
  return run;
}

async function orchestrateSuite(parentId: string, suiteId: string, settings: UiSettings): Promise<void> {
  const suite = await getSuite(suiteId);
  if (!suite) {
    await updateRunStatus(parentId, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      errorSummary: `Suite ${suiteId} not found`,
    });
    return;
  }

  const parent = await getRun(parentId);
  const childIds = parent?.childRunIds ?? [];
  if (childIds.length !== suite.scenarioPaths.length) {
    await updateRunStatus(parentId, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      errorSummary: 'Suite step runs were not initialized',
    });
    return;
  }

  await updateRunStatus(parentId, { status: 'running' });
  await appendRunLog(parentId, `[suite] «${suite.name}» — ${suite.scenarioPaths.length} сценаріїв, stopOnFailure=${suite.stopOnFailure}`);

  let failed = false;

  for (let i = 0; i < suite.scenarioPaths.length; i++) {
    const childId = childIds[i];
    const stepSettings = { ...settings, qaScenarioPath: suite.scenarioPaths[i] };
    const child = await getRun(childId);
    const stepName = child?.scenarioName ?? suite.scenarioPaths[i];

    await appendRunLog(parentId, `[suite] Крок ${i + 1}/${suite.scenarioPaths.length}: ${stepName}`);
    const currentParent = await getRun(parentId);
    if (currentParent?.status === 'cancelled') break;

    const result = await enqueueRun(childId, stepSettings);
    await appendRunLog(parentId, `[suite] Крок ${i + 1} → ${result.status}`);

    if (result.status === 'failed') {
      failed = true;
      if (suite.stopOnFailure) {
        await appendRunLog(parentId, `[suite] Зупинено: stopOnFailure=true`);
        break;
      }
    }
  }

  const finishedParent = await getRun(parentId);
  if (finishedParent?.status === 'cancelled') return;

  const finalStatus: RunStatus = failed ? 'failed' : 'passed';
  await updateRunStatus(parentId, {
    status: finalStatus,
    finishedAt: new Date().toISOString(),
    exitCode: failed ? 1 : 0,
    errorSummary: failed ? 'One or more steps failed' : undefined,
  });
  await appendRunLog(parentId, `[suite] Завершено: ${finalStatus}`);
}

export async function startSuiteRun(suiteId: string, overrides?: Partial<UiSettings>): Promise<RunRecord> {
  const suite = await getSuite(suiteId);
  if (!suite) throw new Error(`Suite not found: ${suiteId}`);

  const settings = await buildSettings(overrides);
  const run: RunRecord = {
    id: randomUUID(),
    status: 'queued',
    runType: 'suite',
    suiteId,
    qaTargetUrl: settings.qaTargetUrl,
    qaScenarioPath: suite.scenarioPaths.join(', '),
    qaMode: settings.qaMode,
    scenarioName: suite.name,
    childRunIds: [],
    totalSteps: suite.scenarioPaths.length,
    stopOnFailure: suite.stopOnFailure,
    startedAt: new Date().toISOString(),
    logs: [],
  };

  await saveRun(run);

  const childIds: string[] = [];
  for (let i = 0; i < suite.scenarioPaths.length; i++) {
    const stepSettings = { ...settings, qaScenarioPath: suite.scenarioPaths[i] };
    const child = await createSuiteStepRun(run.id, stepSettings, i + 1, suite.scenarioPaths.length, suiteId);
    childIds.push(child.id);
  }
  await patchRun(run.id, (record) => {
    record.childRunIds = childIds;
  });
  run.childRunIds = childIds;

  void orchestrateSuite(run.id, suiteId, settings);
  return run;
}

export function cancelRun(runId: string): boolean {
  const child = activeProcesses.get(runId);
  if (child) {
    child.kill('SIGTERM');
    activeProcesses.delete(runId);
    void updateRunStatus(runId, {
      status: 'cancelled',
      finishedAt: new Date().toISOString(),
      errorSummary: 'Cancelled by user',
    });
    return true;
  }

  const run = getRun(runId);
  void run.then(async (record) => {
    if (!record || record.runType !== 'suite') return;
    await updateRunStatus(runId, {
      status: 'cancelled',
      finishedAt: new Date().toISOString(),
      errorSummary: 'Suite cancelled by user',
    });
    for (const childId of record.childRunIds ?? []) {
      cancelRun(childId);
    }
  });

  return true;
}

export function isRunActive(runId: string): boolean {
  return activeProcesses.has(runId);
}

export function isRunPaused(runId: string): boolean {
  return pausedRuns.has(runId);
}

export async function resumeRun(runId: string): Promise<boolean> {
  if (!activeProcesses.has(runId) && !pausedRuns.has(runId)) {
    const run = await getRun(runId);
    if (run?.status !== 'paused') return false;
  }

  await signalResume(runId);
  pausedRuns.delete(runId);
  await updateRunStatus(runId, {
    status: 'running',
    hitlReason: undefined,
    errorSummary: undefined,
  });
  await appendRunLog(runId, '[hitl] Resume signal sent by operator');
  return true;
}

export async function isRunOrChildActive(runId: string): Promise<boolean> {
  if (activeProcesses.has(runId)) return true;
  if (pausedRuns.has(runId)) return true;
  const run = await getRun(runId);
  if (run?.status === 'paused') return true;
  if (!run?.childRunIds?.length) return false;
  return run.childRunIds.some((id) => activeProcesses.has(id) || pausedRuns.has(id));
}
