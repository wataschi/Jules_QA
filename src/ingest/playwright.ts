/**
 * Playwright JSON reporter → `ParsedTestResult[]`.
 *
 * Структура: `suites[]` (кореневий — файл) → вкладені `suites[]` (describe) →
 * `specs[]` (test) → `tests[]` (по одному на project) → `results[]` (спроби).
 * Кожен project — окремий результат: chromium може пройти, а webkit упасти.
 *
 * `file` у звіті відносний до `config.rootDir` (це testDir, наприклад
 * `<repo>/e2e`), тому, якщо можна, переводимо його у шлях від кореня репо.
 */
import path from 'node:path';
import { isAbsolutePath, normalizePath, relativeTo, toRepoPath } from './glob.js';
import {
  asNumber,
  asString,
  cleanError,
  isRecord,
  parseJsonReport,
  ReportParseError,
  type ParsedTestResult,
  type PathOptions,
} from './types.js';

const LABEL = 'Playwright JSON';
const FULL_NAME_SEPARATOR = ' > ';

interface Context {
  configRoot?: string;
  repoRoot: string;
  projectNames: Map<string, string>;
  multiProject: boolean;
  out: ParsedTestResult[];
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function resolveFile(rawFile: string, ctx: Context): string {
  const file = normalizePath(rawFile);
  const absolute = isAbsolutePath(file)
    ? file
    : ctx.configRoot
      ? normalizePath(path.posix.join(normalizePath(ctx.configRoot), file))
      : undefined;
  if (absolute) {
    const fromRepo = relativeTo(absolute, ctx.repoRoot);
    if (fromRepo) return fromRepo;
  }
  if (isAbsolutePath(file) && ctx.configRoot) {
    return relativeTo(file, ctx.configRoot) ?? toRepoPath(file, ctx.repoRoot);
  }
  return file;
}

function errorOf(result: Record<string, unknown>): string | undefined {
  // `error` зазвичай дублює `errors[0]`, але з ANSI-кольорами — порівнюємо очищені.
  const parts: string[] = [];
  const add = (item: unknown) => {
    const message = isRecord(item) ? cleanError(asString(item.message) ?? asString(item.value)) : undefined;
    if (message && !parts.includes(message)) parts.push(message);
  };
  add(result.error);
  list(result.errors).forEach(add);
  return cleanError(parts.join('\n\n'));
}

function statusOf(
  test: Record<string, unknown>,
  last: Record<string, unknown> | undefined,
): ParsedTestResult['status'] {
  switch (asString(test.status)) {
    case 'expected':
    case 'flaky':
      return asString(last?.status) === 'skipped' ? 'skipped' : 'passed';
    case 'unexpected':
      return 'failed';
    case 'skipped':
      return 'skipped';
    default:
      break;
  }
  switch (asString(last?.status)) {
    case 'passed':
      return 'passed';
    case 'failed':
    case 'timedOut':
    case 'interrupted':
      return 'failed';
    default:
      return 'skipped';
  }
}

function visitSpec(spec: Record<string, unknown>, titles: string[], suiteFile: string | undefined, ctx: Context): void {
  const title = asString(spec.title) ?? '';
  const rawFile = asString(spec.file) ?? suiteFile ?? '';
  const file = resolveFile(rawFile, ctx);
  const baseFullName = [...titles, title].join(FULL_NAME_SEPARATOR);

  for (const rawTest of list(spec.tests)) {
    if (!isRecord(rawTest)) continue;
    const results = list(rawTest.results).filter(isRecord);
    const last = results[results.length - 1];
    const projectId = asString(rawTest.projectId) ?? '';
    const project = asString(rawTest.projectName) || ctx.projectNames.get(projectId) || projectId;

    const parsed: ParsedTestResult = {
      file,
      name: title,
      fullName: ctx.multiProject && project ? `${baseFullName} [${project}]` : baseFullName,
      status: statusOf(rawTest, last),
      framework: 'playwright',
    };
    const duration = asNumber(last?.duration);
    if (duration !== undefined) parsed.durationMs = Math.round(duration);
    const retries = Math.max(results.length - 1, asNumber(last?.retry) ?? 0);
    if (retries > 0) parsed.retries = retries;
    if (parsed.status === 'failed' && last) {
      const error = errorOf(last);
      if (error) parsed.error = error;
    }
    ctx.out.push(parsed);
  }
}

function visitSuite(suite: Record<string, unknown>, titles: string[], inheritedFile: string | undefined, ctx: Context, isRoot: boolean): void {
  const file = asString(suite.file) ?? inheritedFile;
  const title = asString(suite.title) ?? '';
  // Кореневий suite — це сам файл, його title дублював би `file`.
  const nextTitles = isRoot || !title ? titles : [...titles, title];
  for (const spec of list(suite.specs)) {
    if (isRecord(spec)) visitSpec(spec, nextTitles, file, ctx);
  }
  for (const child of list(suite.suites)) {
    if (isRecord(child)) visitSuite(child, nextTitles, file, ctx, false);
  }
}

function collectProjects(suites: unknown[], names: Set<string>): void {
  for (const suite of suites) {
    if (!isRecord(suite)) continue;
    for (const spec of list(suite.specs)) {
      if (!isRecord(spec)) continue;
      for (const test of list(spec.tests)) {
        if (!isRecord(test)) continue;
        const name = asString(test.projectName) || asString(test.projectId);
        if (name !== undefined) names.add(name);
      }
    }
    collectProjects(list(suite.suites), names);
  }
}

export function parsePlaywrightJson(content: string, options: PathOptions = {}): ParsedTestResult[] {
  const data = parseJsonReport(content, 'playwright-json', LABEL);
  if (data === undefined) return [];
  if (!isRecord(data) || !Array.isArray(data.suites)) {
    throw new ReportParseError('playwright-json', `${LABEL}: немає масиву «suites» — це не звіт JSON-репортера Playwright`);
  }
  const config = isRecord(data.config) ? data.config : {};
  const projectNames = new Map<string, string>();
  for (const project of list(config.projects)) {
    if (!isRecord(project)) continue;
    const name = asString(project.name) ?? '';
    projectNames.set(asString(project.id) ?? name, name);
  }
  const seenProjects = new Set<string>();
  collectProjects(data.suites, seenProjects);

  const ctx: Context = {
    configRoot: asString(config.rootDir),
    repoRoot: options.rootDir ?? process.cwd(),
    projectNames,
    multiProject: Math.max(projectNames.size, seenProjects.size) > 1,
    out: [],
  };
  for (const suite of data.suites) {
    if (isRecord(suite)) visitSuite(suite, [], undefined, ctx, true);
  }
  return ctx.out;
}
