import type { Agent } from '@midscene/core/agent';
import { classifyError, errorMessage, isFatal, isHealable, type ErrorClass } from './healer.js';

const MAX_HEAL_ATTEMPTS = 3;
const MAX_ASSERT_ATTEMPTS = 2;
const DEFAULT_STEP_TIMEOUT_MS = 120_000;

type MidsceneAgent = Agent;

/** Per-step wall-clock budget; a single hung AI call can never stall the run. */
function stepTimeoutMs(): number {
  const raw = Number(process.env.QA_STEP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STEP_TIMEOUT_MS;
}

/**
 * Races a promise against a timeout. The underlying promise keeps a no-op
 * rejection handler so a late failure (after we already timed out) does not
 * surface as an unhandled rejection.
 */
async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Step timed out after ${ms}ms (no response from page/model): ${label}`)),
      ms,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface SelfHealOptions {
  label?: string;
  onRetry?: (attempt: number, error: unknown, cls: ErrorClass) => void;
}

export interface ActOutcome {
  attempts: number;
  healed: boolean;
}

export interface AssertOutcome {
  pass: boolean;
  attempts: number;
  healed: boolean;
  thought?: string;
  error?: string;
  errorClass?: ErrorClass;
}

/**
 * Executes an AI action with classification-aware self-healing. On a healable
 * failure (selector/timeout/model) it stabilizes the page and re-plans via the
 * vision model. Throws the classified error if all attempts are exhausted.
 */
export async function aiActWithSelfHeal(
  agent: MidsceneAgent,
  instruction: string,
  options: SelfHealOptions = {},
): Promise<ActOutcome> {
  const label = options.label ?? instruction.slice(0, 60);
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_HEAL_ATTEMPTS; attempt++) {
    try {
      await withTimeout(agent.aiAction(instruction), stepTimeoutMs(), label);
      return { attempts: attempt, healed: attempt > 1 };
    } catch (error) {
      lastError = error;
      const cls = classifyError(error);
      options.onRetry?.(attempt, error, cls);
      console.warn(
        `[self-heal] Step "${label}" failed [${cls}] (attempt ${attempt}/${MAX_HEAL_ATTEMPTS}): ${errorMessage(error)}`,
      );

      // Unrecoverable environment errors (deep-DOM stack overflow, destroyed
      // page/agent) will only recur on retry while consuming the run budget —
      // abort immediately so the failure is reported fast with evidence.
      if (isFatal(error)) {
        console.warn(`[self-heal] Step "${label}" hit a fatal/non-recoverable error — aborting retries`);
        break;
      }

      // Any other action error is potentially transient (locator drift, race,
      // model hiccup) — retry up to the limit; the next aiAction re-locates
      // against a fresh screenshot.
      if (attempt === MAX_HEAL_ATTEMPTS) {
        break;
      }

      // Stabilize before re-planning: re-locate happens implicitly on the next
      // aiAction against a fresh screenshot.
      await agent
        .aiWaitFor('page is stable and ready for interaction', { timeoutMs: 10_000 })
        .catch(() => undefined);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Self-heal exhausted for step: ${label}`);
}

/**
 * Evaluates an assertion and distinguishes an app defect (pass=false) from a
 * model/transport error. Uses `domIncluded` so weaker/text models can reason
 * over the accessibility tree, and `doNotThrowError` to obtain a structured
 * verdict instead of an exception. Never throws — returns a structured outcome.
 */
export async function aiAssertWithSelfHeal(
  agent: MidsceneAgent,
  assertion: string,
  options: SelfHealOptions = {},
): Promise<AssertOutcome> {
  const label = options.label ?? assertion.slice(0, 60);
  let lastError: unknown;
  let lastThought: string | undefined;

  for (let attempt = 1; attempt <= MAX_ASSERT_ATTEMPTS; attempt++) {
    try {
      const result = await withTimeout(
        agent.aiAssert(assertion, undefined, {
          domIncluded: true,
          // keepRawResponse is REQUIRED to receive the structured
          // { pass, thought, message } verdict. Without it aiAssert returns
          // undefined on a truthy assertion (and throws on a falsy one),
          // which made every passing assertion read as pass=false.
          keepRawResponse: true,
          doNotThrowError: true,
        }),
        stepTimeoutMs(),
        label,
      );

      const pass = result?.pass ?? false;
      lastThought = result?.thought ?? lastThought;

      if (pass) {
        return { pass: true, attempts: attempt, healed: attempt > 1, thought: lastThought };
      }

      // pass=false → likely an app defect. Re-evaluate once after waiting in case
      // the UI simply had not settled yet.
      if (attempt < MAX_ASSERT_ATTEMPTS) {
        options.onRetry?.(attempt, result?.thought ?? 'assertion not satisfied', 'assertion');
        await agent
          .aiWaitFor('page is stable and ready for interaction', { timeoutMs: 8_000 })
          .catch(() => undefined);
        continue;
      }

      return {
        pass: false,
        attempts: attempt,
        healed: false,
        thought: lastThought,
        errorClass: 'assertion',
      };
    } catch (error) {
      lastError = error;
      const cls = classifyError(error);
      options.onRetry?.(attempt, error, cls);
      console.warn(
        `[self-heal] Assertion "${label}" error [${cls}] (attempt ${attempt}/${MAX_ASSERT_ATTEMPTS}): ${errorMessage(error)}`,
      );

      if (attempt === MAX_ASSERT_ATTEMPTS || isFatal(error) || !isHealable(cls)) {
        return {
          pass: false,
          attempts: attempt,
          healed: false,
          thought: lastThought,
          error: errorMessage(error),
          errorClass: cls,
        };
      }
    }
  }

  return {
    pass: false,
    attempts: MAX_ASSERT_ATTEMPTS,
    healed: false,
    thought: lastThought,
    error: lastError ? errorMessage(lastError) : undefined,
    errorClass: lastError ? classifyError(lastError) : 'unknown',
  };
}

export async function flushCacheIfWarmUp(
  agent: MidsceneAgent,
  mode: string,
): Promise<void> {
  if (mode === 'warm-up' && typeof agent.flushCache === 'function') {
    await agent.flushCache();
    console.log('[cache] Warm-up complete — cache flushed to disk');
  }
}

export function logCacheMode(mode: string, cacheId: string): void {
  console.log(`[cache] Mode=${mode}, cacheId=${cacheId}`);
  if (!process.env.DEBUG) {
    console.log('[cache] Set DEBUG=midscene:cache:* for hit/miss diagnostics');
  }
}
