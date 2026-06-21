import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnvCache } from '../../../src/config/env.js';
import {
  loadChecklist,
  loadScenarioYaml,
  planScenario,
  prepareChecklist,
  saveChecklist,
} from '../../../src/planning/scenario-planner.js';
import type { Checklist } from '../../../src/planning/types.js';
import { clearWorkspaceEnv, createTempWorkspace, type TempWorkspace, writeScenario } from '../../helpers/temp-workspace.js';

describe('scenario-planner', () => {
  let ws: TempWorkspace;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    ws = await createTempWorkspace();
    resetEnvCache();
    process.env.MIDSCENE_RUN_ROOT = ws.midsceneDir;
    process.env.QA_TARGET_URL = 'https://example.com';
    process.env.QA_MODE = 'warm-up';
    delete process.env.PLANNER_MODEL_BASE_URL;
    delete process.env.PLANNER_MODEL_NAME;
    delete process.env.CRITIC_MODEL_BASE_URL;
    delete process.env.MIDSCENE_MODEL_BASE_URL;
    delete process.env.MIDSCENE_OPENAI_BASE_URL;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    Object.assign(process.env, originalEnv);
    clearWorkspaceEnv();
    await ws.cleanup();
  });

  it('loadScenarioYaml parses yaml file', async () => {
    await writeScenario(ws, 'sample.yaml', {
      name: 'sample-scenario',
      goal: 'Sample goal',
      steps: ['Do something'],
      success_criteria: ['Verify something'],
    });
    const full = path.join(ws.scenariosDir, 'sample.yaml');
    const scenario = await loadScenarioYaml(full);
    expect(scenario.name).toBe('sample-scenario');
    expect(scenario.steps).toHaveLength(1);
  });

  it('saveChecklist and loadChecklist round-trip', async () => {
    const checklist: Checklist = {
      scenarioId: 'round-trip',
      goal: 'Test',
      targetUrl: 'https://example.com',
      steps: ['step 1'],
      assertions: ['assert 1'],
      checkpoints: [],
      generatedAt: new Date().toISOString(),
    };
    await saveChecklist(checklist);
    const loaded = await loadChecklist('round-trip');
    expect(loaded?.steps).toEqual(['step 1']);
  });

  it('planScenario uses explicit steps without LLM', async () => {
    const result = await planScenario(
      {
        name: 'explicit',
        goal: 'Explicit steps test',
        tags: [],
        hints: [],
        steps: ['Click button'],
        checkpoints: [],
        success_criteria: ['Button clicked'],
      },
      'https://example.com',
    );
    expect(result.steps).toEqual(['Click button']);
    expect(result.assertions).toEqual(['Button clicked']);
  });

  it('planScenario falls back when no LLM configured', async () => {
    const result = await planScenario(
      {
        name: 'fallback',
        goal: 'Fallback test',
        tags: [],
        hints: ['hint a'],
        steps: [],
        checkpoints: [],
        success_criteria: ['criteria a'],
      },
      'https://example.com',
    );
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.assertions).toEqual(['criteria a']);
  });

  it('planScenario parses LLM response', async () => {
    process.env.PLANNER_MODEL_BASE_URL = 'http://mock-llm/v1';
    process.env.PLANNER_MODEL_NAME = 'mock-model';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              steps: ['LLM step 1'],
              assertions: ['LLM assert 1'],
            }),
          },
        }],
      }),
    }));

    const result = await planScenario(
      {
        name: 'llm-planned',
        goal: 'LLM planned',
        tags: [],
        hints: [],
        steps: [],
        checkpoints: [],
        success_criteria: [],
      },
      'https://example.com',
    );
    expect(result.steps).toEqual(['LLM step 1']);
    expect(result.assertions).toEqual(['LLM assert 1']);
  });

  it('planScenario lets the AI decide checkpoint ordering', async () => {
    process.env.PLANNER_MODEL_BASE_URL = 'http://mock-llm/v1';
    process.env.PLANNER_MODEL_NAME = 'mock-model';
    // critic uses the same mock endpoint; both calls return the same shape.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              steps: ['Open catalog', 'Open first item'],
              assertions: ['Detail page is shown'],
              checkpoints: [{ afterStep: 1, assertion: 'A list of items is shown' }],
            }),
          },
        }],
      }),
    }));

    const result = await planScenario(
      {
        name: 'ai-checkpoints',
        goal: 'Browse a catalog and open an item',
        tags: [],
        hints: [],
        steps: [],
        checkpoints: [],
        success_criteria: [],
      },
      'https://example.com',
    );
    expect(result.checkpoints).toEqual([{ afterStep: 1, assertion: 'A list of items is shown' }]);
    expect(result.assertions).toEqual(['Detail page is shown']);
  });

  it('planScenario honors manual checkpoints over AI ones', async () => {
    const result = await planScenario(
      {
        name: 'manual-checkpoints',
        goal: 'Manual ordering',
        tags: [],
        hints: [],
        steps: ['Step one', 'Step two'],
        checkpoints: [{ afterStep: 1, assertion: 'Manual checkpoint' }],
        success_criteria: ['Final check'],
      },
      'https://example.com',
    );
    expect(result.checkpoints).toEqual([{ afterStep: 1, assertion: 'Manual checkpoint' }]);
    expect(result.steps).toEqual(['Step one', 'Step two']);
  });

  it('prepareChecklist saves plan in warm-up mode', async () => {
    await writeScenario(ws, 'prep.yaml', {
      name: 'prep-scenario',
      goal: 'Prepare checklist',
      steps: ['Navigate'],
      success_criteria: ['Page loaded'],
    });
    const full = path.join(ws.scenariosDir, 'prep.yaml');
    const checklist = await prepareChecklist(full);
    expect(checklist.scenarioId).toBe('prep-scenario');
    const planPath = path.join(ws.midsceneDir, 'plans', 'prep-scenario.json');
    const raw = await fs.readFile(planPath, 'utf-8');
    expect(JSON.parse(raw).steps).toContain('Navigate');
  });
});
