import path from 'node:path';
import dotenv from 'dotenv';
import { getCacheId, getEnv } from '../src/config/env.js';
import { bootstrapMidsceneEnv } from '../src/config/midscene-env.js';
import { createAiTestFixture } from '../src/engine/fixture.js';
import { closeStagehand, executeChecklist } from '../src/engine/hybrid-runner.js';
import { flushCacheIfWarmUp, logCacheMode } from '../src/engine/self-heal.js';
import { resolveStorageStateIfValid } from '../src/engine/session.js';
import { loadAllSecretValues } from '../src/security/vault.js';
import { registerSecretsForRedaction } from '../src/security/redact.js';
import { loadScenarioYaml, prepareChecklist } from '../src/planning/scenario-planner.js';

dotenv.config();
bootstrapMidsceneEnv();

const scenarioPath = path.resolve(
  process.cwd(),
  process.env.QA_SCENARIO_PATH ?? 'scenarios/invalid-password.yaml',
);

const scenario = await loadScenarioYaml(scenarioPath);
const checklist = await prepareChecklist(scenarioPath);
const env = getEnv();
const cacheId = getCacheId(scenario.name);
const runId = process.env.QA_RUN_ID;

let storageStatePath: string | undefined;
if (scenario.auth?.profile) {
  try {
    storageStatePath = await resolveStorageStateIfValid(scenario.auth.profile);
    if (storageStatePath) {
      console.log(`[session] Preloading storageState: ${storageStatePath}`);
    }
  } catch (error) {
    console.warn(
      `[session] Could not preload storageState: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (process.env.JULES_VAULT_KEY) {
    try {
      registerSecretsForRedaction(await loadAllSecretValues());
    } catch {
      /* vault optional during preload */
    }
  }
}

logCacheMode(env.QA_MODE, cacheId);

const test = createAiTestFixture(scenario.name, { storageState: storageStatePath });

test.describe(`AI Scenario: ${scenario.name}`, () => {
  test('executes planned checklist with self-healing', async ({ page, agentForPage, context }) => {
    const agent = await agentForPage(page);

    await executeChecklist({
      page,
      agent,
      context,
      checklist,
      scenario,
      runId,
    });

    await flushCacheIfWarmUp(agent, env.QA_MODE);
  });
});

test.afterAll(async () => {
  await closeStagehand();
});
