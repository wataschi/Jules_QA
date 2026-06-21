import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { getEnv } from '../config/env.js';
import { getHitlControlDir } from '../server/data-paths.js';

export const HITL_PAUSED_PREFIX = '[hitl] PAUSED';
export const HITL_RESUMED_LOG = '[hitl] RESUMED';
export const HITL_TIMEOUT_LOG = '[hitl] TIMEOUT';

export type HitlOutcome = 'resumed' | 'timeout' | 'skipped';

interface HitlControlFile {
  resume: boolean;
  reason?: string;
  pausedAt?: string;
  resumedAt?: string;
}

function controlFilePath(runId: string): string {
  return path.join(getHitlControlDir(), `${runId}.json`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readControl(runId: string): Promise<HitlControlFile | null> {
  try {
    const raw = await fs.readFile(controlFilePath(runId), 'utf-8');
    return JSON.parse(raw) as HitlControlFile;
  } catch {
    return null;
  }
}

export async function initHitlControl(runId: string, reason: string): Promise<void> {
  const filePath = controlFilePath(runId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const control: HitlControlFile = {
    resume: false,
    reason,
    pausedAt: new Date().toISOString(),
  };
  await fs.writeFile(filePath, JSON.stringify(control, null, 2), 'utf-8');
}

export async function signalResume(runId: string): Promise<void> {
  const existing = (await readControl(runId)) ?? { resume: false };
  const control: HitlControlFile = {
    ...existing,
    resume: true,
    resumedAt: new Date().toISOString(),
  };
  await fs.writeFile(controlFilePath(runId), JSON.stringify(control, null, 2), 'utf-8');
}

function isInteractiveCli(): boolean {
  return process.stdin.isTTY === true && !process.env.CI;
}

async function waitForEnterKey(timeoutMs: number): Promise<boolean> {
  if (!isInteractiveCli()) return false;

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(false);
    }, timeoutMs);

    console.log('[hitl] Press Enter in this terminal to resume (or use dashboard Resume)…');
    rl.once('line', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      resolve(true);
    });
  });
}

/**
 * Blocks until the operator resumes via dashboard/CLI or timeout expires.
 * Emits sentinel logs for the test-runner to detect paused state.
 */
export async function pauseForHuman(runId: string, reason: string): Promise<HitlOutcome> {
  if (!runId || runId === 'local') {
    console.warn(`${HITL_PAUSED_PREFIX} ${reason} (no runId — skipping wait)`);
    return 'skipped';
  }

  console.log(`${HITL_PAUSED_PREFIX} ${reason}`);
  await initHitlControl(runId, reason);

  const timeoutMs = getEnv().QA_HITL_TIMEOUT_MS;
  const pollMs = 1000;
  const start = Date.now();

  const enterPromise = waitForEnterKey(timeoutMs);

  while (Date.now() - start < timeoutMs) {
    const control = await readControl(runId);
    if (control?.resume) {
      console.log(HITL_RESUMED_LOG);
      return 'resumed';
    }

    if (await enterPromise) {
      await signalResume(runId);
      console.log(HITL_RESUMED_LOG);
      return 'resumed';
    }

    await sleep(pollMs);
  }

  console.log(HITL_TIMEOUT_LOG);
  return 'timeout';
}

export function isHitlPausedLog(line: string): boolean {
  return line.includes(HITL_PAUSED_PREFIX);
}

export function extractHitlReason(line: string): string | undefined {
  const idx = line.indexOf(HITL_PAUSED_PREFIX);
  if (idx === -1) return undefined;
  return line.slice(idx + HITL_PAUSED_PREFIX.length).trim() || undefined;
}
