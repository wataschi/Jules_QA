import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getBugReportsDir } from '../server/data-paths.js';
import type { BugReport } from './results.js';

/**
 * Error taxonomy for the auto-healer (Cortex-SDET pattern):
 *  - model     : LLM transport/availability problem (empty content, ECONNREFUSED)
 *  - selector  : element could not be located (UI changed) — healable
 *  - timeout   : action/wait timed out — usually healable with a retry
 *  - assertion : an expectation about the app was false — an APP BUG, not test bug
 *  - unknown   : anything else
 */
export type ErrorClass = 'model' | 'selector' | 'timeout' | 'assertion' | 'unknown';

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function classifyError(error: unknown): ErrorClass {
  const msg = errorMessage(error).toLowerCase();

  if (
    /empty content|failed to call ai model|ai model service|econnrefused|enotfound|fetch failed|socket hang up|model service|503|502|429|base64 encoded image/.test(
      msg,
    )
  ) {
    return 'model';
  }

  if (/assert|expected|should (be|have|contain)|to be visible|verification failed/.test(msg)) {
    return 'assertion';
  }

  if (
    /cannot find|could not find|not found|no element|unable to locate|locate.*fail|element is not|element not|no such element|cannot locate/.test(
      msg,
    )
  ) {
    return 'selector';
  }

  if (/timeout|timed out|exceeded|waiting for|deadline/.test(msg)) {
    return 'timeout';
  }

  return 'unknown';
}

/** Whether a failed action is worth retrying via relocation/wait. */
export function isHealable(cls: ErrorClass): boolean {
  return cls === 'selector' || cls === 'timeout' || cls === 'model';
}

/**
 * Unrecoverable environment errors: retrying only wastes the run budget (each
 * retry re-triggers the same crash plus navigation waits). Includes the deep-DOM
 * stack overflow in Midscene's extractor and a torn-down page/agent.
 */
export function isFatal(error: unknown): boolean {
  const msg = errorMessage(error).toLowerCase();
  return /maximum call stack|page agent has been destroyed|target closed|target page, context or browser has been closed|page closed|browser has been closed|session closed|execution context was destroyed/.test(
    msg,
  );
}

export function buildBugReport(input: {
  assertion: string;
  thought?: string;
  error?: string;
}): BugReport {
  const thought = input.thought ?? input.error;
  return {
    id: randomUUID(),
    assertion: input.assertion,
    thought,
    rootCauseHypothesis: hypothesize(input.assertion, thought),
    severity: severityFor(input.assertion),
    detectedAt: new Date().toISOString(),
  };
}

function hypothesize(assertion: string, thought?: string): string {
  const base = thought
    ? `Модель спостерігала: "${thought.trim()}". `
    : '';
  return (
    `${base}Очікуваний стан UI не підтверджено. Ймовірна причина: застосунок не відображає очікуваний результат ` +
    `для перевірки «${assertion.trim()}» (регресія функціоналу, помилка даних або зміна поведінки). ` +
    `Локатори елементів НЕ змінювалися автоматично — це класифіковано як дефект застосунку, а не тесту.`
  );
}

function severityFor(assertion: string): BugReport['severity'] {
  const s = assertion.toLowerCase();
  if (/error|500|crash|payment|оплат|втрач|security|загроз|critical|критич/.test(s)) return 'high';
  if (/login|auth|checkout|submit|save|увійти|оформ|збереж/.test(s)) return 'high';
  if (/visible|present|displayed|видим|відображ/.test(s)) return 'medium';
  return 'medium';
}

/** Persists a human-readable + machine-readable bug report; returns md path. */
export async function writeBugReport(scenarioId: string, report: BugReport): Promise<string> {
  const dir = path.join(getBugReportsDir(), scenarioId);
  await fs.mkdir(dir, { recursive: true });

  const jsonPath = path.join(dir, `${report.id}.json`);
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf-8');

  const mdPath = path.join(dir, `${report.id}.md`);
  const md = `# Bug Report — ${scenarioId}

- **ID:** ${report.id}
- **Severity:** ${report.severity}
- **Detected:** ${report.detectedAt}

## Failed assertion
${report.assertion}

## Model observation
${report.thought ?? '—'}

## Root-cause hypothesis
${report.rootCauseHypothesis}
`;
  await fs.writeFile(mdPath, md, 'utf-8');

  return mdPath;
}
