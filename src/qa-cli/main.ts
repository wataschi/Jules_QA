/**
 * `jules-qa` — детермінований CLI Jules QA для репо продукту: маніфест тестів, відправка
 * результатів CI в хаб, хуки агента, задачі QA, резервування ID кейсів. Моделі не викликає.
 *
 * Збирається esbuild-ом в один файл без залежностей (`scripts/build-qa-cli.mjs`) і живе
 * в репо продукту як `qa/bin/jules-qa.mjs`. Розбір аргументів власний, без бібліотек:
 * у кожної команди — явний перелік прапорців, невідомий прапорець — помилка, а не тиша.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { redactSecrets } from '../integrations/errors.js';
import { ConfigError } from './config.js';
import { createDefaultContext, eprintln, println, type CliContext } from './context.js';
import { GitError } from './git.js';
import { HubError, HubUnavailable } from './hub.js';
import { affectedCommand } from './commands/affected.js';
import { assertGuardCommand } from './commands/assert-guard.js';
import { caseCommand } from './commands/case.js';
import { UsageError, type CommandHandler, type ParsedArgs } from './commands/common.js';
import { prEventCommand, pushCheckCommand } from './commands/github-events.js';
import { hookCommand } from './commands/hook.js';
import { importCommand } from './commands/import.js';
import { inboxCommand } from './commands/inbox.js';
import { initCommand } from './commands/init.js';
import { manifestCommand } from './commands/manifest.js';
import { prCommentCommand, statusCommand } from './commands/status.js';
import { syncCommand } from './commands/sync.js';

export const VERSION = '0.1.0';

export type FlagType = 'string' | 'boolean' | 'list';

interface CommandSpec {
  summary: string;
  usage: string;
  flags: Record<string, FlagType>;
  run: CommandHandler;
}

export const COMMANDS: Record<string, CommandSpec> = {
  init: {
    summary: 'підключити репо до Jules: конфіг, конвенції, .mcp.json, AGENTS.md, скіли, хуки, CI',
    usage: 'init --hub <url> --project <id> [--force]',
    flags: { hub: 'string', project: 'string', force: 'boolean' },
    run: initCommand,
  },
  manifest: {
    summary: 'зібрати qa/manifest.json зі звітів тестів; --check — exit 1, якщо застарів',
    usage: 'manifest [--check]',
    flags: { check: 'boolean' },
    run: manifestCommand,
  },
  sync: {
    summary: 'надіслати результати, покриття, мутації й зміни асертів у Jules',
    usage: 'sync [--event pr|main|local] [--source ci|local] [--sha <sha>] [--branch <name>] [--pr <N>] [--run-url <url>] [--base origin/main]',
    flags: { event: 'string', source: 'string', sha: 'string', branch: 'string', pr: 'string', 'run-url': 'string', base: 'string' },
    run: syncCommand,
  },
  status: {
    summary: 'отримати QA_STATUS.md з Jules; пише файл лише якщо вміст змінився',
    usage: 'status [--out QA_STATUS.md] [--branch main]',
    flags: { out: 'string', branch: 'string' },
    run: statusCommand,
  },
  'pr-comment': {
    summary: 'отримати текст PR-коментаря з Jules',
    usage: 'pr-comment --pr <N> [--sha <sha>] [--out <file>]',
    flags: { pr: 'string', sha: 'string', out: 'string' },
    run: prCommentCommand,
  },
  affected: {
    summary: "змінені файли й команда прогону пов'язаних тестів",
    usage: 'affected [--base origin/main] [--json]',
    flags: { base: 'string', json: 'boolean' },
    run: affectedCommand,
  },
  hook: {
    summary: 'хуки Claude Code (JSON події на stdin)',
    usage: 'hook post-edit|stop|session-start',
    flags: {},
    run: hookCommand,
  },
  inbox: {
    summary: 'задачі QA для змінених файлів; --brief — один рядок для старту сесії',
    usage: 'inbox [--brief] [--base origin/main]',
    flags: { brief: 'boolean', base: 'string' },
    run: inboxCommand,
  },
  case: {
    summary: 'зарезервувати ID кейса для нового тесту (чернетка йде на погодження QA)',
    usage: 'case reserve --section <code> --title "…" [--kind <kind>] [--priority P1..P4] [--check "…"]… [--preconditions "…"]',
    flags: { section: 'string', title: 'string', kind: 'string', priority: 'string', check: 'list', preconditions: 'string' },
    run: caseCommand,
  },
  'assert-guard': {
    summary: 'охоронець асертів: змінені наявні перевірки в диффі (exit 0 завжди)',
    usage: 'assert-guard [--base origin/main] [--json]',
    flags: { base: 'string', json: 'boolean' },
    run: assertGuardCommand,
  },
  'push-check': {
    summary: 'CI на push у main: чи прийшов коміт через злитий PR',
    usage: 'push-check [--sha <sha>] [--branch main]',
    flags: { sha: 'string', branch: 'string' },
    run: pushCheckCommand,
  },
  'pr-event': {
    summary: 'повідомити Jules про відкриття, злиття чи закриття PR (з GITHUB_EVENT_PATH)',
    usage: 'pr-event [--state merged|closed|opened] [--pr <N>]',
    flags: { state: 'string', pr: 'string' },
    run: prEventCommand,
  },
  import: {
    summary: 'запасний імпорт сторінки Confluence з цієї машини (потрібні CONFLUENCE_*)',
    usage: 'import <confluence-url>',
    flags: {},
    run: importCommand,
  },
};

/** Розбір `argv` за переліком прапорців: `--k v`, `--k=v`, булеві `--flag`, `--` завершує прапорці. */
export function parseArgs(argv: readonly string[], spec: Record<string, FlagType>): ParsedArgs {
  const positionals: string[] = [];
  const flags: ParsedArgs['flags'] = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--') || arg === '-') {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    const type = spec[name];
    if (!type) {
      const known = Object.keys(spec).map((k) => `--${k}`).join(', ');
      throw new UsageError(`Невідомий прапорець --${name}.${known ? ` Доступні: ${known}.` : ''}`);
    }
    if (type === 'boolean') {
      if (eq !== -1) {
        const raw = arg.slice(eq + 1);
        if (!['true', 'false'].includes(raw)) throw new UsageError(`--${name} не приймає значення «${raw}».`);
        flags[name] = raw === 'true';
      } else {
        flags[name] = true;
      }
      continue;
    }
    let value: string;
    if (eq !== -1) value = arg.slice(eq + 1);
    else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new UsageError(`Прапорцю --${name} потрібне значення.`);
      value = next;
      i++;
    }
    if (type === 'list') {
      const prev = flags[name];
      flags[name] = [...(Array.isArray(prev) ? prev : []), value];
    } else {
      flags[name] = value;
    }
  }
  return { positionals, flags };
}

export function helpText(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  const lines = [
    `jules-qa ${VERSION} — CLI Jules QA для репо продукту (без моделі, однаково в CI, локально й у хуках)`,
    '',
    'Використання: jules-qa <команда> [прапорці]',
    '',
    'Команди:',
    ...Object.entries(COMMANDS).map(([name, spec]) => `  ${name.padEnd(width)}  ${spec.summary}`),
    '',
    'Оточення: JULES_URL, JULES_TOKEN, JULES_PROJECT перекривають qa/jules.config.json.',
    'Довідка команди: jules-qa <команда> --help',
  ];
  return lines.join('\n');
}

function commandHelp(name: string, spec: CommandSpec): string {
  return [`jules-qa ${spec.usage}`, '', `  ${spec.summary}`].join('\n');
}

/** Точка входу без процесу: повертає код виходу. */
export async function runCli(argv: readonly string[], overrides: Partial<CliContext> = {}): Promise<number> {
  const ctx = createDefaultContext(overrides);
  const [name, ...rest] = argv;
  if (!name || name === '--help' || name === '-h' || name === 'help') {
    println(ctx, helpText());
    return 0;
  }
  if (name === '--version' || name === '-v') {
    println(ctx, VERSION);
    return 0;
  }
  const spec = COMMANDS[name];
  if (!spec) {
    eprintln(ctx, `Невідома команда «${name}».`);
    eprintln(ctx, helpText());
    return 1;
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    println(ctx, commandHelp(name, spec));
    return 0;
  }
  try {
    return await spec.run(ctx, parseArgs(rest, spec.flags));
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    if (error instanceof UsageError) {
      eprintln(ctx, message);
      eprintln(ctx, `Використання: jules-qa ${spec.usage}`);
      return 1;
    }
    if (error instanceof HubUnavailable || error instanceof HubError || error instanceof ConfigError || error instanceof GitError) {
      eprintln(ctx, message);
      return 1;
    }
    eprintln(ctx, `jules-qa ${name}: ${message}`);
    return 1;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  // `jules-qa … | head` закриває канал раніше — це не помилка CLI.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') process.exit(process.exitCode ?? 0);
      throw error;
    });
  }
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${redactSecrets(String(error?.stack ?? error))}\n`);
      process.exitCode = 1;
    },
  );
}
