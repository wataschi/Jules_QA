/**
 * `jules-qa affected [--base origin/main] [--json]` — змінені файли (коміти гілки, незакомічене,
 * untracked) і команда прогону пов'язаних тестів із `commands.related` конфігу.
 */
import { loadConfig, type ResolvedConfig } from '../config.js';
import { println, type CliContext } from '../context.js';
import { createGit } from '../git.js';
import { isTestFile } from '../reports.js';
import { existingFiles, fillCommand, flagBool, flagString, type CommandHandler } from './common.js';

export const DEFAULT_BASE = 'origin/main';

export interface AffectedInfo {
  base: string;
  files: string[];
  testFiles: string[];
  command?: string;
}

/** Змінені файли, що існують на диску (видалені тестам передавати нема сенсу). */
export async function changedFiles(ctx: CliContext, config: ResolvedConfig, base = DEFAULT_BASE): Promise<string[]> {
  const git = createGit(ctx.exec, config.root);
  if (!(await git.isRepo())) return [];
  return existingFiles(config.root, await git.changedFiles(base));
}

/** Службові файли (інструкції агента, CI, сам Jules QA) тестів не мають — їх раннеру не передаємо. */
const NOT_TESTABLE_RE = /^(?:\.claude\/|\.github\/|qa\/)|\.md$/i;

export function testableFiles(files: readonly string[]): string[] {
  return files.filter((file) => !NOT_TESTABLE_RE.test(file));
}

export async function computeAffected(ctx: CliContext, config: ResolvedConfig, base = DEFAULT_BASE): Promise<AffectedInfo> {
  const files = await changedFiles(ctx, config, base);
  const testFiles = files.filter((file) => isTestFile(file, config.testFileGlobs));
  const testable = testableFiles(files);
  const command = testable.length && config.commands.related ? fillCommand(config.commands.related, testable) : undefined;
  return { base, files, testFiles, command };
}

export const affectedCommand: CommandHandler = async (ctx: CliContext, args) => {
  const config = loadConfig({ cwd: ctx.cwd, env: ctx.env });
  const info = await computeAffected(ctx, config, flagString(args, 'base') ?? DEFAULT_BASE);
  if (flagBool(args, 'json')) {
    println(ctx, JSON.stringify(info, null, 2));
    return 0;
  }
  if (!info.files.length) {
    println(ctx, `Змін відносно ${info.base} немає.`);
    return 0;
  }
  println(ctx, `Змінені файли відносно ${info.base} (${info.files.length}, з них тестів ${info.testFiles.length}):`);
  for (const file of info.files) println(ctx, `  ${file}`);
  println(ctx);
  if (info.command) println(ctx, `Пов'язані тести: ${info.command}`);
  else println(ctx, "Команду пов'язаних тестів не задано: commands.related у qa/jules.config.json.");
  return 0;
};
