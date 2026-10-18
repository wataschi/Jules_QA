/**
 * `qa/manifest.json` — каталог «тест ↔ кейс ↔ рівень ↔ файл».
 *
 * Маніфест лежить у репо продукту і перевіряється pre-commit-ом на свіжість,
 * тому вивід мусить бути байт-у-байт однаковим для однакового набору тестів:
 * сортування без локалі, фіксований порядок ключів, `\n` наприкінці.
 * Ключ тесту — sha256(`file::fullName`): стабільний, поки тест не перейменували.
 */
import { createHash } from 'node:crypto';
import { extractCaseIds } from './case-ids.js';
import { detectLevel } from './levels.js';
import {
  compareStrings,
  isRecord,
  ReportParseError,
  type Framework,
  type LevelConfig,
  type Manifest,
  type ManifestTest,
  type ParsedTestResult,
  type TestLevel,
} from './types.js';

export function testKey(file: string, fullName: string): string {
  return createHash('sha256').update(`${file}::${fullName}`).digest('hex').slice(0, 16);
}

function compareTests(a: ManifestTest, b: ManifestTest): number {
  return compareStrings(a.file, b.file) || compareStrings(a.fullName, b.fullName) || compareStrings(a.key, b.key);
}

export function buildManifest(results: ParsedTestResult[], config?: LevelConfig): Manifest {
  const byKey = new Map<string, ManifestTest>();
  for (const result of results) {
    const key = testKey(result.file, result.fullName);
    if (byKey.has(key)) continue;
    byKey.set(key, {
      key,
      file: result.file,
      name: result.name,
      fullName: result.fullName,
      caseIds: extractCaseIds(result.fullName),
      level: detectLevel(result.file, config),
      framework: result.framework,
    });
  }
  return { version: 1, tests: [...byKey.values()].sort(compareTests) };
}

function orderedTest(test: ManifestTest): ManifestTest {
  return {
    key: test.key,
    file: test.file,
    name: test.name,
    fullName: test.fullName,
    caseIds: [...test.caseIds],
    level: test.level,
    framework: test.framework,
  };
}

export function serializeManifest(manifest: Manifest): string {
  const ordered = { version: manifest.version, tests: manifest.tests.map(orderedTest) };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

const LEVELS = new Set<TestLevel>(['unit', 'integration', 'e2e', 'visual']);
const FRAMEWORKS = new Set<Framework>(['junit', 'playwright', 'vitest', 'jest', 'pytest', 'unknown']);

/** Читає `qa/manifest.json`; порожній файл — порожній маніфест. */
export function parseManifest(content: string): Manifest {
  if (!content.trim()) return { version: 1, tests: [] };
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ReportParseError('unknown', `Маніфест qa/manifest.json: не вдалося розібрати JSON — ${reason}`, {
      cause: error,
    });
  }
  if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.tests)) {
    throw new ReportParseError('unknown', 'Маніфест qa/manifest.json: очікувалось { "version": 1, "tests": [...] }');
  }
  const tests: ManifestTest[] = [];
  data.tests.forEach((raw, index) => {
    const ok =
      isRecord(raw) &&
      typeof raw.key === 'string' &&
      typeof raw.file === 'string' &&
      typeof raw.name === 'string' &&
      typeof raw.fullName === 'string' &&
      Array.isArray(raw.caseIds) &&
      raw.caseIds.every((id) => typeof id === 'string') &&
      LEVELS.has(raw.level as TestLevel) &&
      FRAMEWORKS.has(raw.framework as Framework);
    if (!ok) {
      throw new ReportParseError('unknown', `Маніфест qa/manifest.json: некоректний запис tests[${index}]`);
    }
    tests.push(orderedTest(raw as unknown as ManifestTest));
  });
  return { version: 1, tests };
}

function sameTest(a: ManifestTest, b: ManifestTest): boolean {
  return (
    a.file === b.file &&
    a.name === b.name &&
    a.fullName === b.fullName &&
    a.level === b.level &&
    a.framework === b.framework &&
    a.caseIds.length === b.caseIds.length &&
    a.caseIds.every((id, index) => id === b.caseIds[index])
  );
}

/** `changed` — той самий ключ, але інші поля (рівень, фреймворк, кейси); віддаємо версію `after`. */
export function diffManifest(
  before: Manifest,
  after: Manifest,
): { added: ManifestTest[]; removed: ManifestTest[]; changed: ManifestTest[] } {
  const beforeByKey = new Map(before.tests.map((test) => [test.key, test]));
  const afterByKey = new Map(after.tests.map((test) => [test.key, test]));
  const added: ManifestTest[] = [];
  const changed: ManifestTest[] = [];
  for (const [key, test] of afterByKey) {
    const previous = beforeByKey.get(key);
    if (!previous) added.push(test);
    else if (!sameTest(previous, test)) changed.push(test);
  }
  const removed = [...beforeByKey.values()].filter((test) => !afterByKey.has(test.key));
  return {
    added: added.sort(compareTests),
    removed: removed.sort(compareTests),
    changed: changed.sort(compareTests),
  };
}
