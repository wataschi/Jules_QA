/**
 * Stryker `mutation.json` (mutation-testing-report-schema v1/v2) → `MutationFile[]`.
 *
 * Обидві версії мають `files[path].mutants[].status`; відрізняються додатковими
 * полями (v2: `testFiles`, `coveredBy`, `killedBy`), які нам не потрібні.
 * Score рахуємо як Stryker: (killed + timeout) / (killed + timeout + survived +
 * noCoverage) · 100. Мутанти з CompileError/RuntimeError/Ignored/Pending у
 * знаменник не йдуть, але входять у `total`.
 */
import { isAbsolutePath, normalizePath, relativeTo } from './glob.js';
import {
  asString,
  compareStrings,
  isRecord,
  parseJsonReport,
  ReportParseError,
  type MutationFile,
  type PathOptions,
} from './types.js';

const LABEL = 'Stryker mutation.json';

export function parseStrykerReport(content: string, options: PathOptions = {}): MutationFile[] {
  const data = parseJsonReport(content, 'stryker', LABEL);
  if (data === undefined) return [];
  if (!isRecord(data) || !isRecord(data.files)) {
    throw new ReportParseError('stryker', `${LABEL}: немає об'єкта «files» — це не звіт Stryker`);
  }
  const projectRoot = asString(data.projectRoot);
  const rootDir = options.rootDir ?? process.cwd();
  const resolve = (rawPath: string): string => {
    const file = normalizePath(rawPath);
    if (!isAbsolutePath(file)) return file;
    return relativeTo(file, rootDir) ?? (projectRoot ? relativeTo(file, projectRoot) : undefined) ?? file;
  };
  const byPath = new Map<string, MutationFile>();

  for (const [rawPath, entry] of Object.entries(data.files)) {
    if (!isRecord(entry)) continue;
    const filePath = resolve(rawPath);
    const item = byPath.get(filePath) ?? {
      path: filePath,
      killed: 0,
      survived: 0,
      noCoverage: 0,
      timeout: 0,
      total: 0,
      score: null,
    };
    for (const mutant of Array.isArray(entry.mutants) ? entry.mutants : []) {
      if (!isRecord(mutant)) continue;
      item.total += 1;
      switch (asString(mutant.status)) {
        case 'Killed':
          item.killed += 1;
          break;
        case 'Survived':
          item.survived += 1;
          break;
        case 'NoCoverage':
          item.noCoverage += 1;
          break;
        case 'Timeout':
          item.timeout += 1;
          break;
        default:
          break;
      }
    }
    byPath.set(filePath, item);
  }

  const out = [...byPath.values()];
  for (const item of out) {
    const detected = item.killed + item.timeout;
    const valid = detected + item.survived + item.noCoverage;
    item.score = valid === 0 ? null : Math.round((detected / valid) * 10000) / 100;
  }
  return out.sort((a, b) => compareStrings(a.path, b.path));
}
