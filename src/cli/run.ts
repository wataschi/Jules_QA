#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { getCacheId } from '../config/env.js';
import { createAiTestFixture } from '../engine/fixture.js';
import { closeStagehand, executeChecklist } from '../engine/hybrid-runner.js';
import { flushCacheIfWarmUp, logCacheMode } from '../engine/self-heal.js';
import { loadScenarioYaml, prepareChecklist } from '../planning/scenario-planner.js';

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

  const scenario = await loadScenarioYaml(scenarioPath);
  const checklist = await prepareChecklist(scenarioPath);

  logCacheMode(args.mode, getCacheId(scenario.name));
  console.log(`[qa] Running via Playwright: ${scenario.name}`);
  console.log(`[qa] Goal: ${checklist.goal}`);
  console.log(`[qa] Steps: ${checklist.steps.length}, Assertions: ${checklist.assertions.length}`);

  const exitCode = await runPlaywrightTest(scenarioPath, args.mode);

  if (exitCode === 0) {
    const { aggregateReports } = await import('../reporting/aggregate-report.js');
    await aggregateReports(scenario.name);
  }

  process.exit(exitCode);
}

export { executeChecklist, closeStagehand, flushCacheIfWarmUp, createAiTestFixture, prepareChecklist, loadScenarioYaml };

main().catch((error) => {
  console.error('[qa] Failed:', error);
  process.exit(1);
});
