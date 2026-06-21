import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { Stagehand } from '@browserbasehq/stagehand';
import type { Agent } from '@midscene/core/agent';
import { getEnv } from '../config/env.js';
import { parseAuthStep } from '../security/auth-profile.js';
import { getSecret } from '../security/vault.js';
import type { Checklist, ScenarioYaml } from '../planning/types.js';
import { parseStepMarker } from '../planning/types.js';
import { aiActWithSelfHeal, aiAssertWithSelfHeal } from './self-heal.js';
import { buildBugReport, classifyError, errorMessage, writeBugReport } from './healer.js';
import { ResultsCollector, type HandledBy } from './results.js';
import { ensureSession } from './session.js';
import { runSecretTypeStep } from './secret-type.js';
import { detectBlocker } from './blocker-detect.js';
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

export async function runDeterministicNavigation(
  page: Page,
  scenario?: ScenarioYaml,
  targetUrl?: string,
): Promise<void> {
  const nav = scenario?.navigation;
  const url = nav?.url ?? targetUrl ?? getEnv().QA_TARGET_URL;

  if (nav?.type === 'deterministic' || !nav) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return;
  }

  const stagehand = await getStagehand();
  if (stagehand && nav.instruction) {
    await stagehand.act(nav.instruction, { page });
    return;
  }

  await page.goto(url, { waitUntil: 'domcontentloaded' });
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

export async function executeChecklist(ctx: HybridRunContext): Promise<void> {
  const { page, agent, checklist, scenario, runId, context } = ctx;
  const collector = new ResultsCollector({
    scenarioId: checklist.scenarioId,
    goal: checklist.goal,
    targetUrl: checklist.targetUrl,
    mode: getEnv().QA_MODE,
  });

  let fatal: Error | null = null;
  let assertionFailure: Error | null = null;
  let assertSeq = 0;

  try {
    if (scenario?.auth?.profile) {
      if (!context) {
        throw new Error('Browser context is required for authenticated scenarios');
      }
      await ensureSession(scenario.auth.profile, { page, agent, context, runId });
    } else {
      await runDeterministicNavigation(page, scenario, checklist.targetUrl);
    }

    for (const [index, step] of checklist.steps.entries()) {
      const stepNumber = index + 1;
      const label = `step-${stepNumber}`;
      const started = Date.now();

      try {
        const result = await executeStep(page, agent, step, label, runId);
        recordStep(collector, index, step, result.handledBy, started, {
          attempts: result.attempts,
          healed: result.healed,
        });
        await maybePauseForBlocker(page, runId);
      } catch (error) {
        const cls = classifyError(error);
        const blocker = await detectBlocker(page).catch(() => null);
        if (blocker) {
          try {
            await maybePauseForBlocker(page, runId);
            const retry = await executeStep(page, agent, step, label, runId);
            recordStep(collector, index, step, retry.handledBy, started, {
              attempts: retry.attempts,
              healed: retry.healed,
            });
            continue;
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
              error: errorMessage(retryError),
              errorClass: classifyError(retryError),
            });
            fatal = retryError instanceof Error ? retryError : new Error(errorMessage(retryError));
            break;
          }
        }

        collector.record({
          index,
          kind: 'step',
          instruction: step,
          status: 'failed',
          attempts: 1,
          healed: false,
          handledBy: 'midscene',
          durationMs: Date.now() - started,
          error: errorMessage(error),
          errorClass: cls,
        });
        fatal = error instanceof Error ? error : new Error(errorMessage(error));
        break;
      }

      for (const checkpoint of checklist.checkpoints.filter((c) => c.afterStep === stepNumber)) {
        const passed = await evaluateAssertion(
          collector,
          agent,
          checklist.scenarioId,
          assertSeq++,
          checkpoint.assertion,
          `checkpoint-${stepNumber}`,
        );
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
        if (!passed) {
          assertionFailure = assertionFailure ?? new Error(`Assertion failed: ${assertion}`);
        }
      }
    }
  } finally {
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
      thought: outcome.thought,
    });
    return true;
  }

  if (outcome.errorClass === 'assertion') {
    const report = buildBugReport({ assertion, thought: outcome.thought });
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
    error: outcome.error,
    errorClass: outcome.errorClass,
    thought: outcome.thought,
  });
  return false;
}

function recordStep(
  collector: ResultsCollector,
  index: number,
  instruction: string,
  handledBy: HandledBy,
  startedAt: number,
  extra?: { attempts?: number; healed?: boolean },
): void {
  collector.record({
    index,
    kind: 'step',
    instruction,
    status: extra?.healed ? 'healed' : 'passed',
    attempts: extra?.attempts ?? 1,
    healed: extra?.healed ?? false,
    handledBy,
    durationMs: Date.now() - startedAt,
  });
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
