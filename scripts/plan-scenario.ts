#!/usr/bin/env node
import path from 'node:path';
import dotenv from 'dotenv';
import { prepareChecklist } from '../src/planning/scenario-planner.js';

dotenv.config();

/**
 * Standalone planner: generates (model-authored) steps + assertions for a
 * scenario YAML and prints the resulting checklist. Useful to inspect what the
 * planning model produced before committing to a full browser run.
 *
 * Usage: tsx scripts/plan-scenario.ts <scenario.yaml>
 */
async function main(): Promise<void> {
  const arg = process.argv[2] ?? process.env.QA_SCENARIO_PATH;
  if (!arg) {
    console.error('Usage: tsx scripts/plan-scenario.ts <scenario.yaml>');
    process.exit(1);
  }
  const scenarioPath = path.resolve(process.cwd(), arg);
  const checklist = await prepareChecklist(scenarioPath);

  console.log('\n=== Generated checklist ===');
  console.log(`Scenario : ${checklist.scenarioId}`);
  console.log(`Target   : ${checklist.targetUrl}`);
  console.log(`Goal     : ${checklist.goal}`);
  console.log(`\nSteps (${checklist.steps.length}):`);
  checklist.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  console.log(`\nCheckpoints (${checklist.checkpoints.length}) — verified mid-run:`);
  checklist.checkpoints.forEach((c) => console.log(`  after step ${c.afterStep}: ${c.assertion}`));
  console.log(`\nAssertions (${checklist.assertions.length}) — verified at the end:`);
  checklist.assertions.forEach((a, i) => console.log(`  ${i + 1}. ${a}`));
  console.log('');
}

main().catch((error) => {
  console.error('[plan] Failed:', error);
  process.exit(1);
});
