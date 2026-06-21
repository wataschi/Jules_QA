import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { expect } from '@playwright/test';
import { getCacheId, getEnv, resetEnvCache } from '../src/config/env.js';
import { bootstrapMidsceneEnv } from '../src/config/midscene-env.js';
import { createAiTestFixture } from '../src/engine/fixture.js';
import { closeStagehand, executeChecklist } from '../src/engine/hybrid-runner.js';
import { flushCacheIfWarmUp, logCacheMode } from '../src/engine/self-heal.js';
import { loadScenarioYaml, prepareChecklist } from '../src/planning/scenario-planner.js';
import { isLlmAvailable } from './helpers/llm-gate.js';

dotenv.config();
process.env.QA_SCENARIO_PATH = 'scenarios/universal-page-load.yaml';
process.env.QA_TARGET_URL = process.env.QA_TARGET_URL ?? 'https://example.com';
process.env.QA_MODE = 'warm-up';
resetEnvCache();
bootstrapMidsceneEnv();

const llmReady = await isLlmAvailable();
const scenarioPath = path.resolve(process.cwd(), process.env.QA_SCENARIO_PATH!);
const scenario = await loadScenarioYaml(scenarioPath);
const checklist = await prepareChecklist(scenarioPath);
const env = getEnv();
const cacheId = getCacheId(scenario.name);
const aiTest = createAiTestFixture(scenario.name);

logCacheMode(env.QA_MODE, cacheId);

aiTest.describe('@llm LLM-01 universal-page-load warm-up', () => {
  aiTest.beforeEach(() => {
    aiTest.skip(!llmReady, 'LLM endpoint unavailable — run npm run check:llm');
  });

  aiTest('executes checklist and writes cache', async ({ page, agentForPage }) => {
    const agent = await agentForPage(page);
    await executeChecklist({ page, agent, checklist, scenario });
    await flushCacheIfWarmUp(agent, env.QA_MODE);

    const cacheFile = path.join(process.cwd(), 'midscene_run', 'cache', `${cacheId}.cache.yaml`);
    await expect(fs.access(cacheFile).then(() => true)).resolves.toBe(true);

    const planFile = path.join(process.cwd(), 'midscene_run', 'plans', `${scenario.name}.json`);
    const plan = JSON.parse(await fs.readFile(planFile, 'utf-8'));
    expect(plan.steps.length).toBeGreaterThan(0);
  });
});

aiTest.afterAll(async () => {
  await closeStagehand();
});
