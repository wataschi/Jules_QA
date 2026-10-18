/**
 * Спільне для команд CLI: розібрані аргументи, клієнт хаба з конфігу, дані GitHub Actions
 * з оточення й файлу події, підстановка файлів у команди тестів.
 */
import fs from 'node:fs';
import path from 'node:path';
import { requireHub, type ResolvedConfig } from '../config.js';
import type { CliContext, Env } from '../context.js';
import { createHubClient, type HubClient } from '../hub.js';

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean | string[] | undefined>;
}

export type CommandHandler = (ctx: CliContext, args: ParsedArgs) => Promise<number>;

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  if (Array.isArray(value)) return value[value.length - 1];
  return typeof value === 'string' ? value : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true;
}

export function flagList(args: ParsedArgs, name: string): string[] {
  const value = args.flags[name];
  if (Array.isArray(value)) return value;
  return typeof value === 'string' ? [value] : [];
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export function flagInt(args: ParsedArgs, name: string): number | undefined {
  const raw = flagString(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new UsageError(`--${name} має бути додатним цілим числом, отримано «${raw}».`);
  return value;
}

export function hubFor(ctx: CliContext, config: ResolvedConfig, opts: { timeoutMs?: number } = {}): HubClient {
  return createHubClient({
    hub: requireHub(config),
    token: config.token,
    fetch: ctx.fetch,
    timeoutMs: opts.timeoutMs,
    sleep: ctx.sleep,
  });
}

/* ─────────────────────────── GitHub Actions ─────────────────────────── */

export interface GithubPullRequest {
  number?: number;
  merged?: boolean;
  title?: string;
  html_url?: string;
  head?: { sha?: string; ref?: string };
  base?: { ref?: string };
}

export interface GithubEvent {
  action?: string;
  pull_request?: GithubPullRequest;
  number?: number;
  head_commit?: { id?: string; message?: string; author?: { name?: string; email?: string; username?: string } };
  pusher?: { name?: string; email?: string };
}

/** Вміст `GITHUB_EVENT_PATH` або `null`, якщо файлу немає чи він не JSON. */
export function readGithubEvent(env: Env, cwd: string): GithubEvent | null {
  const file = env.GITHUB_EVENT_PATH;
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(path.resolve(cwd, file), 'utf-8')) as GithubEvent;
  } catch {
    return null;
  }
}

export function isGithubActions(env: Env): boolean {
  return env.GITHUB_ACTIONS === 'true';
}

export function githubRunUrl(env: Env): string | undefined {
  if (!env.GITHUB_REPOSITORY || !env.GITHUB_RUN_ID) return undefined;
  const server = (env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '');
  return `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}

/* ─────────────────────────── команди тестів ─────────────────────────── */

/** Лапки для оболонки POSIX, лише коли потрібні. */
export function shellQuote(value: string): string {
  if (/^[\w@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `npx vitest run {files}` + файли → рядок команди. Без `{files}` файли дописуються в кінець. */
export function fillCommand(template: string, files: readonly string[]): string {
  const list = files.map(shellQuote).join(' ');
  return template.includes('{files}') ? template.split('{files}').join(list) : `${template} ${list}`.trim();
}

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Останні `count` непорожніх рядків виводу без ANSI-кольорів. */
export function tailLines(output: string, count = 60): string {
  const all = output.replace(ANSI_RE, '').replace(/\r/g, '').split('\n');
  while (all.length && !all[all.length - 1]!.trim()) all.pop();
  return all.slice(-count).join('\n');
}

/** Частина файлів, що існують на диску (видалені тестам не передаємо). */
export function existingFiles(root: string, files: readonly string[]): string[] {
  return files.filter((file) => {
    try {
      return fs.statSync(path.join(root, file)).isFile();
    } catch {
      return false;
    }
  });
}

/** Абсолютний шлях з хука → відносно кореня репо; поза репо — `null`. */
export function relativeToRoot(root: string, file: string): string | null {
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}
