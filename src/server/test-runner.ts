import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { aggregateReports, collectReportUrls } from '../reporting/aggregate-report.js';
import { bootstrapMidsceneEnv } from '../config/midscene-env.js';
import { scenarioKey } from '../config/env.js';
import {
  loadScenarioYaml,
  scenarioHasSecrets,
  scenarioNeedsHeaded,
} from '../planning/scenario-planner.js';
import { loadRunResults } from '../engine/results.js';
import { transpileScenario } from '../codegen/transpile.js';
import { extractHitlReason, isHitlPausedLog, signalResume } from '../engine/hitl.js';
import { loadAuthProfile, parseAuthStep } from '../security/auth-profile.js';
import { getSecret } from '../security/vault.js';
import { addSecretsForRedaction } from '../security/redact.js';
import { appendRunLog, getRun, patchRun, runExistsSync, saveRun, updateRunStatus } from './runs-store.js';
import { applySettingsToProcessEnv, loadSettings } from './settings-store.js';
import { resolveScenarioPath } from './scenarios-store.js';
import { getSuite } from './suites-store.js';
import { getMidsceneRunRoot } from './data-paths.js';
import type { RunRecord, RunStatus, UiSettings } from './types.js';

dotenv.config();
bootstrapMidsceneEnv();

const activeProcesses = new Map<string, ReturnType<typeof spawn>>();
const pausedRuns = new Set<string>();
/** Прогони, для яких оператор натиснув Cancel — щоб `close` не позначив їх failed. */
const cancelledRuns = new Set<string>();
interface QueueJob {
  runId: string;
  settings: UiSettings;
  /** Ціль, яку явно задав виклик: перекриває `target_url` сценарію. */
  pinnedTargetUrl?: string;
  resolve: (result: { exitCode: number; status: RunStatus }) => void;
}
const queue: QueueJob[] = [];
let draining = false;

type Scenario = Awaited<ReturnType<typeof loadScenarioYaml>>;

/**
 * Збирає значення секретів, що можуть зʼявитися в логах цього прогону, і реєструє
 * їх для маскування У СЕРВЕРНОМУ процесі.
 *
 * `registerSecretsForRedaction` викликався лише в дочірньому процесі Playwright,
 * тому в сервері реєстр завжди був порожній і `redactText` над логами прогону
 * не маскував нічого, крім статичних регексів. Vault-ключ у сервера є, тож
 * реєструємо тут, перед spawn. Якщо vault недоступний — тихо пропускаємо
 * (статичні регекси лишаються активними).
 */
async function registerScenarioSecrets(scenario: Scenario): Promise<number> {
  const refs: Array<{ profileId: string; field: string }> = [];

  const collect = (steps: string[]): void => {
    for (const step of steps) {
      refs.push(...parseAuthStep(step).secretRefs);
    }
  };

  collect(scenario.steps);

  if (scenario.auth?.profile) {
    try {
      const profile = await loadAuthProfile(scenario.auth.profile);
      collect(profile.steps);
    } catch {
      /* профіль недоступний — нічого не реєструємо */
    }
  }

  const values: string[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = `${ref.profileId}.${ref.field}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      values.push(await getSecret(ref.profileId, ref.field));
    } catch {
      /* vault недоступний або немає такого поля — тихо пропускаємо */
    }
  }

  if (values.length) addSecretsForRedaction(values);
  return values.length;
}

async function buildPlaywrightEnv(
  runId: string,
  settings: UiSettings,
  pinnedTargetUrl?: string,
): Promise<Record<string, string | undefined>> {
  const base: Record<string, string | undefined> = {
    ...bootstrapMidsceneEnv(),
    QA_TARGET_URL: pinnedTargetUrl ?? settings.qaTargetUrl,
    // Воркер має знати, що ціль закріплена: тоді він не підмінить її власною
    // `target_url` зі сценарію і напише артефакти під тим самим ключем.
    ...(pinnedTargetUrl ? { QA_TARGET_PINNED: '1' } : {}),
    QA_MODE: settings.qaMode,
    QA_SCENARIO_PATH: settings.qaScenarioPath,
    QA_RUN_ID: runId,
    DEBUG: settings.debugCache ? 'midscene:cache:*' : '',
  };

  try {
    const scenario = await loadScenarioYaml(resolveScenarioPath(settings.qaScenarioPath));
    if (scenarioHasSecrets(scenario)) {
      base.QA_TRACE = 'off';
      await appendRunLog(runId, '[secrets] QA_TRACE=off — трейс вимкнено, щоб пароль не потрапив у trace.zip');
      const registered = await registerScenarioSecrets(scenario);
      if (registered > 0) {
        await appendRunLog(runId, `[secrets] Зареєстровано ${registered} значень для маскування логів`);
      }
    }
    if (scenarioNeedsHeaded(scenario) || process.env.QA_HEADED === 'true') {
      base.QA_HEADED = 'true';
    }
  } catch {
    /* fall through */
  }

  return base;
}

async function collectReportPaths(
  artifactKey: string,
  opts?: { since?: string },
): Promise<RunRecord['reportPaths']> {
  // Каталог беремо з data-paths, а не з жорсткого `cwd/midscene_run`, інакше при
  // заданому MIDSCENE_RUN_ROOT посилання на агрегований звіт ніколи не знаходилось.
  const aggregate = path.join(getMidsceneRunRoot(), 'aggregate', `${artifactKey}-index.html`);
  const reportPaths: NonNullable<RunRecord['reportPaths']> = {};

  try {
    await fs.access(aggregate);
    reportPaths.aggregate = `/reports/aggregate/${artifactKey}-index.html`;
  } catch { /* empty */ }

  const urls = await collectReportUrls(artifactKey, { since: opts?.since });
  if (urls.playwrightReport) reportPaths.playwright = urls.playwrightReport;
  if (urls.midsceneReports.length) reportPaths.midscene = urls.midsceneReports;
  if (urls.videos.length) reportPaths.videos = urls.videos;
  if (urls.plans.length) reportPaths.plans = urls.plans;

  return reportPaths;
}

/**
 * Збирає звіт завжди — навіть (особливо!) коли прогін упав: раніше
 * `aggregateReports` викликався лише при коді 0, тож саме впалий прогін лишався
 * без доказів. Падіння збірки звіту не має валити прогін, тому try/catch.
 */
async function safeAggregate(runId: string, artifactKey: string, startedAt: string): Promise<void> {
  try {
    await aggregateReports(artifactKey, { since: startedAt });
  } catch (error) {
    await appendRunLog(
      runId,
      `[report] Збірка агрегованого звіту впала: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Ingests structured evidence after a run: per-step results, bug reports, and —
 * for a successful warm-up — a freshly transpiled deterministic spec.
 */
async function applyEvidence(
  runId: string,
  artifactKey: string,
  mode: UiSettings['qaMode'],
  exitCode: number,
  targetUrl?: string,
): Promise<void> {
  try {
    let generatedSpec: string | undefined;
    if (mode === 'warm-up' && exitCode === 0) {
      const transpiled = await transpileScenario(artifactKey, { targetUrl }).catch(() => null);
      if (transpiled) {
        generatedSpec = path.relative(process.cwd(), transpiled.specPath).replace(/\\/g, '/');
        await appendRunLog(
          runId,
          `[transpile] ${generatedSpec} — actions=${transpiled.actions}, locators ${transpiled.resolvedLocators}/${transpiled.resolvedLocators + transpiled.unresolvedLocators}`,
        );
      }
    }

    const results = await loadRunResults(artifactKey, targetUrl);
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
            confidence: b.confidence,
            checkpointAfterStep: b.checkpointAfterStep,
            contradictedBy: b.contradictedBy,
            reportPath: b.reportPath,
          })),
          generatedSpec: generatedSpec ?? results.generatedSpecPath,
        };
        // Причина фатального падіння важливіша за «Test exited with code N».
        if (exitCode !== 0 && results.fatalError) {
          record.errorSummary = results.fatalError;
        }
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

/** Назва сценарію + ключ артефактів (`<name>--<hash8(targetUrl)>`) для прогону. */
async function resolveArtifactIdentity(
  settings: UiSettings,
  pinnedTargetUrl?: string,
): Promise<{ scenarioName: string; artifactKey: string; targetUrl: string }> {
  try {
    const scenario = await loadScenarioYaml(resolveScenarioPath(settings.qaScenarioPath));
    const targetUrl = pinnedTargetUrl ?? scenario.target_url ?? settings.qaTargetUrl;
    return {
      scenarioName: scenario.name,
      artifactKey: scenarioKey(scenario.name, targetUrl),
      targetUrl,
    };
  } catch {
    return {
      scenarioName: 'unknown',
      artifactKey: scenarioKey('unknown', settings.qaTargetUrl),
      targetUrl: settings.qaTargetUrl,
    };
  }
}

function runPlaywrightOnce(
  runId: string,
  settings: UiSettings,
  pinnedTargetUrl?: string,
): Promise<{ exitCode: number; status: RunStatus }> {
  return new Promise((resolve) => {
    void (async () => {
      // `startedAt` перезаписуємо на момент реального старту: інакше тривалість
      // прогону включає очікування в черзі й виглядає у звіті в десятки разів більшою.
      const startedAt = new Date().toISOString();
      await updateRunStatus(runId, { status: 'running', startedAt });
      await appendRunLog(
        runId,
        `[run] Starting ${settings.qaMode} → ${pinnedTargetUrl ?? settings.qaTargetUrl}`,
      );

      if (process.env.QA_TEST_MOCK_RUNNER === '1') {
        const mockExit = Number(process.env.QA_TEST_MOCK_EXIT_CODE ?? '0');
        const status: RunStatus = mockExit === 0 ? 'passed' : 'failed';
        const identity = await resolveArtifactIdentity(settings, pinnedTargetUrl);
        // Звіт збираємо завжди, не лише при коді 0.
        await safeAggregate(runId, identity.artifactKey, startedAt);
        const reportPaths = await collectReportPaths(identity.artifactKey, { since: startedAt });
        await appendRunLog(runId, '[mock] Playwright mock completed');
        await updateRunStatus(runId, {
          status,
          finishedAt: new Date().toISOString(),
          exitCode: mockExit,
          errorSummary: mockExit === 0 ? undefined : `Mock exit code ${mockExit}`,
          reportPaths,
          scenarioName: identity.scenarioName,
        });
        await applyEvidence(runId, identity.artifactKey, settings.qaMode, mockExit, identity.targetUrl);
        resolve({ exitCode: mockExit, status });
        return;
      }

      const env = await buildPlaywrightEnv(runId, settings, pinnedTargetUrl);

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
        const cancelled = cancelledRuns.delete(runId);
        const status: RunStatus = cancelled ? 'cancelled' : exitCode === 0 ? 'passed' : 'failed';

        const identity = await resolveArtifactIdentity(settings, pinnedTargetUrl);
        // Звіт збираємо ЗАВЖДИ: саме впалий прогін найбільше потребує доказів.
        await safeAggregate(runId, identity.artifactKey, startedAt);

        const reportPaths = await collectReportPaths(identity.artifactKey, { since: startedAt });
        await updateRunStatus(runId, {
          status,
          finishedAt: new Date().toISOString(),
          exitCode,
          errorSummary: cancelled
            ? 'Cancelled by user'
            : exitCode === 0
              ? undefined
              : `Test exited with code ${exitCode}`,
          reportPaths,
          scenarioName: identity.scenarioName,
        });
        await applyEvidence(runId, identity.artifactKey, settings.qaMode, exitCode, identity.targetUrl);
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
    const result = await runPlaywrightOnce(job.runId, job.settings, job.pinnedTargetUrl);
    job.resolve(result);
  }
  draining = false;
}

function enqueueRun(
  runId: string,
  settings: UiSettings,
  pinnedTargetUrl?: string,
): Promise<{ exitCode: number; status: RunStatus }> {
  return new Promise((resolve) => {
    queue.push({ runId, settings, ...(pinnedTargetUrl ? { pinnedTargetUrl } : {}), resolve });
    void drainQueue();
  });
}

async function buildSettings(overrides?: Partial<UiSettings>): Promise<UiSettings> {
  const settings = { ...(await loadSettings()), ...overrides };
  applySettingsToProcessEnv(settings);
  return settings;
}

export interface StartRunOptions {
  /**
   * Чи закріплює переданий `qaTargetUrl` середовище. Закріплений URL перекриває
   * `target_url` сценарію; незакріплений лише підміняє глобальний дефолт.
   */
  pinTargetUrl?: boolean;
}

export async function startTestRun(
  overrides?: Partial<UiSettings>,
  options?: StartRunOptions,
): Promise<RunRecord> {
  const settings = await buildSettings(overrides);
  const scenario = await loadScenarioYaml(resolveScenarioPath(settings.qaScenarioPath));

  // Пріоритет цілі: явний URL виклику (env прогону реєстру, поле форми) →
  // ціль сценарію → збережений глобальний дефолт. Без першої ланки `env.baseUrl`
  // прогону реєстру не мав жодної сили, і прогнати той самий кейс на стейджі
  // було неможливо. Записуємо саме ту адресу, на яку реально підемо — інакше
  // у звіті стоїть URL, якого прогін не бачив.
  const pinnedTargetUrl = options?.pinTargetUrl ? overrides?.qaTargetUrl : undefined;
  const effectiveUrl = pinnedTargetUrl ?? scenario.target_url ?? settings.qaTargetUrl;
  // Витіснена адреса лишається у звіті: видно, що сценарій просив іншу ціль.
  const displacedUrl = [scenario.target_url, settings.qaTargetUrl].find(
    (candidate) => candidate && candidate !== effectiveUrl,
  );
  const queuedAt = new Date().toISOString();

  const run: RunRecord = {
    id: randomUUID(),
    status: 'queued',
    runType: 'single',
    qaTargetUrl: effectiveUrl,
    ...(displacedUrl ? { requestedTargetUrl: displacedUrl } : {}),
    qaScenarioPath: settings.qaScenarioPath,
    qaMode: settings.qaMode,
    scenarioName: scenario.name,
    queuedAt,
    startedAt: queuedAt,
    logs: [],
  };

  await saveRun(run);
  void enqueueRun(run.id, settings, pinnedTargetUrl);
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
    qaTargetUrl: scenario.target_url ?? settings.qaTargetUrl,
    ...(scenario.target_url && scenario.target_url !== settings.qaTargetUrl
      ? { requestedTargetUrl: settings.qaTargetUrl }
      : {}),
    qaScenarioPath: settings.qaScenarioPath,
    qaMode: settings.qaMode,
    scenarioName: scenario.name,
    queuedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    logs: [],
  };
  await saveRun(run);
  return run;
}

/** Позначає невиконані кроки набору як 'skipped' (замість вічного 'queued'). */
async function markSkippedSuiteSteps(
  parentId: string,
  childIds: string[],
  fromIndex: number,
): Promise<void> {
  for (let i = fromIndex; i < childIds.length; i++) {
    const child = await getRun(childIds[i]);
    if (!child || child.status !== 'queued') continue;
    await updateRunStatus(childIds[i], {
      status: 'skipped',
      finishedAt: new Date().toISOString(),
      errorSummary: 'Не запускався: набір зупинено раніше (stopOnFailure)',
    });
    await appendRunLog(childIds[i], '[suite] Крок пропущено — набір зупинено раніше');
    await appendRunLog(parentId, `[suite] Крок ${i + 1} → skipped`);
  }
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
  /** Індекс першого кроку, який так і не стартував (для позначки 'skipped'). */
  let notStartedFrom = suite.scenarioPaths.length;

  for (let i = 0; i < suite.scenarioPaths.length; i++) {
    const childId = childIds[i];
    const stepSettings = { ...settings, qaScenarioPath: suite.scenarioPaths[i] };
    const child = await getRun(childId);
    const stepName = child?.scenarioName ?? suite.scenarioPaths[i];

    await appendRunLog(parentId, `[suite] Крок ${i + 1}/${suite.scenarioPaths.length}: ${stepName}`);
    const currentParent = await getRun(parentId);
    if (currentParent?.status === 'cancelled') {
      notStartedFrom = i;
      break;
    }

    const result = await enqueueRun(childId, stepSettings);
    await appendRunLog(parentId, `[suite] Крок ${i + 1} → ${result.status}`);

    if (result.status === 'failed') {
      failed = true;
      if (suite.stopOnFailure) {
        await appendRunLog(parentId, `[suite] Зупинено: stopOnFailure=true`);
        notStartedFrom = i + 1;
        break;
      }
    }
  }

  // Кроки, які не запустилися, раніше назавжди лишалися 'queued' і виглядали як
  // «висять у черзі». Тепер це явний 'skipped'.
  await markSkippedSuiteSteps(parentId, childIds, notStartedFrom);

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

/**
 * Жорстко вбиває дерево процесів прогону.
 *
 * SIGTERM у `npx playwright test` на Windows не доходить до нащадків, тому
 * залишалися живі Chromium, які тримали профіль і порт. `taskkill /T /F`
 * прибирає все дерево.
 */
function killProcessTree(child: ReturnType<typeof spawn>): void {
  child.kill('SIGTERM');

  if (process.platform === 'win32' && typeof child.pid === 'number') {
    try {
      spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
        stdio: 'ignore',
        shell: false,
      }).on('error', () => undefined);
    } catch {
      /* taskkill недоступний — лишаємо SIGTERM */
    }
  }
}

/**
 * Скасування прогону. Раніше завжди повертало `true` і не прибирало завдання з
 * черги — прогін «скасовувався», а потім спокійно стартував.
 *
 * Тепер: невідомий ID → `false`; завдання в черзі → прибираємо з черги і
 * позначаємо `cancelled`; активний процес → SIGTERM (+ `taskkill /T /F` на
 * Windows). Функція лишається синхронною, бо роут у `server/index.ts` віддає її
 * результат напряму в JSON.
 */
export function cancelRun(runId: string): boolean {
  const child = activeProcesses.get(runId);
  if (child) {
    cancelledRuns.add(runId);
    killProcessTree(child);
    activeProcesses.delete(runId);
    pausedRuns.delete(runId);
    void updateRunStatus(runId, {
      status: 'cancelled',
      finishedAt: new Date().toISOString(),
      errorSummary: 'Cancelled by user',
    });
    return true;
  }

  // Завдання ще в черзі: прибираємо, щоб воно не стартувало, і закриваємо
  // обіцянку, інакше orchestrateSuite чекав би на неї назавжди.
  const queuedIndex = queue.findIndex((job) => job.runId === runId);
  if (queuedIndex >= 0) {
    const [job] = queue.splice(queuedIndex, 1);
    void updateRunStatus(runId, {
      status: 'cancelled',
      finishedAt: new Date().toISOString(),
      errorSummary: 'Cancelled before start',
    });
    job.resolve({ exitCode: 1, status: 'cancelled' });
    return true;
  }

  if (!runExistsSync(runId)) return false;

  void (async () => {
    const record = await getRun(runId);
    if (!record) return;
    // Завершений прогін не «перескасовуємо».
    if (!['queued', 'running', 'paused'].includes(record.status)) return;

    await updateRunStatus(runId, {
      status: 'cancelled',
      finishedAt: new Date().toISOString(),
      errorSummary: record.runType === 'suite' ? 'Suite cancelled by user' : 'Cancelled by user',
    });

    if (record.runType === 'suite') {
      for (const childId of record.childRunIds ?? []) {
        cancelRun(childId);
      }
    }
  })();

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
