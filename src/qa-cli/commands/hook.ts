/**
 * `jules-qa hook post-edit|stop|session-start` — хуки Claude Code (JSON події на stdin).
 *
 * Код 2 — сигнал Claude Code «заблокуй і покажи stderr агенту»: червоний тест після правки
 * тест-файлу або перед завершенням ходу. Будь-яка проблема самого хука (немає конфігу, git,
 * мережі, битий JSON) — тихий код 0: хук не має заважати роботі, останній рубіж — CI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, type ResolvedConfig } from '../config.js';
import { eprintln, type CliContext } from '../context.js';
import { isTestFile } from '../reports.js';
import { changedFiles, testableFiles } from './affected.js';
import { fillCommand, relativeToRoot, tailLines, UsageError, type CommandHandler } from './common.js';
import { printInboxBrief } from './inbox.js';

export const HOOK_BLOCK = 2;
const TAIL_LINES = 60;
const TEST_TIMEOUT_MS = 10 * 60_000;

interface HookPayload {
  cwd?: string;
  hook_event_name?: string;
  stop_hook_active?: boolean;
  tool_name?: string;
  tool_input?: { file_path?: string; path?: string; notebook_path?: string };
}

async function readPayload(ctx: CliContext): Promise<HookPayload | null> {
  try {
    const raw = (await ctx.readStdin()).trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as HookPayload) : null;
  } catch {
    return null;
  }
}

function safeConfig(ctx: CliContext, payload: HookPayload): ResolvedConfig | null {
  try {
    const cwd = ctx.env.CLAUDE_PROJECT_DIR || payload.cwd || ctx.cwd;
    return loadConfig({ cwd, env: ctx.env });
  } catch {
    return null;
  }
}

export async function hookPostEdit(ctx: CliContext, payload: HookPayload): Promise<number> {
  const config = safeConfig(ctx, payload);
  const raw = payload.tool_input?.file_path ?? payload.tool_input?.path;
  if (!config || !raw || !config.commands.testFile) return 0;
  const file = relativeToRoot(config.root, path.isAbsolute(raw) ? raw : path.resolve(payload.cwd ?? config.root, raw));
  if (!file || !isTestFile(file, config.testFileGlobs)) return 0;
  // Тест-файл видалено — проганяти нічого.
  if (!fs.existsSync(path.join(config.root, file))) return 0;

  const command = fillCommand(config.commands.testFile, [file]);
  const result = await ctx.shell(command, { cwd: config.root, timeoutMs: TEST_TIMEOUT_MS, env: { CI: '1', FORCE_COLOR: '0' } });
  if (result.code === 0) return 0;
  eprintln(ctx, `Jules QA: тест-файл ${file} червоний (${command}, код ${result.code}).`);
  eprintln(ctx, 'Виправ код або тест, не послаблюючи асертів (змінювати їх можна лише за задачею change_test).');
  eprintln(ctx, tailLines(result.output, TAIL_LINES));
  return HOOK_BLOCK;
}

export async function hookStop(ctx: CliContext, payload: HookPayload): Promise<number> {
  // Хук уже заблокував попередню спробу завершення — не зациклюємо агента.
  if (payload.stop_hook_active) return 0;
  const config = safeConfig(ctx, payload);
  if (!config || !config.commands.related) return 0;
  let files: string[];
  try {
    files = testableFiles(await changedFiles(ctx, config));
  } catch {
    return 0;
  }
  if (!files.length) return 0;

  const command = fillCommand(config.commands.related, files);
  const result = await ctx.shell(command, { cwd: config.root, timeoutMs: TEST_TIMEOUT_MS, env: { CI: '1', FORCE_COLOR: '0' } });
  if (result.code === 0) return 0;
  eprintln(ctx, `Jules QA: пов'язані зі змінами тести червоні (код ${result.code}). Хід не завершено.`);
  eprintln(ctx, `Команда: ${command}`);
  eprintln(ctx, tailLines(result.output, TAIL_LINES));
  return HOOK_BLOCK;
}

export const hookCommand: CommandHandler = async (ctx: CliContext, args) => {
  const kind = args.positionals[0];
  if (!kind || !['post-edit', 'stop', 'session-start'].includes(kind)) {
    throw new UsageError('Вкажіть хук: jules-qa hook post-edit|stop|session-start');
  }
  const payload = await readPayload(ctx);
  if (!payload) return 0;
  try {
    if (kind === 'post-edit') return await hookPostEdit(ctx, payload);
    if (kind === 'stop') return await hookStop(ctx, payload);
    const cwd = ctx.env.CLAUDE_PROJECT_DIR || payload.cwd || ctx.cwd;
    return await printInboxBrief({ ...ctx, cwd });
  } catch {
    return 0;
  }
};
