/**
 * Конфіг `jules-qa` у репо продукту: `qa/jules.config.json` плюс перекриття з оточення
 * (`JULES_URL`, `JULES_TOKEN`, `JULES_PROJECT`). Токен у файл не пишеться ніколи —
 * лише з оточення (секрет CI або локальний env).
 *
 * Корінь репо шукаємо вгору від cwd до теки з `qa/jules.config.json` (або `.git`), бо хуки
 * агента й люди можуть запускати CLI з підкаталогу.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { TestLevel } from '../ingest/index.js';
import type { Env } from './context.js';

export const CONFIG_PATH = 'qa/jules.config.json';

export const DEFAULT_TEST_FILE_GLOBS = ['**/*.test.*', '**/*.spec.*', '**/test_*.py', '**/*_test.py', 'tests/**', 'e2e/**'];

export interface JulesConfig {
  hub?: string;
  projectId?: string;
  reports: { tests: string[]; coverage: string[]; mutation: string[] };
  levels?: Partial<Record<TestLevel, string[]>>;
  testFileGlobs: string[];
  commands: { testFile?: string; related?: string };
}

export interface ResolvedConfig extends JulesConfig {
  /** Корінь репо продукту (абсолютний шлях). */
  root: string;
  /** Чи знайдено файл конфігу (без нього працюють лише env і дефолти). */
  fileFound: boolean;
  token?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Тека з `qa/jules.config.json`, інакше з `.git`, інакше сам `start`. */
export function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  let gitRoot: string | null = null;
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_PATH))) return dir;
    if (!gitRoot && fs.existsSync(path.join(dir, '.git'))) gitRoot = dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return gitRoot ?? path.resolve(start);
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[];
  throw new ConfigError(`${CONFIG_PATH}: поле «${field}» має бути рядком або списком рядків.`);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new ConfigError(`${CONFIG_PATH}: поле «${field}» має бути рядком.`);
  return value;
}

const LEVELS: TestLevel[] = ['unit', 'integration', 'e2e', 'visual'];

/** Розбір і перевірка вмісту файлу конфігу (без env). */
export function parseConfig(raw: string): JulesConfig {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`${CONFIG_PATH} не є валідним JSON: ${(error as Error).message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ConfigError(`${CONFIG_PATH} має містити JSON-об'єкт.`);
  }
  const obj = data as Record<string, unknown>;
  const reports = (obj.reports ?? {}) as Record<string, unknown>;
  const commands = (obj.commands ?? {}) as Record<string, unknown>;

  let levels: JulesConfig['levels'];
  if (obj.levels !== undefined) {
    if (!obj.levels || typeof obj.levels !== 'object') {
      throw new ConfigError(`${CONFIG_PATH}: поле «levels» має бути об'єктом.`);
    }
    levels = {};
    for (const [level, globs] of Object.entries(obj.levels as Record<string, unknown>)) {
      if (!LEVELS.includes(level as TestLevel)) {
        throw new ConfigError(`${CONFIG_PATH}: невідомий рівень «${level}» у levels (є: ${LEVELS.join(', ')}).`);
      }
      levels[level as TestLevel] = stringList(globs, `levels.${level}`);
    }
  }

  const testFileGlobs = stringList(obj.testFileGlobs, 'testFileGlobs');
  return {
    hub: optionalString(obj.hub, 'hub'),
    projectId: optionalString(obj.projectId, 'projectId'),
    reports: {
      tests: stringList(reports.tests, 'reports.tests'),
      coverage: stringList(reports.coverage, 'reports.coverage'),
      mutation: stringList(reports.mutation, 'reports.mutation'),
    },
    levels,
    testFileGlobs: testFileGlobs.length ? testFileGlobs : DEFAULT_TEST_FILE_GLOBS,
    commands: {
      testFile: optionalString(commands.testFile, 'commands.testFile'),
      related: optionalString(commands.related, 'commands.related'),
    },
  };
}

function normalizeHub(hub: string | undefined): string | undefined {
  if (!hub) return undefined;
  const trimmed = hub.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new ConfigError(`Адреса хаба «${hub}» має починатися з http:// або https://.`);
  }
  return trimmed;
}

/** Читає конфіг з кореня репо (шукаючи вгору від `cwd`) і накладає env. */
export function loadConfig(opts: { cwd: string; env: Env; root?: string }): ResolvedConfig {
  const root = opts.root ?? findRepoRoot(opts.cwd);
  const file = path.join(root, CONFIG_PATH);
  let base: JulesConfig;
  let fileFound = false;
  if (fs.existsSync(file)) {
    base = parseConfig(fs.readFileSync(file, 'utf-8'));
    fileFound = true;
  } else {
    base = parseConfig('{}');
  }
  return {
    ...base,
    root,
    fileFound,
    hub: normalizeHub(opts.env.JULES_URL?.trim() || base.hub),
    projectId: opts.env.JULES_PROJECT?.trim() || base.projectId,
    token: opts.env.JULES_TOKEN?.trim() || undefined,
  };
}

/** Адреса хаба для команд, яким потрібна мережа. */
export function requireHub(config: ResolvedConfig): string {
  if (!config.hub) {
    throw new ConfigError(
      `Не задано адресу Jules: вкажіть "hub" у ${CONFIG_PATH} або змінну JULES_URL ` +
        '(або запустіть `jules-qa init --hub <url> --project <id>`).',
    );
  }
  return config.hub;
}

export function requireProject(config: ResolvedConfig): string {
  if (!config.projectId) {
    throw new ConfigError(`Не задано проєкт Jules: вкажіть "projectId" у ${CONFIG_PATH} або змінну JULES_PROJECT.`);
  }
  return config.projectId;
}
