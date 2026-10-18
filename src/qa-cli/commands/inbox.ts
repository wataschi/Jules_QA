/**
 * `jules-qa inbox [--brief]` — задачі QA з Jules для файлів, які зараз змінені.
 *
 * `--brief` — один-два рядки для старту сесії агента («Jules: 2 задачі QA по модулю Акти…»).
 * Порожньо — нічого не друкуємо. Хаб недоступний (немає Tailscale) — теж мовчимо: задачі
 * дочекаються наступної сесії, а розробника не відволікаємо помилками мережі.
 */
import { loadConfig } from '../config.js';
import { println, type CliContext } from '../context.js';
import { HubUnavailable } from '../hub.js';
import { changedFiles, DEFAULT_BASE } from './affected.js';
import { flagBool, flagString, hubFor, type CommandHandler } from './common.js';

export interface InboxTask {
  id: string;
  kind: string;
  title: string;
  state: string;
  module?: string;
  ageHours: number;
}

export interface InboxResponse {
  tasks: InboxTask[];
  total: number;
}

/** Скільки шляхів передаємо в query — довгий URL ламає проксі, а для маршрутизації вистачає. */
const MAX_PATHS = 100;

/** 1 задача, 2 задачі, 5 задач, 21 задача. */
export function pluralTasks(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'задача';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'задачі';
  return 'задач';
}

export function formatAge(hours: number): string {
  if (hours < 1) return 'менше години';
  if (hours < 24) return `${Math.round(hours)} год`;
  return `${Math.round(hours / 24)} дн`;
}

/** Короткий підсумок для старту сесії; `null`, якщо задач немає. */
export function formatInboxBrief(inbox: InboxResponse): string | null {
  const total = Math.max(inbox.total ?? 0, inbox.tasks.length);
  if (!total) return null;
  const modules = [...new Set(inbox.tasks.map((t) => t.module).filter((m): m is string => Boolean(m)))];
  const where =
    modules.length === 1 ? ` по модулю ${modules[0]}` : modules.length > 1 ? ` по модулях ${modules.slice(0, 3).join(', ')}${modules.length > 3 ? ' …' : ''}` : '';
  const ids = inbox.tasks.slice(0, 3).map((t) => t.id);
  const more = total > ids.length ? ' …' : '';
  const lines = [`Jules: ${total} ${pluralTasks(total)} QA${where}${ids.length ? ` (${ids.join(', ')}${more})` : ''}. Взяти: /qa-inbox`];
  const oldest = inbox.tasks.reduce((max, t) => Math.max(max, t.ageHours ?? 0), 0);
  if (oldest >= 24) lines.push(`Найстаріша чекає ${formatAge(oldest)}.`);
  return lines.join('\n');
}

export function formatInboxFull(inbox: InboxResponse): string {
  if (!inbox.tasks.length) return 'Задач QA немає.';
  const lines = [`Задачі QA (${Math.max(inbox.total, inbox.tasks.length)}):`];
  for (const t of inbox.tasks) {
    lines.push(`  ${t.id}  ${t.kind}  ${t.state}${t.module ? `  [${t.module}]` : ''}  чекає ${formatAge(t.ageHours ?? 0)}`);
    lines.push(`      ${t.title}`);
  }
  lines.push('', 'Взяти задачу: /qa-inbox (агент запропонує, рішення за розробником).');
  return lines.join('\n');
}

export async function fetchInbox(ctx: CliContext, opts: { timeoutMs?: number; base?: string } = {}): Promise<InboxResponse> {
  const config = loadConfig({ cwd: ctx.cwd, env: ctx.env });
  const hub = hubFor(ctx, config, { timeoutMs: opts.timeoutMs });
  const paths = (await changedFiles(ctx, config, opts.base ?? DEFAULT_BASE).catch(() => [])).slice(0, MAX_PATHS);
  const inbox = await hub.getJson<InboxResponse>('/inbox', {
    projectId: config.projectId,
    paths: paths.length ? paths.join(',') : undefined,
  });
  return { tasks: Array.isArray(inbox?.tasks) ? inbox.tasks : [], total: Number(inbox?.total ?? 0) };
}

/** Режим `--brief` і хук `session-start`: будь-яка помилка — тиша, код 0. */
export async function printInboxBrief(ctx: CliContext, opts: { timeoutMs?: number } = {}): Promise<number> {
  try {
    const line = formatInboxBrief(await fetchInbox(ctx, { timeoutMs: opts.timeoutMs ?? 5_000 }));
    if (line) println(ctx, line);
  } catch {
    /* немає мережі чи конфігу — розробника не відволікаємо */
  }
  return 0;
}

export const inboxCommand: CommandHandler = async (ctx: CliContext, args) => {
  if (flagBool(args, 'brief')) return printInboxBrief(ctx);
  try {
    println(ctx, formatInboxFull(await fetchInbox(ctx, { base: flagString(args, 'base') })));
  } catch (error) {
    if (error instanceof HubUnavailable) return 0;
    throw error;
  }
  return 0;
};
