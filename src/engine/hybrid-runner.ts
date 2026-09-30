import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { Stagehand } from '@browserbasehq/stagehand';
import type { Agent } from '@midscene/core/agent';
import { getEnv } from '../config/env.js';
import { installModelCallCounter, readProxyModelCalls, takeModelCallCount } from '../config/lmstudio-proxy.js';
import { parseAuthStep } from '../security/auth-profile.js';
import { getSecret } from '../security/vault.js';
import type { Checklist, ScenarioYaml } from '../planning/types.js';
import { parseStepMarker } from '../planning/types.js';
import { aiActWithSelfHeal, aiAssertWithSelfHeal } from './self-heal.js';
import { buildBugReport, classifyError, errorMessage, TARGET_UNAVAILABLE, writeBugReport } from './healer.js';
import { ResultsCollector, type HandledBy } from './results.js';
import { ensureSession } from './session.js';
import { runSecretTypeStep } from './secret-type.js';
import { detectBlocker, isNavigationStep } from './blocker-detect.js';
import { pauseForHuman } from './hitl.js';

export interface HybridRunContext {
  page: Page;
  agent: Agent;
  context?: BrowserContext;
  checklist: Checklist;
  scenario?: ScenarioYaml;
  runId?: string;
}

let stagehandInstance: Stagehand | null = null;

async function getStagehand(): Promise<Stagehand | null> {
  if (stagehandInstance) {
    return stagehandInstance;
  }

  const env = getEnv();
  const cacheDir = path.join(process.cwd(), '.stagehand-cache');

  try {
    const executablePath = await resolveChromeExecutable();
    const stagehand = new Stagehand({
      env: 'LOCAL',
      model: env.STAGEHAND_MODEL,
      cacheDir,
      verbose: 0,
      disablePino: true,
      localBrowserLaunchOptions: {
        headless: env.QA_HEADED !== 'true',
        ...(executablePath ? { executablePath } : {}),
      },
    });

    await stagehand.init();
    stagehandInstance = stagehand;
    return stagehand;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[stagehand] Hybrid layer unavailable, using Midscene only: ${message}`);
    return null;
  }
}

async function resolveChromeExecutable(): Promise<string | undefined> {
  if (process.env.CHROME_PATH) {
    return process.env.CHROME_PATH;
  }
  try {
    const { chromium } = await import('playwright-core');
    const execPath = chromium.executablePath();
    if (execPath) {
      process.env.CHROME_PATH = execPath;
      return execPath;
    }
  } catch {
    /* playwright-core not resolvable */
  }
  return undefined;
}

export async function closeStagehand(): Promise<void> {
  if (stagehandInstance) {
    await stagehandInstance.close().catch(() => undefined);
    stagehandInstance = null;
  }
}

/**
 * Заголовки сторінок-заглушок антибот-захисту (Cloudflare, DDoS-Guard).
 * Такий екран віддає або 403, або навіть 200 — але застосунку за ним немає.
 */
const BOT_WALL_TITLE = /just a moment|checking your browser|verify you are human|attention required|ddos-guard|один момент/i;

/**
 * Перехід із перевіркою того, що ми взагалі потрапили в застосунок.
 *
 * 5xx на документі або екран антибот-захисту означають, що тестувати нічого:
 * ціль недоступна. Краще впасти одразу з чесною причиною, ніж витратити
 * хвилини на пошук елементів на сторінці-заглушці — і потім показати в
 * реєстрі «регресію», якої не було.
 */
async function gotoChecked(page: Page, url: string): Promise<void> {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (!response) return;

  const status = response.status();
  if (status >= 500) {
    throw new Error(
      `${TARGET_UNAVAILABLE}: ${url} відповів HTTP ${status} — середовище недоступне, кейс не виконувався`,
    );
  }

  const title = await Promise.resolve()
    .then(() => page.title())
    .catch(() => '');
  if (BOT_WALL_TITLE.test(title)) {
    throw new Error(
      `${TARGET_UNAVAILABLE}: ${url} віддав HTTP ${status} і сторінку захисту від ботів («${title.trim()}») — ` +
        `кейс не виконувався. Потрібен доступ у браузері з довіреної мережі або обхід захисту на боці середовища.`,
    );
  }
}

export async function runDeterministicNavigation(
  page: Page,
  scenario?: ScenarioYaml,
  targetUrl?: string,
): Promise<void> {
  const nav = scenario?.navigation;
  // Закріплена ціль перекриває і `navigation.url`: інакше браузер ішов на
  // адресу зі сценарію, а у звіті стояла та, яку просили — і кеш писався
  // під ключем сторінки, якої прогін не бачив.
  const pinned = process.env.QA_TARGET_PINNED === '1';
  const url = (pinned ? targetUrl : nav?.url ?? targetUrl) ?? getEnv().QA_TARGET_URL;

  if (nav?.type === 'deterministic' || !nav) {
    await gotoChecked(page, url);
    return;
  }

  const stagehand = await getStagehand();
  if (stagehand && nav.instruction) {
    await stagehand.act(nav.instruction, { page });
    return;
  }

  await gotoChecked(page, url);
}

function isPurePageLoadWaitStep(step: string): boolean {
  const s = step.trim().toLowerCase();
  if (!/\bwait\b/.test(s)) return false;
  if (/\b(and|then|if |accept|dismiss|cookie|banner|scroll|click|navigate|search|results|content to appear)\b/.test(s)) {
    return false;
  }
  return /\b(page|load|loading)\b/.test(s);
}

async function runDeterministicWaitStep(page: Page, step: string): Promise<boolean> {
  if (!isPurePageLoadWaitStep(step)) return false;

  try {
    await page.waitForLoadState('networkidle', { timeout: 15_000 });
  } catch {
    await page.waitForLoadState('load').catch(() => undefined);
  }
  return true;
}

export async function runHybridAuthStep(
  page: Page,
  instruction: string,
): Promise<boolean> {
  const stagehand = await getStagehand();
  if (!stagehand) {
    return false;
  }

  try {
    await stagehand.act(instruction, { page });
    return true;
  } catch (error) {
    console.warn('[stagehand] Auth/navigation step fallback to Midscene:', error);
    return false;
  }
}

async function maybePauseForBlocker(page: Page, runId?: string): Promise<void> {
  const blocker = await detectBlocker(page);
  if (!blocker) return;

  const outcome = await pauseForHuman(runId ?? 'local', blocker.reason);
  if (outcome === 'timeout') {
    throw new Error(`Human-in-the-loop timeout: ${blocker.reason}`);
  }
}

async function executeStep(
  page: Page,
  agent: Agent,
  step: string,
  label: string,
  runId?: string,
): Promise<{ handledBy: HandledBy; attempts?: number; healed?: boolean }> {
  const { marker, instruction } = parseStepMarker(step);

  if (marker === 'human') {
    const outcome = await pauseForHuman(runId ?? 'local', instruction);
    if (outcome === 'timeout') {
      throw new Error(`Human-in-the-loop timeout: ${instruction}`);
    }
    return { handledBy: 'deterministic' };
  }

  if (marker === 'secret') {
    const parsed = parseAuthStep(instruction);
    if (parsed.secretRefs.length === 0) {
      throw new Error(`secret: step missing {{secret:profile.field}} reference: ${instruction}`);
    }
    const ref = parsed.secretRefs[0];
    const secretValue = await getSecret(ref.profileId, ref.field);
    await runSecretTypeStep({
      page,
      agent,
      instruction: parsed.instruction,
      secretValue,
      label,
    });
    return { handledBy: 'deterministic' };
  }

  const isAuthStep = /login|sign in|auth|log in|увійти|авториз/i.test(step);

  if (isAuthStep && (await runHybridAuthStep(page, step))) {
    console.log(`[hybrid] ${label} handled by Stagehand`);
    return { handledBy: 'stagehand' };
  }

  if (await runDeterministicWaitStep(page, step)) {
    console.log(`[hybrid] ${label} handled by Playwright wait`);
    return { handledBy: 'playwright' };
  }

  const outcome = await aiActWithSelfHeal(agent, step, {
    label,
    onRetry: (attempt, _err, cls) =>
      console.warn(`[self-heal] ${label} retry ${attempt} [${cls}]`),
  });

  return { handledBy: 'midscene', attempts: outcome.attempts, healed: outcome.healed };
}

/**
 * Скільки разів рушій звернувся до моделі з попереднього виміру.
 *
 * Основне джерело — лічильник проксі: він в іншому процесі, але бачить увесь
 * трафік. Локальний fetch-хук лишається запасним варіантом, коли проксі вимкнено.
 * Якщо не знає жодне джерело — повертаємо `undefined`, а не 0, щоб звіт не брехав.
 */
let lastRemoteModelCalls: number | null = null;

async function takeModelCalls(): Promise<number | undefined> {
  const remote = await readProxyModelCalls();
  if (remote !== null) {
    const previous = lastRemoteModelCalls ?? remote;
    lastRemoteModelCalls = remote;
    takeModelCallCount();
    const delta = remote - previous;
    return delta >= 0 ? delta : undefined;
  }
  const local = takeModelCallCount();
  return local > 0 ? local : undefined;
}

export async function executeChecklist(ctx: HybridRunContext): Promise<void> {
  const { page, agent, checklist, scenario, runId, context } = ctx;
  const collector = new ResultsCollector({
    scenarioId: checklist.scenarioId,
    goal: checklist.goal,
    targetUrl: checklist.targetUrl,
    mode: getEnv().QA_MODE,
  });

  // Лічильник викликів моделі рахується в цьому ж процесі, де крокує рушій.
  installModelCallCounter();
  takeModelCallCount();
  lastRemoteModelCalls = await readProxyModelCalls();

  let fatal: Error | null = null;
  let assertionFailure: Error | null = null;
  let assertSeq = 0;
  // Бухгалтерія «що вже записано» — щоб у `finally` дописати рівно те, до чого
  // прогін не дійшов, незалежно від того, де саме він урвався.
  const recordedSteps = new Set<number>();
  const recordedCheckpoints = new Set<number>();
  let recordedAssertions = 0;

  try {
    try {
      if (scenario?.auth?.profile) {
        if (!context) {
          throw new Error('Browser context is required for authenticated scenarios');
        }
        await ensureSession(scenario.auth.profile, { page, agent, context, runId });
      } else {
        await runDeterministicNavigation(page, scenario, checklist.targetUrl);
      }
    } catch (error) {
      // Падіння до першого кроку не належить жодному кроку — інакше причина
      // зникала, а прогін показував тільки «Test exited with code 1».
      collector.setFatalError(errorMessage(error));
      throw error;
    }

    for (const [index, step] of checklist.steps.entries()) {
      const stepNumber = index + 1;
      const label = `step-${stepNumber}`;
      const started = Date.now();
      let stepOk = false;

      try {
        const result = await executeStep(page, agent, step, label, runId);
        await recordStep(collector, index, step, result.handledBy, started, {
          attempts: result.attempts,
          healed: result.healed,
        });
        recordedSteps.add(index);
        stepOk = true;
      } catch (error) {
        const cls = classifyError(error);
        const blocker = await detectBlocker(page).catch(() => null);
        if (blocker) {
          try {
            await maybePauseForBlocker(page, runId);
            const retry = await executeStep(page, agent, step, label, runId);
            await recordStep(collector, index, step, retry.handledBy, started, {
              attempts: retry.attempts,
              healed: retry.healed,
            });
            recordedSteps.add(index);
            stepOk = true;
          } catch (retryError) {
            collector.record({
              index,
              kind: 'step',
              instruction: step,
              status: 'failed',
              attempts: 1,
              healed: false,
              handledBy: 'midscene',
              durationMs: Date.now() - started,
              modelCalls: await takeModelCalls(),
              error: errorMessage(retryError),
              errorClass: classifyError(retryError),
            });
            recordedSteps.add(index);
            fatal = retryError instanceof Error ? retryError : new Error(errorMessage(retryError));
          }
        } else {
          collector.record({
            index,
            kind: 'step',
            instruction: step,
            status: 'failed',
            attempts: 1,
            healed: false,
            handledBy: 'midscene',
            durationMs: Date.now() - started,
            modelCalls: await takeModelCalls(),
            error: errorMessage(error),
            errorClass: cls,
          });
          recordedSteps.add(index);
          fatal = error instanceof Error ? error : new Error(errorMessage(error));
        }
      }

      if (!stepOk) break;

      // Детекція блокерів лише після навігаційних кроків — після звичайного
      // кліку/вводу вона майже ніколи нічого не знаходить і коштує запитів.
      // Свідомо ПОЗА try кроку: таймаут HITL не має вдруге записати вже
      // зафіксований крок як failed (це ламало стабільність summary.total).
      if (isNavigationStep(step)) {
        await maybePauseForBlocker(page, runId);
      }

      for (const [cpIndex, checkpoint] of checklist.checkpoints.entries()) {
        if (checkpoint.afterStep !== stepNumber) continue;
        const passed = await evaluateAssertion(
          collector,
          agent,
          checklist.scenarioId,
          assertSeq++,
          checkpoint.assertion,
          `checkpoint-${stepNumber}`,
          stepNumber,
        );
        recordedCheckpoints.add(cpIndex);
        if (!passed) {
          assertionFailure = assertionFailure ?? new Error(`Checkpoint failed: ${checkpoint.assertion}`);
        }
      }
    }

    if (!fatal) {
      for (const [aIndex, assertion] of checklist.assertions.entries()) {
        const passed = await evaluateAssertion(
          collector,
          agent,
          checklist.scenarioId,
          assertSeq++,
          assertion,
          `assert-${aIndex + 1}`,
        );
        recordedAssertions = aIndex + 1;
        if (!passed) {
          assertionFailure = assertionFailure ?? new Error(`Assertion failed: ${assertion}`);
        }
      }
    }
  } finally {
    // Недосягнуті кроки/ассершени фіксуємо як 'skipped', інакше вони просто
    // зникали з результатів і `summary.total` стрибав від прогону до прогону.
    recordSkippedRemainder(collector, checklist, {
      recordedSteps,
      recordedCheckpoints,
      recordedAssertions,
      assertSeq,
    });
    await collector.write().catch((err) => console.warn('[results] write failed:', err));
  }

  const failure = fatal ?? assertionFailure;
  if (failure) {
    throw failure;
  }
}

async function evaluateAssertion(
  collector: ResultsCollector,
  agent: Agent,
  scenarioId: string,
  index: number,
  assertion: string,
  label: string,
  /** Для проміжних перевірок — номер кроку, після якого вона стоїть. */
  checkpointAfterStep?: number,
): Promise<boolean> {
  const started = Date.now();
  const outcome = await aiAssertWithSelfHeal(agent, assertion, {
    label,
    onRetry: (attempt, _err, cls) => console.warn(`[self-heal] ${label} retry ${attempt} [${cls}]`),
  });

  if (outcome.pass) {
    collector.record({
      index,
      kind: 'assertion',
      instruction: assertion,
      status: outcome.healed ? 'healed' : 'passed',
      attempts: outcome.attempts,
      healed: outcome.healed,
      handledBy: 'midscene',
      durationMs: Date.now() - started,
      modelCalls: await takeModelCalls(),
      thought: outcome.thought,
    });
    return true;
  }

  if (outcome.errorClass === 'assertion') {
    const report = buildBugReport({
      assertion,
      thought: outcome.thought,
      ...(checkpointAfterStep !== undefined ? { checkpointAfterStep } : {}),
    });
    report.reportPath = await writeBugReport(scenarioId, report).catch(() => undefined);
    collector.addBugReport(report);
    console.warn(`[bug] Assertion revealed an app defect: ${assertion}`);
  }

  collector.record({
    index,
    kind: 'assertion',
    instruction: assertion,
    status: 'failed',
    attempts: outcome.attempts,
    healed: false,
    handledBy: 'midscene',
    durationMs: Date.now() - started,
    modelCalls: await takeModelCalls(),
    error: outcome.error,
    errorClass: outcome.errorClass,
    thought: outcome.thought,
  });
  return false;
}

async function recordStep(
  collector: ResultsCollector,
  index: number,
  instruction: string,
  handledBy: HandledBy,
  startedAt: number,
  extra?: { attempts?: number; healed?: boolean },
): Promise<void> {
  collector.record({
    index,
    kind: 'step',
    instruction,
    status: extra?.healed ? 'healed' : 'passed',
    attempts: extra?.attempts ?? 1,
    healed: extra?.healed ?? false,
    handledBy,
    durationMs: Date.now() - startedAt,
    // Скільки викликів моделі знадобилось саме на цей крок. 0 у regression —
    // пряме підтвердження, що крок пройшов детерміновано, без LLM.
    modelCalls: await takeModelCalls(),
  });
}

interface SkippedBookkeeping {
  recordedSteps: Set<number>;
  recordedCheckpoints: Set<number>;
  recordedAssertions: number;
  assertSeq: number;
}

/**
 * Дописує `status='skipped'` для кроків, чекпойнтів та фінальних ассершенів, до
 * яких прогін не дійшов. Без цього після фатального падіння решта пунктів просто
 * зникала з результатів, і `summary.total` був різний у кожному прогоні —
 * порівнювати прогони між собою було неможливо.
 */
function recordSkippedRemainder(
  collector: ResultsCollector,
  checklist: Checklist,
  state: SkippedBookkeeping,
): void {
  let assertSeq = state.assertSeq;

  for (const [index, step] of checklist.steps.entries()) {
    if (state.recordedSteps.has(index)) continue;
    collector.record({
      index,
      kind: 'step',
      instruction: step,
      status: 'skipped',
      attempts: 0,
      healed: false,
      handledBy: 'deterministic',
      durationMs: 0,
      modelCalls: 0,
    });
  }

  for (const [index, checkpoint] of checklist.checkpoints.entries()) {
    if (state.recordedCheckpoints.has(index)) continue;
    collector.record({
      index: assertSeq++,
      kind: 'assertion',
      instruction: checkpoint.assertion,
      status: 'skipped',
      attempts: 0,
      healed: false,
      handledBy: 'deterministic',
      durationMs: 0,
      modelCalls: 0,
    });
  }

  for (const [index, assertion] of checklist.assertions.entries()) {
    if (index < state.recordedAssertions) continue;
    collector.record({
      index: assertSeq++,
      kind: 'assertion',
      instruction: assertion,
      status: 'skipped',
      attempts: 0,
      healed: false,
      handledBy: 'deterministic',
      durationMs: 0,
      modelCalls: 0,
    });
  }
}

/** Placeholder hooks — CAPTCHA/TOTP handled via human-in-the-loop. */
export const securityHooks = {
  async handleTotp(_code: string): Promise<void> {
    /* HITL only */
  },
  async handleCaptcha(): Promise<void> {
    /* HITL only */
  },
};
