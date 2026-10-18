import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCobertura, parseLcov, ReportParseError } from '../../../src/ingest/index.js';

const fixture = (name: string) =>
  readFileSync(path.resolve(import.meta.dirname, '../../fixtures/ingest', name), 'utf-8');
const REPO = '/home/runner/work/cyber/cyber';

describe('parseLcov', () => {
  const files = parseLcov(fixture('lcov.info'), { rootDir: REPO });

  it('віддає по запису на файл, з нормалізованими відсортованими шляхами', () => {
    expect(files.map((item) => item.path)).toEqual(['src/acts/acts.ts', 'src/contracts/contract.ts', 'src/utils/money.ts']);
  });

  it('зливає повторні записи одного файлу по рядках і гілках', () => {
    expect(files[0]).toEqual({ path: 'src/acts/acts.ts', linesFound: 6, linesHit: 5, branchesFound: 4, branchesHit: 4 });
  });

  it('без DA бере підсумки LF/LH', () => {
    expect(files[2]).toEqual({ path: 'src/utils/money.ts', linesFound: 10, linesHit: 7 });
    expect(files[1]).toEqual({ path: 'src/contracts/contract.ts', linesFound: 2, linesHit: 2, branchesFound: 0, branchesHit: 0 });
  });

  it('для порожнього рядка повертає порожній список', () => {
    expect(parseLcov('')).toEqual([]);
  });

  it('для тексту без SF: кидає помилку з назвою формату', () => {
    expect(() => parseLcov('це не lcov\n')).toThrow(ReportParseError);
    expect(() => parseLcov('це не lcov\n')).toThrow(/LCOV/);
  });
});

describe('parseCobertura', () => {
  it('рахує рядки й гілки з condition-coverage і додає <source> до шляху (coverage.py)', () => {
    expect(parseCobertura(fixture('cobertura.xml'), { rootDir: REPO })).toEqual([
      { path: 'backend/app/acts/models.py', linesFound: 4, linesHit: 3, branchesFound: 2, branchesHit: 2 },
      { path: 'backend/app/acts/service.py', linesFound: 5, linesHit: 3, branchesFound: 2, branchesHit: 1 },
    ]);
  });

  it('поза коренем репо лишає filename як є', () => {
    expect(parseCobertura(fixture('cobertura.xml'), { rootDir: '/other' })[0]!.path).toBe('acts/models.py');
  });

  it('зливає кілька класів одного файлу (Istanbul) і не рахує файл без гілок', () => {
    const xml = `<?xml version="1.0"?><coverage><sources><source>/repo</source></sources><packages><package name="src">
      <classes>
        <class name="a" filename="src/a.ts"><lines><line number="1" hits="0"/><line number="2" hits="1"/></lines></class>
        <class name="a$inner" filename="src/a.ts"><lines><line number="1" hits="3"/><line number="5" hits="0"/></lines></class>
      </classes></package></packages></coverage>`;
    expect(parseCobertura(xml, { rootDir: '/repo' })).toEqual([{ path: 'src/a.ts', linesFound: 3, linesHit: 2 }]);
  });

  it('для порожнього рядка повертає порожній список', () => {
    expect(parseCobertura('')).toEqual([]);
  });

  it('для зламаного XML кидає помилку з назвою формату', () => {
    expect(() => parseCobertura('<coverage><packages></coverage>')).toThrow(/Cobertura XML: зламаний XML/);
    expect(() => parseCobertura('<testsuites></testsuites>')).toThrow(/Cobertura XML: немає кореневого <coverage>/);
  });
});
