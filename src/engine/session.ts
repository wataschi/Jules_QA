import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import type { Agent } from '@midscene/core/agent';
import {
  getProfileStorageStatePath,
  loadAuthProfile,
  parseAuthStep,
  type AuthProfile,
} from '../security/auth-profile.js';
import { getSecret } from '../security/vault.js';
import { aiActWithSelfHeal } from './self-heal.js';
import { runSecretTypeStep } from './secret-type.js';
import { detectBlocker } from './blocker-detect.js';
import { pauseForHuman } from './hitl.js';

export interface SessionContext {
  page: Page;
  agent: Agent;
  context: BrowserContext;
  runId?: string;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function isStorageStateFresh(statePath: string, ttlMinutes: number, mtimeMs?: number): boolean {
  if (!mtimeMs) return false;
  const ageMs = Date.now() - mtimeMs;
  return ageMs <= ttlMinutes * 60_000;
}

export async function getStorageStateMtime(statePath: string): Promise<number | undefined> {
  try {
    const stat = await fs.stat(statePath);
    return stat.mtimeMs;
  } catch {
    return undefined;
  }
}

export async function isStorageStateFileFresh(profile: AuthProfile): Promise<boolean> {
  const statePath = getProfileStorageStatePath(profile);
  const mtime = await getStorageStateMtime(statePath);
  if (!mtime) return false;
  return isStorageStateFresh(statePath, profile.sessionTtlMinutes, mtime);
}

async function runValidityCheck(
  profile: AuthProfile,
  ctx: SessionContext,
): Promise<boolean> {
  const check = profile.validityCheck;
  if (!check) return true;

  if (check.url) {
    await ctx.page.goto(check.url, { waitUntil: 'domcontentloaded' });
  }

  if (check.assertion) {
    try {
      await ctx.agent.aiAssert(check.assertion);
      return true;
    } catch {
      return false;
    }
  }

  return true;
}

async function runAuthStep(step: string, ctx: SessionContext): Promise<void> {
  const parsed = parseAuthStep(step);

  if (parsed.isHuman) {
    const outcome = await pauseForHuman(ctx.runId ?? 'local', parsed.instruction);
    if (outcome === 'timeout') {
      throw new Error(`Human-in-the-loop timeout: ${parsed.instruction}`);
    }
    return;
  }

  if (parsed.secretRefs.length > 0) {
    const ref = parsed.secretRefs[0];
    const secretValue = await getSecret(ref.profileId, ref.field);
    await runSecretTypeStep({
      page: ctx.page,
      agent: ctx.agent,
      instruction: parsed.instruction,
      secretValue,
      label: `auth-secret-${ref.field}`,
    });
    return;
  }

  await aiActWithSelfHeal(ctx.agent, parsed.instruction, {
    label: 'auth-step',
    onRetry: (attempt, _err, cls) =>
      console.warn(`[session] auth-step retry ${attempt} [${cls}]`),
  });
}

async function runLoginFlow(profile: AuthProfile, ctx: SessionContext): Promise<void> {
  await ctx.page.goto(profile.loginUrl, { waitUntil: 'domcontentloaded' });

  for (const step of profile.steps) {
    await runAuthStep(step, ctx);

    const blocker = await detectBlocker(ctx.page);
    if (blocker) {
      const outcome = await pauseForHuman(ctx.runId ?? 'local', blocker.reason);
      if (outcome === 'timeout') {
        throw new Error(`Human-in-the-loop timeout during login: ${blocker.reason}`);
      }
    }
  }
}

/**
 * Returns a valid storageState path — reuses cached session when fresh and valid,
 * otherwise runs the auth profile login flow and persists a new storageState.
 */
export async function ensureSession(
  profileId: string,
  ctx: SessionContext,
): Promise<string> {
  const profile = await loadAuthProfile(profileId);
  const statePath = getProfileStorageStatePath(profile);
  await fs.mkdir(path.dirname(statePath), { recursive: true });

  const hasState = await fileExists(statePath);
  const fresh = hasState && (await isStorageStateFileFresh(profile));

  if (fresh) {
    const valid = await runValidityCheck(profile, ctx);
    if (valid) {
      console.log(`[session] Reusing storageState for ${profileId}`);
      return statePath;
    }
    console.log(`[session] storageState expired or invalid for ${profileId}, re-authenticating`);
  }

  console.log(`[session] Running login flow for ${profileId}`);
  await runLoginFlow(profile, ctx);
  await ctx.context.storageState({ path: statePath });
  console.log(`[session] Saved storageState → ${statePath}`);
  return statePath;
}

/** Pre-test check: returns path only if file exists and TTL has not expired. */
export async function resolveStorageStateIfValid(profileId: string): Promise<string | undefined> {
  const profile = await loadAuthProfile(profileId);
  const statePath = getProfileStorageStatePath(profile);
  if (!(await fileExists(statePath))) return undefined;
  if (!(await isStorageStateFileFresh(profile))) return undefined;
  return statePath;
}
