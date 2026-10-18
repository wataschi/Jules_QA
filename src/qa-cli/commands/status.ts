/**
 * `jules-qa status --out QA_STATUS.md [--branch main]` і `jules-qa pr-comment --pr N --out <file>`
 * — готові звіти з хаба. Jules рахує вміст детерміновано; CLI лише кладе його у файл.
 * `status` пише файл тільки коли вміст змінився, щоб бот не робив порожніх комітів.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { println, type CliContext } from '../context.js';
import { flagInt, flagString, hubFor, readGithubEvent, UsageError, type CommandHandler } from './common.js';

/** Записує файл, якщо вміст відрізняється. Повертає, чи було записано. */
export function writeIfChanged(file: string, content: string): boolean {
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
  if (current === content) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
  return true;
}

export const statusCommand: CommandHandler = async (ctx: CliContext, args) => {
  const config = loadConfig({ cwd: ctx.cwd, env: ctx.env });
  const out = flagString(args, 'out') ?? 'QA_STATUS.md';
  const branch = flagString(args, 'branch') ?? 'main';
  const text = await hubFor(ctx, config).getText('/status.md', { projectId: config.projectId, branch });
  const content = text.endsWith('\n') ? text : `${text}\n`;
  const changed = writeIfChanged(path.resolve(ctx.cwd, out), content);
  println(ctx, changed ? 'changed' : 'unchanged');
  return 0;
};

export const prCommentCommand: CommandHandler = async (ctx: CliContext, args) => {
  const config = loadConfig({ cwd: ctx.cwd, env: ctx.env });
  const event = readGithubEvent(ctx.env, ctx.cwd);
  const prNumber = flagInt(args, 'pr') ?? event?.pull_request?.number ?? event?.number;
  if (!prNumber) throw new UsageError('Вкажіть номер PR: --pr <N> (у GitHub Actions береться з події pull_request).');
  const sha = flagString(args, 'sha') ?? event?.pull_request?.head?.sha ?? ctx.env.GITHUB_SHA;
  const text = await hubFor(ctx, config).getText('/pr-comment.md', { projectId: config.projectId, prNumber, sha });
  const out = flagString(args, 'out');
  if (out) {
    writeIfChanged(path.resolve(ctx.cwd, out), text);
    println(ctx, `PR-коментар записано в ${out}`);
  } else {
    ctx.stdout(text.endsWith('\n') ? text : `${text}\n`);
  }
  return 0;
};
