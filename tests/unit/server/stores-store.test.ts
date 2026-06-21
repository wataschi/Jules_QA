import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getRun, listRuns, saveRun, updateRunStatus } from '../../../src/server/runs-store.js';
import { loadSettings, saveSettings } from '../../../src/server/settings-store.js';
import {
  deleteScenario,
  getScenarioByPath,
  listScenarioDetails,
  saveScenario,
} from '../../../src/server/scenarios-store.js';
import { deleteSuite, getSuite, listSuites, saveSuite } from '../../../src/server/suites-store.js';
import type { RunRecord } from '../../../src/server/types.js';
import {
  applyWorkspaceEnv,
  clearWorkspaceEnv,
  createTempWorkspace,
  type TempWorkspace,
  writeScenario,
} from '../../helpers/temp-workspace.js';

describe('runs-store', () => {
  let ws: TempWorkspace;

  beforeEach(async () => {
    ws = await createTempWorkspace();
    applyWorkspaceEnv(ws);
  });

  afterEach(async () => {
    clearWorkspaceEnv();
    await ws.cleanup();
  });

  it('saveRun and getRun round-trip', async () => {
    const run: RunRecord = {
      id: 'run-1',
      status: 'queued',
      runType: 'single',
      qaTargetUrl: 'https://example.com',
      qaScenarioPath: 'scenarios/test.yaml',
      qaMode: 'warm-up',
      startedAt: new Date().toISOString(),
      logs: ['line 1'],
    };
    await saveRun(run);
    const loaded = await getRun('run-1');
    expect(loaded?.logs).toEqual(['line 1']);
  });

  it('listRuns returns saved runs sorted by date', async () => {
    await saveRun({
      id: 'older',
      status: 'passed',
      runType: 'single',
      qaTargetUrl: 'https://example.com',
      qaScenarioPath: 'scenarios/a.yaml',
      qaMode: 'warm-up',
      startedAt: '2020-01-01T00:00:00.000Z',
      logs: [],
    });
    await saveRun({
      id: 'newer',
      status: 'passed',
      runType: 'single',
      qaTargetUrl: 'https://example.com',
      qaScenarioPath: 'scenarios/b.yaml',
      qaMode: 'warm-up',
      startedAt: '2025-01-01T00:00:00.000Z',
      logs: [],
    });
    const runs = await listRuns();
    expect(runs[0]?.id).toBe('newer');
  });

  it('updateRunStatus patches fields', async () => {
    await saveRun({
      id: 'patch-me',
      status: 'running',
      runType: 'single',
      qaTargetUrl: 'https://example.com',
      qaScenarioPath: 'scenarios/a.yaml',
      qaMode: 'warm-up',
      startedAt: new Date().toISOString(),
      logs: [],
    });
    await updateRunStatus('patch-me', { status: 'passed', exitCode: 0 });
    const run = await getRun('patch-me');
    expect(run?.status).toBe('passed');
    expect(run?.exitCode).toBe(0);
  });

  it('getRun retries while run file is being rewritten', async () => {
    const run: RunRecord = {
      id: 'run-race',
      status: 'running',
      runType: 'single',
      qaTargetUrl: 'https://example.com',
      qaScenarioPath: 'scenarios/test.yaml',
      qaMode: 'warm-up',
      startedAt: new Date().toISOString(),
      logs: ['line 1'],
    };
    await saveRun(run);

    const file = path.join(ws.dataDir, 'runs', 'run-race.json');
    await fs.writeFile(file, '{"id":"run-race","status":"running"', 'utf-8');

    const loadedPromise = getRun('run-race');
    await new Promise((r) => setTimeout(r, 40));
    await saveRun({ ...run, logs: ['line 1', 'line 2'] });

    const loaded = await loadedPromise;
    expect(loaded?.logs).toEqual(['line 1', 'line 2']);
  });
});

describe('settings-store', () => {
  let ws: TempWorkspace;

  beforeEach(async () => {
    ws = await createTempWorkspace();
    applyWorkspaceEnv(ws);
  });

  afterEach(async () => {
    clearWorkspaceEnv();
    await ws.cleanup();
  });

  it('saveSettings and loadSettings round-trip', async () => {
    await saveSettings({
      qaTargetUrl: 'https://example.com',
      qaMode: 'regression',
      qaScenarioPath: 'scenarios/universal-page-load.yaml',
      debugCache: true,
    });
    const loaded = await loadSettings();
    expect(loaded.qaMode).toBe('regression');
    expect(loaded.debugCache).toBe(true);
  });
});

describe('scenarios-store', () => {
  let ws: TempWorkspace;

  beforeEach(async () => {
    ws = await createTempWorkspace();
    applyWorkspaceEnv(ws);
  });

  afterEach(async () => {
    clearWorkspaceEnv();
    await ws.cleanup();
  });

  it('saveScenario creates yaml file', async () => {
    const saved = await saveScenario({
      name: 'store-test',
      goal: 'Store test goal',
      tags: [],
      hints: [],
      steps: ['step'],
      checkpoints: [],
      success_criteria: ['assert'],
    });
    expect(saved.path).toBe('scenarios/store-test.yaml');
    const list = await listScenarioDetails();
    expect(list.some((s) => s.name === 'store-test')).toBe(true);
  });

  it('getScenarioByPath reads scenario', async () => {
    await writeScenario(ws, 'read-me.yaml', {
      name: 'read-me',
      goal: 'Read me',
      steps: [],
      success_criteria: [],
    });
    const scenario = await getScenarioByPath('scenarios/read-me.yaml');
    expect(scenario.name).toBe('read-me');
    expect(scenario.raw).toContain('read-me');
  });

  it('deleteScenario removes file', async () => {
    await writeScenario(ws, 'delete-me.yaml', {
      name: 'delete-me',
      goal: 'Delete',
      steps: [],
      success_criteria: [],
    });
    await deleteScenario('scenarios/delete-me.yaml');
    await expect(getScenarioByPath('scenarios/delete-me.yaml')).rejects.toThrow();
  });
});

describe('suites-store', () => {
  let ws: TempWorkspace;

  beforeEach(async () => {
    ws = await createTempWorkspace();
    applyWorkspaceEnv(ws);
  });

  afterEach(async () => {
    clearWorkspaceEnv();
    await ws.cleanup();
  });

  it('saveSuite and getSuite round-trip', async () => {
    const suite = await saveSuite({
      name: 'Test Suite',
      description: 'Desc',
      scenarioPaths: ['scenarios/a.yaml'],
      stopOnFailure: false,
    });
    const loaded = await getSuite(suite.id);
    expect(loaded?.stopOnFailure).toBe(false);
    expect(loaded?.scenarioPaths).toEqual(['scenarios/a.yaml']);
  });

  it('listSuites returns saved suites', async () => {
    await saveSuite({
      id: 'suite-a',
      name: 'Suite A',
      description: '',
      scenarioPaths: ['scenarios/a.yaml'],
      stopOnFailure: true,
    });
    const suites = await listSuites();
    expect(suites.some((s) => s.id === 'suite-a')).toBe(true);
  });

  it('deleteSuite removes suite', async () => {
    const suite = await saveSuite({
      id: 'del-suite',
      name: 'Delete Suite',
      description: '',
      scenarioPaths: ['scenarios/a.yaml'],
      stopOnFailure: true,
    });
    await deleteSuite(suite.id);
    expect(await getSuite(suite.id)).toBeNull();
  });
});
