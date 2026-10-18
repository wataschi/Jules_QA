/**
 * `jules-qa assert-guard [--base origin/main] [--json]` — охоронець асертів для CI-кроку.
 *
 * Шукає в диффі змінені чи видалені НАЯВНІ перевірки в тест-файлах. Код виходу завжди 0:
 * рішення ухвалює QA, а CI лише ставить PR мітку `qa:assertion-change`. Для GitHub Actions
 * рядок `label=…` дописується ще й у `$GITHUB_OUTPUT`.
 */
import fs from 'node:fs';
import { analyzeAssertionChanges, type AssertionChange } from '../../ingest/index.js';
import { loadConfig } from '../config.js';
import { eprintln, println, type CliContext } from '../context.js';
import { createGit } from '../git.js';
import { DEFAULT_BASE } from './affected.js';
import { flagBool, flagString, type CommandHandler } from './common.js';

export const ASSERTION_LABEL = 'qa:assertion-change';

export async function findAssertionChanges(ctx: CliContext, base: string): Promise<AssertionChange[]> {
  const config = loadConfig({ cwd: ctx.cwd, env: ctx.env });
  const diff = await createGit(ctx.exec, config.root).diff(base);
  return analyzeAssertionChanges(diff, { testFileGlobs: config.testFileGlobs });
}

export const assertGuardCommand: CommandHandler = async (ctx: CliContext, args) => {
  const base = flagString(args, 'base') ?? DEFAULT_BASE;
  let changes: AssertionChange[];
  try {
    changes = await findAssertionChanges(ctx, base);
  } catch (error) {
    eprintln(ctx, `Охоронець асертів пропущено: ${(error as Error).message}`);
    return 0;
  }
  const label = changes.length ? ASSERTION_LABEL : '';

  if (ctx.env.GITHUB_OUTPUT) {
    try {
      fs.appendFileSync(ctx.env.GITHUB_OUTPUT, `label=${label}\ncount=${changes.length}\n`);
    } catch {
      /* поза GitHub Actions файлу може не бути */
    }
  }

  if (flagBool(args, 'json')) {
    println(ctx, JSON.stringify({ base, label: label || null, changes }, null, 2));
    return 0;
  }
  if (!changes.length) {
    println(ctx, `Наявні асерти не змінено (відносно ${base}).`);
    return 0;
  }
  println(ctx, `Змінено наявні асерти: ${changes.length} (відносно ${base}). Потрібне погодження QA, якщо це не задача change_test.`);
  for (const change of changes) {
    const after = change.kind === 'modified' && change.after !== undefined ? `\n      → ${change.after.trim()}` : '';
    println(ctx, `  ${change.file}:${change.line}  ${change.kind === 'removed' ? 'видалено' : 'змінено'}: ${change.before.trim()}${after}`);
  }
  println(ctx, `label=${ASSERTION_LABEL}`);
  return 0;
};
