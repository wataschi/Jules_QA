import path from 'node:path';
import dotenv from 'dotenv';
import { getCacheId, getEnv, resetEnvCache } from '../src/config/env.js';
import { bootstrapMidsceneEnv } from '../src/config/midscene-env.js';
import { createAiTestFixture } from '../src/engine/fixture.js';
import { closeStagehand, executeChecklist } from '../src/engine/hybrid-runner.js';
import { logCacheMode } from '../src/engine/self-heal.js';
import { loadScenarioYaml, prepareChecklist } from '../src/planning/scenario-planner.js';
import { isLlmAvailable } from './helpers/llm-gate.js';

dotenv.config();
process.env.QA_SCENARIO_PATH = 'scenarios/universal-page-load.yaml';
process.env.QA_TARGET_URL = process.env.QA_TARGET_URL ?? 'https://example.com';
process.env.QA_MODE = 'regression';
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

aiTest.describe('@llm LLM-02 universal-page-load regression', () => {
  aiTest.beforeEach(() => {
    aiTest.skip(!llmReady, 'LLM endpoint unavailable — run warm-up first');
  });

  aiTest('executes checklist using cache', async ({ page, agentForPage }) => {
    const agent = await agentForPage(page);
    await executeChecklist({ page, agent, checklist, scenario });
  });
});

aiTest.afterAll(async () => {
  await closeStagehand();
});
