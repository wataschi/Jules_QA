/**
 * Збір звітів раннерів у репо продукту: розгортання glob-ів із `reports.*` конфігу,
 * розбір через `src/ingest` і нормалізація шляхів до «відносно кореня репо».
 *
 * Шляхи нормалізуємо тут, а не покладаємося на парсер: Jest пише абсолютні шляхи раннера
 * (`/home/runner/work/app/app/src/a.test.ts`), lcov — теж. Ключ тесту рахується від шляху,
 * тож без нормалізації один тест мав би різні ключі в CI і локально.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  detectLevel,
  detectReportFormat,
  extractCaseIds,
  matchGlob,
  parseCobertura,
  parseLcov,
  parseStrykerReport,
  parseTestReport,
  testKey,
  type FileCoverage,
  type LevelConfig,
  type MutationFile,
  type ParsedTestResult,
  type TestLevel,
} from '../ingest/index.js';

const SKIP_DIRS = new Set(['node_modules', '.git']);
const MAX_WALK_FILES = 50_000;

export type IngestResult = ParsedTestResult & { key: string; caseIds: string[]; level: TestLevel };

function hasMagic(segment: string): boolean {
  return /[*?[]/.test(segment);
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

/** Розгортає glob-и відносно `root`; повертає відносні шляхи без дублів, відсортовані. */
export function expandGlobs(root: string, patterns: readonly string[]): string[] {
  const found = new Set<string>();
  for (const raw of patterns) {
    const pattern = toPosix(raw.trim()).replace(/^\.\//, '');
    if (!pattern) continue;
    const segments = pattern.split('/');
    const firstMagic = segments.findIndex(hasMagic);
    if (firstMagic === -1) {
      const full = path.join(root, pattern);
      if (fs.existsSync(full) && fs.statSync(full).isFile()) found.add(pattern);
      continue;
    }
    // Обходимо лише статичний префікс шаблону, а не весь репо.
    const prefix = segments.slice(0, firstMagic).join('/');
    const start = path.join(root, prefix);
    if (!fs.existsSync(start)) continue;
    let budget = MAX_WALK_FILES;
    const stack = [start];
    while (stack.length && budget > 0) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) stack.push(full);
        } else if (entry.isFile()) {
          budget--;
          const rel = toPosix(path.relative(root, full));
          if (matchGlob(pattern, rel)) found.add(rel);
        }
      }
    }
  }
  return [...found].sort();
}

/** Шлях зі звіту → відносно кореня репо, через '/'. */
export function repoRelative(root: string, file: string): string {
  const posix = toPosix(file).trim();
  const rootPosix = toPosix(path.resolve(root)).replace(/\/+$/, '');
  if (posix === rootPosix) return '';
  if (posix.startsWith(`${rootPosix}/`)) return posix.slice(rootPosix.length + 1);
  // Шлях раннера CI з іншим коренем (`/home/runner/work/app/app/…`) лишаємо як є: краще явно
  // чужий шлях, ніж тихо неправильний.
  return posix.replace(/^\.\//, '');
}

export interface CollectWarning {
  file: string;
  message: string;
}

export interface TestReports {
  files: string[];
  results: ParsedTestResult[];
  warnings: CollectWarning[];
}

export function collectTestResults(root: string, patterns: readonly string[]): TestReports {
  const files = expandGlobs(root, patterns);
  const results: ParsedTestResult[] = [];
  const warnings: CollectWarning[] = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(root, file), 'utf-8');
      for (const result of parseTestReport(file, content)) {
        results.push({ ...result, file: repoRelative(root, result.file) });
      }
    } catch (error) {
      warnings.push({ file, message: (error as Error).message });
    }
  }
  return { files, results, warnings };
}

export function collectCoverage(root: string, patterns: readonly string[]): { files: string[]; coverage: FileCoverage[]; warnings: CollectWarning[] } {
  const files = expandGlobs(root, patterns);
  const coverage: FileCoverage[] = [];
  const warnings: CollectWarning[] = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(root, file), 'utf-8');
      const format = detectReportFormat(file, content);
      const parsed =
        format === 'lcov' || (format === 'unknown' && /\.info$/i.test(file))
          ? parseLcov(content)
          : format === 'cobertura' || (format === 'unknown' && /\.xml$/i.test(file))
            ? parseCobertura(content)
            : null;
      if (!parsed) {
        warnings.push({ file, message: `невідомий формат покриття (${format}); очікується lcov або Cobertura` });
        continue;
      }
      for (const entry of parsed) coverage.push({ ...entry, path: repoRelative(root, entry.path) });
    } catch (error) {
      warnings.push({ file, message: (error as Error).message });
    }
  }
  return { files, coverage, warnings };
}

export function collectMutation(root: string, patterns: readonly string[]): { files: string[]; mutation: MutationFile[]; warnings: CollectWarning[] } {
  const files = expandGlobs(root, patterns);
  const mutation: MutationFile[] = [];
  const warnings: CollectWarning[] = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(root, file), 'utf-8');
      for (const entry of parseStrykerReport(content)) mutation.push({ ...entry, path: repoRelative(root, entry.path) });
    } catch (error) {
      warnings.push({ file, message: (error as Error).message });
    }
  }
  return { files, mutation, warnings };
}

/** Результат раннера → рядок інжесту з ключем, ID кейсів і рівнем. */
export function toIngestResults(results: readonly ParsedTestResult[], levels?: LevelConfig): IngestResult[] {
  return results.map((result) => ({
    ...result,
    key: testKey(result.file, result.fullName),
    caseIds: extractCaseIds(result.fullName),
    level: detectLevel(result.file, levels),
  }));
}

/** Чи шлях — тест-файл за `testFileGlobs` конфігу. */
export function isTestFile(file: string, globs: readonly string[]): boolean {
  const rel = toPosix(file).replace(/^\.\//, '');
  return globs.some((glob) => matchGlob(glob, rel));
}
