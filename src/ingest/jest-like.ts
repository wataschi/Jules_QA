/**
 * Jest `--json` і Vitest `--reporter=json` → `ParsedTestResult[]`.
 *
 * Vitest навмисно пише jest-сумісний формат: `testResults[].assertionResults[]`
 * з `ancestorTitles`, `title`, `status`, `duration`, `failureMessages`.
 * Відрізняємо їх за слідами: у Vitest в асерті є `meta`, у Jest —
 * `numPassingAsserts`/`invocations`.
 *
 * `testResults[].name` — абсолютний шлях на машині CI, тому відрізаємо корінь
 * репо (`rootDir`, дефолт — `process.cwd()`, у CI це checkout).
 */
import { toRepoPath } from './glob.js';
import {
  asNumber,
  asString,
  cleanError,
  isRecord,
  parseJsonReport,
  ReportParseError,
  type Framework,
  type ParsedTestResult,
  type PathOptions,
} from './types.js';

export interface JestLikeOptions extends PathOptions {
  /** Перекриває автовизначення jest/vitest. */
  framework?: Extract<Framework, 'jest' | 'vitest'>;
}

const LABEL = 'Jest/Vitest JSON';
const FULL_NAME_SEPARATOR = ' > ';

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function detectFramework(testResults: unknown[]): Extract<Framework, 'jest' | 'vitest'> {
  for (const file of testResults) {
    if (!isRecord(file)) continue;
    for (const assertion of list(file.assertionResults)) {
      if (!isRecord(assertion)) continue;
      if ('meta' in assertion) return 'vitest';
      if ('numPassingAsserts' in assertion || 'invocations' in assertion) return 'jest';
    }
  }
  return 'jest';
}

function mapStatus(status: string | undefined): ParsedTestResult['status'] {
  if (status === 'passed') return 'passed';
  if (status === 'failed') return 'failed';
  // pending | skipped | todo | disabled | focused-out
  return 'skipped';
}

export function parseJestLikeJson(content: string, options: JestLikeOptions = {}): ParsedTestResult[] {
  const data = parseJsonReport(content, 'jest-json', LABEL);
  if (data === undefined) return [];
  if (!isRecord(data) || !Array.isArray(data.testResults)) {
    throw new ReportParseError('jest-json', `${LABEL}: немає масиву «testResults» — це не звіт Jest/Vitest --json`);
  }
  const framework = options.framework ?? detectFramework(data.testResults);
  const rootDir = options.rootDir ?? process.cwd();
  const out: ParsedTestResult[] = [];

  for (const fileResult of data.testResults) {
    if (!isRecord(fileResult)) continue;
    const file = toRepoPath(asString(fileResult.name) ?? asString(fileResult.testFilePath) ?? '', rootDir);
    for (const assertion of list(fileResult.assertionResults)) {
      if (!isRecord(assertion)) continue;
      const title = asString(assertion.title) ?? '';
      const ancestors = list(assertion.ancestorTitles).filter(
        (item): item is string => typeof item === 'string' && item.length > 0,
      );
      const result: ParsedTestResult = {
        file,
        name: title,
        fullName: [...ancestors, title].join(FULL_NAME_SEPARATOR),
        status: mapStatus(asString(assertion.status)),
        framework,
      };
      const duration = asNumber(assertion.duration);
      if (duration !== undefined) result.durationMs = Math.round(duration);
      if (result.status === 'failed') {
        const messages = list(assertion.failureMessages).filter((item): item is string => typeof item === 'string');
        const error = cleanError(messages.join('\n\n'));
        if (error) result.error = error;
      }
      const invocations = asNumber(assertion.invocations);
      const retries = Math.max(
        invocations !== undefined ? invocations - 1 : 0,
        list(assertion.retryReasons).length,
      );
      if (retries > 0) result.retries = retries;
      out.push(result);
    }
  }
  return out;
}
