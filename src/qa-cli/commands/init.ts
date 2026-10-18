/**
 * `jules-qa init --hub <url> --project <id> [--force]` — підключення репо продукту до Jules.
 *
 * Ідемпотентно: повторний запуск нічого не дублює. Файли, якими володіє Jules (скіли, хуки,
 * розділ AGENTS.md між маркерами, сервер `jules` у .mcp.json, qa/bin), оновлюються до поточної
 * версії. Файли проєкту (conventions.md, qa-ci.yml) створюються лише якщо їх немає; `--force`
 * перезаписує їх із шаблону. У наявному jules.config.json міняються лише hub і projectId.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_PATH, ConfigError, findRepoRoot } from '../config.js';
import { println, type CliContext } from '../context.js';
import { TEMPLATE_FILES } from '../templates.js';
import { flagBool, flagString, UsageError, type CommandHandler } from './common.js';

export const AGENTS_START = '<!-- jules-qa:start -->';
export const AGENTS_END = '<!-- jules-qa:end -->';

export type InitActionKind = 'created' | 'updated' | 'unchanged' | 'skipped';

export interface InitAction {
  path: string;
  action: InitActionKind;
  note?: string;
}

export interface InitOptions {
  root: string;
  hub: string;
  projectId: string;
  force?: boolean;
  /** Зібраний бандл CLI, який копіюється в `qa/bin/jules-qa.mjs`. */
  selfPath?: string;
}

const ACTION_LABEL: Record<InitActionKind, string> = {
  created: 'створено ',
  updated: 'оновлено ',
  unchanged: 'без змін ',
  skipped: 'пропущено',
};

function template(name: string): string {
  const text = TEMPLATE_FILES[name];
  if (text === undefined) throw new Error(`У бандлі немає шаблону ${name} — перезберіть CLI (npm run cli:build).`);
  return text;
}

function fill(text: string, vars: { hub: string; projectId: string }): string {
  return text.split('{{hub}}').join(vars.hub).split('{{projectId}}').join(vars.projectId);
}

function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

/** Пише файл, якщо вміст відрізняється. `owned=false` — не перезаписує наявний без force. */
function writeManaged(root: string, rel: string, content: string, opts: { owned: boolean; force?: boolean }): InitAction {
  const file = path.join(root, rel);
  const current = readIfExists(file);
  if (current === content) return { path: rel, action: 'unchanged' };
  if (current !== null && !opts.owned && !opts.force) {
    return { path: rel, action: 'skipped', note: 'файл уже є; --force перезапише його шаблоном' };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
  return { path: rel, action: current === null ? 'created' : 'updated' };
}

function readJsonObject(file: string, rel: string): Record<string, unknown> | null {
  const raw = readIfExists(file);
  if (raw === null || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* нижче — зрозуміла помилка */
  }
  throw new ConfigError(`${rel} не є JSON-об'єктом — виправте файл вручну, init його не перезаписує.`);
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/* ───────────────────────────── AGENTS.md ─────────────────────────────── */

/** Вставляє або замінює розділ між маркерами `jules-qa:start/end`. */
export function upsertMarkedSection(text: string, section: string): string {
  const block = `${AGENTS_START}\n${section.trim()}\n${AGENTS_END}`;
  const start = text.indexOf(AGENTS_START);
  const end = start === -1 ? -1 : text.indexOf(AGENTS_END, start);
  if (start !== -1 && end !== -1) {
    return `${text.slice(0, start)}${block}${text.slice(end + AGENTS_END.length)}`;
  }
  const head = text.trimEnd();
  return `${head ? `${head}\n\n` : ''}${block}\n`;
}

/* ─────────────────────────── .claude/settings.json ───────────────────── */

interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

type HooksSpec = Record<string, HookGroup[]>;

/** `node "…/jules-qa.mjs" hook stop` і `npx jules-qa hook stop` — той самий хук. */
function hookSignature(command: string): string | null {
  const match = /jules-qa(?:\.mjs)?["']?\s+(.+)$/.exec(command.trim());
  if (!match) return null;
  const tail = match[1]!.replace(/\s+/g, ' ').trim();
  return tail === 'inbox --brief' ? 'hook session-start' : tail;
}

function sameHook(a: string, b: string): boolean {
  if (a.trim() === b.trim()) return true;
  const sa = hookSignature(a);
  return sa !== null && sa === hookSignature(b);
}

/** Зливає хуки jules-qa в наявні налаштування Claude Code без дублів. */
export function mergeHookSettings(existing: Record<string, unknown> | null, spec: HooksSpec): { settings: Record<string, unknown>; changed: boolean } {
  const settings: Record<string, unknown> = structuredClone(existing ?? {});
  const hooks = (settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? settings.hooks
    : {}) as Record<string, unknown>;
  let changed = !existing || settings.hooks !== hooks;
  settings.hooks = hooks;

  for (const [event, groups] of Object.entries(spec)) {
    const current = Array.isArray(hooks[event]) ? (hooks[event] as HookGroup[]) : [];
    if (!Array.isArray(hooks[event])) changed = true;
    hooks[event] = current;
    for (const group of groups) {
      for (const hook of group.hooks) {
        const present = current.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => typeof h?.command === 'string' && sameHook(h.command, hook.command)));
        if (present) continue;
        let target = current.find((g) => (g.matcher ?? '') === (group.matcher ?? '') && Array.isArray(g.hooks));
        if (!target) {
          target = group.matcher === undefined ? { hooks: [] } : { matcher: group.matcher, hooks: [] };
          current.push(target);
        }
        target.hooks.push({ ...hook });
        changed = true;
      }
    }
  }
  return { settings, changed };
}

/* ─────────────────────────────── init ────────────────────────────────── */

export function skillNames(): string[] {
  return Object.keys(TEMPLATE_FILES)
    .map((key) => /^skills\/([^/]+)\/SKILL\.md$/.exec(key)?.[1])
    .filter((name): name is string => Boolean(name))
    .sort();
}

export function runInit(opts: InitOptions): InitAction[] {
  const { root, hub, projectId, force } = opts;
  const vars = { hub, projectId };
  const actions: InitAction[] = [];

  // qa/jules.config.json: наявний не затираємо — лише hub і projectId.
  const configFile = path.join(root, CONFIG_PATH);
  const existingConfig = force ? null : readJsonObject(configFile, CONFIG_PATH);
  if (existingConfig) {
    const next = { ...existingConfig, hub, projectId };
    actions.push(writeManaged(root, CONFIG_PATH, json(next), { owned: true }));
  } else {
    const filled = JSON.parse(fill(template('templates/jules.config.json'), vars)) as unknown;
    actions.push(writeManaged(root, CONFIG_PATH, json(filled), { owned: true }));
  }

  actions.push(writeManaged(root, 'qa/conventions.md', template('templates/conventions.md'), { owned: false, force }));

  // .mcp.json: сервер `jules` — наш, решту серверів не чіпаємо.
  const mcp = readJsonObject(path.join(root, '.mcp.json'), '.mcp.json') ?? {};
  const servers = (mcp.mcpServers && typeof mcp.mcpServers === 'object' ? mcp.mcpServers : {}) as Record<string, unknown>;
  actions.push(
    writeManaged(root, '.mcp.json', json({ ...mcp, mcpServers: { ...servers, jules: { type: 'http', url: `${hub}/mcp` } } }), { owned: true }),
  );

  const agentsCurrent = readIfExists(path.join(root, 'AGENTS.md')) ?? '';
  actions.push(
    writeManaged(root, 'AGENTS.md', upsertMarkedSection(agentsCurrent, fill(template('templates/AGENTS.section.md'), vars)), { owned: true }),
  );

  for (const name of skillNames()) {
    actions.push(writeManaged(root, `.claude/skills/${name}/SKILL.md`, template(`skills/${name}/SKILL.md`), { owned: true }));
  }

  const hooksSpec = (JSON.parse(template('hooks/hooks.json')) as { hooks: HooksSpec }).hooks;
  const settingsRel = '.claude/settings.json';
  const existingSettings = readJsonObject(path.join(root, settingsRel), settingsRel);
  const merged = mergeHookSettings(existingSettings, hooksSpec);
  actions.push(
    merged.changed
      ? writeManaged(root, settingsRel, json(merged.settings), { owned: true })
      : { path: settingsRel, action: 'unchanged' },
  );

  actions.push(copySelf(root, opts.selfPath));

  actions.push(writeManaged(root, '.github/workflows/qa-ci.yml', template('github/qa-ci.yml'), { owned: false, force }));

  // Згенеровані файли згортаються в диффах PR на GitHub.
  const attrsRel = '.gitattributes';
  const attrs = readIfExists(path.join(root, attrsRel)) ?? '';
  const wanted = ['QA_STATUS.md linguist-generated=true', 'qa/bin/jules-qa.mjs linguist-generated=true'];
  const missing = wanted.filter((line) => !attrs.split('\n').some((l) => l.trim() === line));
  actions.push(
    missing.length
      ? writeManaged(root, attrsRel, `${attrs.trimEnd() ? `${attrs.trimEnd()}\n` : ''}${missing.join('\n')}\n`, { owned: true })
      : { path: attrsRel, action: 'unchanged' },
  );

  return actions;
}

function copySelf(root: string, selfPath: string | undefined): InitAction {
  const rel = 'qa/bin/jules-qa.mjs';
  if (!selfPath || !/\.m?js$/.test(selfPath) || !fs.existsSync(selfPath)) {
    return { path: rel, action: 'skipped', note: 'CLI запущено не з бандла — зберіть його (npm run cli:build) і запустіть init з dist/qa-cli/jules-qa.mjs' };
  }
  const content = fs.readFileSync(selfPath);
  const target = path.join(root, rel);
  const current = fs.existsSync(target) ? fs.readFileSync(target) : null;
  if (current && current.equals(content)) return { path: rel, action: 'unchanged' };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  fs.chmodSync(target, 0o755);
  return { path: rel, action: current ? 'updated' : 'created' };
}

export const initCommand: CommandHandler = async (ctx: CliContext, args) => {
  const hubRaw = flagString(args, 'hub') ?? ctx.env.JULES_URL;
  const projectId = (flagString(args, 'project') ?? ctx.env.JULES_PROJECT)?.trim();
  if (!hubRaw) throw new UsageError('Вкажіть адресу Jules: --hub https://<mac>.<tailnet>.ts.net');
  if (!projectId) throw new UsageError('Вкажіть проєкт Jules: --project <id>');
  const hub = hubRaw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+/i.test(hub)) throw new UsageError(`--hub має бути URL (http:// або https://), отримано «${hubRaw}».`);

  const root = findRepoRoot(ctx.cwd);
  const actions = runInit({ root, hub, projectId, force: flagBool(args, 'force'), selfPath: ctx.selfPath });
  println(ctx, `Jules QA: підключення ${root} до ${hub} (проєкт ${projectId})`);
  for (const action of actions) {
    println(ctx, `  ${ACTION_LABEL[action.action]}  ${action.path}${action.note ? ` — ${action.note}` : ''}`);
  }
  println(ctx);
  println(ctx, 'Далі: перевірте reports і commands у qa/jules.config.json, додайте в GitHub vars.JULES_URL,');
  println(ctx, 'secrets.JULES_TOKEN, secrets.TS_OAUTH_CLIENT_ID і secrets.TS_OAUTH_SECRET, закомітьте зміни.');
  return 0;
};
