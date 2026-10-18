import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildManifest,
  diffManifest,
  parseManifest,
  ReportParseError,
  serializeManifest,
  testKey,
  type ParsedTestResult,
} from '../../../src/ingest/index.js';

const results: ParsedTestResult[] = [
  { file: 'src/b.test.ts', name: 'рахує', fullName: 'Б > рахує', status: 'passed', framework: 'vitest' },
  { file: 'e2e/acts.spec.ts', name: 'CYBER-ACT-014 акт', fullName: 'Акти > CYBER-ACT-014 акт [chromium]', status: 'failed', framework: 'playwright' },
  { file: 'src/a.test.ts', name: 'CYBER-ACT-015 сума', fullName: 'А > CYBER-ACT-015 сума', status: 'passed', framework: 'vitest' },
  { file: 'src/a.test.ts', name: 'CYBER-ACT-015 сума', fullName: 'А > CYBER-ACT-015 сума', status: 'failed', framework: 'vitest' },
  { file: 'tests/unit/test_x.py', name: 'test_CYBER_ACT_016_x', fullName: 'test_CYBER_ACT_016_x', status: 'passed', framework: 'pytest' },
];

describe('testKey', () => {
  it('це перші 16 hex від sha256(file::fullName)', () => {
    const expected = createHash('sha256').update('src/a.test.ts::А > сума').digest('hex').slice(0, 16);
    expect(testKey('src/a.test.ts', 'А > сума')).toBe(expected);
    expect(testKey('src/a.test.ts', 'А > сума')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('buildManifest', () => {
  const manifest = buildManifest(results, { levels: { e2e: ['e2e/**'] } });

  it('сортує за file, fullName і дедуплікує за key', () => {
    expect(manifest.version).toBe(1);
    expect(manifest.tests.map((test) => test.file)).toEqual([
      'e2e/acts.spec.ts',
      'src/a.test.ts',
      'src/b.test.ts',
      'tests/unit/test_x.py',
    ]);
  });

  it('витягує caseIds і визначає рівень', () => {
    expect(manifest.tests[0]).toMatchObject({ caseIds: ['CYBER-ACT-014'], level: 'e2e', framework: 'playwright' });
    expect(manifest.tests[3]).toMatchObject({ caseIds: ['CYBER-ACT-016'], level: 'unit', framework: 'pytest' });
    expect(manifest.tests[2]!.caseIds).toEqual([]);
  });

  it('не залежить від порядку вхідних результатів', () => {
    const reversed = buildManifest([...results].reverse(), { levels: { e2e: ['e2e/**'] } });
    expect(serializeManifest(reversed)).toBe(serializeManifest(manifest));
  });

  it('для порожнього списку дає порожній маніфест', () => {
    expect(buildManifest([])).toEqual({ version: 1, tests: [] });
  });
});

describe('serializeManifest / parseManifest', () => {
  it('пише фіксований порядок ключів, відступ 2 і \\n наприкінці', () => {
    const manifest = buildManifest(results.slice(0, 1));
    const shuffled = {
      version: 1 as const,
      tests: manifest.tests.map((test) => ({
        framework: test.framework,
        level: test.level,
        caseIds: test.caseIds,
        fullName: test.fullName,
        name: test.name,
        file: test.file,
        key: test.key,
      })),
    };
    const text = serializeManifest(shuffled);
    expect(text.endsWith('}\n')).toBe(true);
    expect(Object.keys(JSON.parse(text).tests[0])).toEqual(['key', 'file', 'name', 'fullName', 'caseIds', 'level', 'framework']);
    expect(text).toContain('\n  "tests": [\n    {\n      "key"');
  });

  it('читає назад те, що записав', () => {
    const manifest = buildManifest(results);
    expect(parseManifest(serializeManifest(manifest))).toEqual(manifest);
  });

  it('порожній файл — порожній маніфест', () => {
    expect(parseManifest('')).toEqual({ version: 1, tests: [] });
  });

  it('на зламаному JSON або чужій структурі кидає зрозумілу помилку', () => {
    expect(() => parseManifest('{"version": 1, "tests": [')).toThrow(ReportParseError);
    expect(() => parseManifest('{"version": 2, "tests": []}')).toThrow(/очікувалось/);
    expect(() => parseManifest('{"version": 1, "tests": [{"key": "x"}]}')).toThrow(/tests\[0\]/);
  });
});

describe('diffManifest', () => {
  it('знаходить додані, видалені та змінені тести', () => {
    const before = buildManifest(results.slice(0, 3));
    const afterResults = [
      results[0]!,
      { ...results[2]!, framework: 'jest' as const },
      results[4]!,
    ];
    const after = buildManifest(afterResults);
    const diff = diffManifest(before, after);
    expect(diff.added.map((test) => test.file)).toEqual(['tests/unit/test_x.py']);
    expect(diff.removed.map((test) => test.file)).toEqual(['e2e/acts.spec.ts']);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]).toMatchObject({ file: 'src/a.test.ts', framework: 'jest' });
  });

  it('для однакових маніфестів повертає порожні списки', () => {
    const manifest = buildManifest(results);
    expect(diffManifest(manifest, manifest)).toEqual({ added: [], removed: [], changed: [] });
    expect(diffManifest({ version: 1, tests: [] }, { version: 1, tests: [] })).toEqual({ added: [], removed: [], changed: [] });
  });
});
