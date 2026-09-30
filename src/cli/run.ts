#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { getCacheId, scenarioKey } from '../config/env.js';
import { createAiTestFixture } from '../engine/fixture.js';
import { closeStagehand, executeChecklist } from '../engine/hybrid-runner.js';
import { flushCacheIfWarmUp, logCacheMode } from '../engine/self-heal.js';
import { loadScenarioYaml, prepareChecklist, scenarioHasSecrets } from '../planning/scenario-planner.js';

dotenv.config();

interface CliArgs {
  scenario: string;
  mode: 'warm-up' | 'regression';
}

function parseArgs(argv: string[]): CliArgs {
  let scenario = process.env.QA_SCENARIO_PATH ?? 'scenarios/invalid-password.yaml';
  let mode = (process.env.QA_MODE as CliArgs['mode']) ?? 'warm-up';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--scenario' && argv[i + 1]) {
      scenario = argv[++i];
    } else if (arg === '--mode' && argv[i + 1]) {
      const value = argv[++i];
      if (value === 'warm-up' || value === 'regression') {
        mode = value;
      } else {
        throw new Error(`Invalid mode: ${value}. Use warm-up or regression.`);
      }
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return { scenario, mode };
}

function printHelp(): void {
  console.log(`
jules-ai-qa — local autonomous AI QA MVP

Usage:
  npm run qa -- --scenario scenarios/invalid-password.yaml --mode warm-up
  npm run qa -- --scenario scenarios/invalid-password.yaml --mode regression

Options:
  --scenario <path>   YAML scenario file (default: scenarios/invalid-password.yaml)
  --mode <mode>       warm-up | regression (default: warm-up)
  --help, -h          Show this help

Environment:
  QA_TARGET_URL, MIDSCENE_MODEL_*, PLANNER_MODEL_*, DEBUG=midscene:cache:*
`);
}

async function runPlaywrightTest(scenarioPath: string, mode: string): Promise<number> {
  process.env.QA_SCENARIO_PATH = scenarioPath;
  process.env.QA_MODE = mode;

  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['playwright', 'test', 'e2e/ai-scenario.spec.ts'],
      {
        stdio: 'inherit',
        env: process.env,
        shell: process.platform === 'win32',
      },
    );
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const scenarioPath = path.resolve(process.cwd(), args.scenario);

  try {
    await fs.access(scenarioPath);
  } catch {
    throw new Error(`Scenario file not found: ${scenarioPath}`);
  }

  process.env.QA_SCENARIO_PATH = scenarioPath;
  process.env.QA_MODE = args.mode;

  // Справжній runId: раніше CLI не задавав QA_RUN_ID, тож `human:`-крок бачив
  // runId === 'local' і лише друкував попередження замість того, щоб чекати
  // оператора (файл контролю + Enter у TTY).
  if (!process.env.QA_RUN_ID) {
    process.env.QA_RUN_ID = randomUUID();
  }
  const runId = process.env.QA_RUN_ID;

  const scenario = await loadScenarioYaml(scenarioPath);
  const targetUrl = scenario.target_url ?? process.env.QA_TARGET_URL ?? 'https://example.com';
  const artifactKey = scenarioKey(scenario.name, targetUrl);

  if (scenarioHasSecrets(scenario)) {
    process.env.QA_TRACE = 'off';
    console.log('[qa] Сценарій зі секретами — QA_TRACE=off (трейс не пишеться, щоб пароль не потрапив у trace.zip)');
  }

  // Планування НЕ робимо тут: дочірній процес (e2e/ai-scenario.spec.ts) однаково
  // викликає prepareChecklist, і раніше це давало два повних проходи
  // planner+critic на один CLI-прогін. Тепер — рівно один.
  logCacheMode(args.mode, getCacheId(scenario.name, targetUrl));
  console.log(`[qa] Running via Playwright: ${scenario.name} (runId=${runId})`);
  console.log(`[qa] Goal: ${scenario.goal}`);
  console.log(
    scenario.steps.length > 0
      ? `[qa] Steps: ${scenario.steps.length}, Success criteria: ${scenario.success_criteria.length}`
      : '[qa] Steps: план буде згенерований у дочірньому процесі (planner+critic, один раз)',
  );

  const startedAt = new Date().toISOString();
  const exitCode = await runPlaywrightTest(scenarioPath, args.mode);

  // Звіт збираємо завжди — саме впалий прогін найбільше потребує доказів;
  // `since` обмежує докази артефактами саме цього прогону.
  try {
    const { aggregateReports } = await import('../reporting/aggregate-report.js');
    await aggregateReports(artifactKey, { since: startedAt });
  } catch (error) {
    console.warn('[qa] Збірка агрегованого звіту впала:', error instanceof Error ? error.message : error);
  }

  process.exit(exitCode);
}

export { executeChecklist, closeStagehand, flushCacheIfWarmUp, createAiTestFixture, prepareChecklist, loadScenarioYaml };

main().catch((error) => {
  console.error('[qa] Failed:', error);
  process.exit(1);
});
