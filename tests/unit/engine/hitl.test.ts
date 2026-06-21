import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '../../../src/config/env.js';
import {
  HITL_PAUSED_PREFIX,
  HITL_RESUMED_LOG,
  extractHitlReason,
  initHitlControl,
  isHitlPausedLog,
  pauseForHuman,
  signalResume,
} from '../../../src/engine/hitl.js';
import {
  applyWorkspaceEnv,
  clearWorkspaceEnv,
  createTempWorkspace,
  type TempWorkspace,
} from '../../helpers/temp-workspace.js';

describe('hitl', () => {
  let ws: TempWorkspace;

  beforeEach(async () => {
    ws = await createTempWorkspace();
    applyWorkspaceEnv(ws);
    process.env.QA_HITL_TIMEOUT_MS = '3000';
    resetEnvCache();
  });

  afterEach(async () => {
    clearWorkspaceEnv();
    delete process.env.QA_HITL_TIMEOUT_MS;
    resetEnvCache();
    await ws.cleanup();
  });

  it('detects paused sentinel logs', () => {
    const line = `${HITL_PAUSED_PREFIX} CAPTCHA detected`;
    expect(isHitlPausedLog(line)).toBe(true);
    expect(extractHitlReason(line)).toBe('CAPTCHA detected');
  });

  it('resumes when signalResume is called', async () => {
    const runId = 'test-run-resume';
    const pausePromise = pauseForHuman(runId, 'test blocker');

    await new Promise((r) => setTimeout(r, 200));
    await signalResume(runId);

    const outcome = await pausePromise;
    expect(outcome).toBe('resumed');
  });

  it('writes control file on pause', async () => {
    const runId = 'test-run-control';
    const pausePromise = pauseForHuman(runId, 'waiting');
    await new Promise((r) => setTimeout(r, 100));

    const controlPath = path.join(ws.root, 'midscene_run', 'control', `${runId}.json`);
    const raw = await fs.readFile(controlPath, 'utf-8');
    const control = JSON.parse(raw) as { resume: boolean; reason?: string };
    expect(control.resume).toBe(false);
    expect(control.reason).toBe('waiting');

    await signalResume(runId);
    await pausePromise;
  });

  it('skips when runId is local', async () => {
    const outcome = await pauseForHuman('local', 'no wait');
    expect(outcome).toBe('skipped');
  });
});

describe('hitl log constants', () => {
  it('exports resume log marker', () => {
    expect(HITL_RESUMED_LOG).toContain('[hitl]');
  });
});
