import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '../../../src/config/env.js';
import { addSecretsForRedaction, clearRegisteredSecrets } from '../../../src/security/redact.js';
import { appendRunLog, getRun, saveRun } from '../../../src/server/runs-store.js';
import { saveSuite } from '../../../src/server/suites-store.js';
import { cancelRun, startSuiteRun } from '../../../src/server/test-runner.js';
import { runStatusSchema, type RunRecord } from '../../../src/server/types.js';
import {
  applyWorkspaceEnv,
  clearWorkspaceEnv,
  createTempWorkspace,
  type TempWorkspace,
  writeScenario,
} from '../../helpers/temp-workspace.js';

function queuedRun(id: string): RunRecord {
  return {
    id,
    status: 'queued',
    runType: 'single',
    qaTargetUrl: 'https://example.com',
    qaScenarioPath: 'scenarios/runner-test.yaml',
    qaMode: 'warm-up',
    startedAt: new Date().toISOString(),
    logs: [],
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('waitFor timed out');
}

describe('run log redaction in the server process', () => {
  let ws: TempWorkspace;

  beforeEach(async () => {
    ws = await createTempWorkspace();
    applyWorkspaceEnv(ws);
    clearRegisteredSecrets();
  });

  afterEach(async () => {
    clearRegisteredSecrets();
    clearWorkspaceEnv();
    await ws.cleanup();
  });

  it('masks a registered secret value in the run log', async () => {
    await saveRun(queuedRun('redact-run'));

    // Це те, що тепер робить сервер перед spawn: реєструє значення секретів
    // профілю автентифікації сценарію у ВЛАСНОМУ процесі.
    addSecretsForRedaction(['pa55word-from-vault']);
    await appendRunLog('redact-run', 'typing pa55word-from-vault into the password field');

    const run = await getRun('redact-run');
    expect(run?.logs.join('\n')).not.toContain('pa55word-from-vault');
    expect(run?.logs.join('\n')).toContain('[REDACTED]');
  });

  it('keeps previously registered secrets when a later run registers its own', async () => {
    await saveRun(queuedRun('redact-run-2'));

    addSecretsForRedaction(['first-secret-value']);
    addSecretsForRedaction(['second-secret-value']);
    await appendRunLog('redact-run-2', 'first-secret-value and second-secret-value');

    const run = await getRun('redact-run-2');
    const logs = run?.logs.join('\n') ?? '';
    expect(logs).not.toContain('first-secret-value');
    expect(logs).not.toContain('second-secret-value');
  });
});

describe('cancelRun', () => {
  let ws: TempWorkspace;

  beforeEach(async () => {
    ws = await createTempWorkspace();
    applyWorkspaceEnv(ws);
    resetEnvCache();
  });

  afterEach(async () => {
    clearWorkspaceEnv();
    resetEnvCache();
    await ws.cleanup();
  });

  it('returns false for an unknown run id', () => {
    expect(cancelRun('00000000-0000-0000-0000-000000000000')).toBe(false);
  });

  it('cancels a run that is still waiting and marks it cancelled', async () => {
    await saveRun(queuedRun('cancel-queued'));

    expect(cancelRun('cancel-queued')).toBe(true);
    await waitFor(async () => (await getRun('cancel-queued'))?.status === 'cancelled');

    const run = await getRun('cancel-queued');
    expect(run?.status).toBe('cancelled');
    expect(run?.finishedAt).toBeTruthy();
  });

  it('does not re-cancel an already finished run', async () => {
    await saveRun({ ...queuedRun('cancel-finished'), status: 'passed', exitCode: 0 });

    cancelRun('cancel-finished');
    await new Promise((r) => setTimeout(r, 100));
    expect((await getRun('cancel-finished'))?.status).toBe('passed');
  });
});

describe('suite orchestration', () => {
  let ws: TempWorkspace;

  beforeEach(async () => {
    ws = await createTempWorkspace();
    applyWorkspaceEnv(ws);
    process.env.QA_TEST_MOCK_EXIT_CODE = '1';
    resetEnvCache();

    await writeScenario(ws, 'suite-a.yaml', {
      name: 'suite-a',
      goal: 'A',
      steps: ['A'],
      success_criteria: ['A ok'],
    });
    await writeScenario(ws, 'suite-b.yaml', {
      name: 'suite-b',
      goal: 'B',
      steps: ['B'],
      success_criteria: ['B ok'],
    });
    await writeScenario(ws, 'suite-c.yaml', {
      name: 'suite-c',
      goal: 'C',
      steps: ['C'],
      success_criteria: ['C ok'],
    });
  });

  afterEach(async () => {
    delete process.env.QA_TEST_MOCK_EXIT_CODE;
    clearWorkspaceEnv();
    resetEnvCache();
    await ws.cleanup();
  });

  it("marks children that never ran as 'skipped', not 'queued' forever", async () => {
    const suite = await saveSuite({
      id: 'suite-skip',
      name: 'Skip suite',
      description: '',
      scenarioPaths: ['scenarios/suite-a.yaml', 'scenarios/suite-b.yaml', 'scenarios/suite-c.yaml'],
      stopOnFailure: true,
    });

    const parent = await startSuiteRun(suite.id, {
      qaTargetUrl: 'https://example.com',
      qaMode: 'warm-up',
      qaScenarioPath: 'scenarios/suite-a.yaml',
      debugCache: false,
    });

    await waitFor(async () => {
      const run = await getRun(parent.id);
      return run?.status === 'failed' || run?.status === 'passed';
    });

    const childIds = (await getRun(parent.id))?.childRunIds ?? [];
    expect(childIds).toHaveLength(3);

    const statuses = await Promise.all(childIds.map(async (id) => (await getRun(id))?.status));
    expect(statuses[0]).toBe('failed');
    expect(statuses.slice(1)).toEqual(['skipped', 'skipped']);
    expect(statuses).not.toContain('queued');
  });
});

describe('runStatusSchema', () => {
  it("accepts 'skipped'", () => {
    expect(runStatusSchema.parse('skipped')).toBe('skipped');
  });
});
