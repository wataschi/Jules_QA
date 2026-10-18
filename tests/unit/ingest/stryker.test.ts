import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseStrykerReport, ReportParseError } from '../../../src/ingest/index.js';

const fixture = (name: string) =>
  readFileSync(path.resolve(import.meta.dirname, '../../fixtures/ingest', name), 'utf-8');

describe('parseStrykerReport', () => {
  it('рахує статуси мутантів і score для схеми v1', () => {
    expect(parseStrykerReport(fixture('stryker-v1.json'))).toEqual([
      { path: 'src/acts/acts.ts', killed: 2, survived: 1, noCoverage: 0, timeout: 1, total: 4, score: 75 },
      { path: 'src/utils/money.ts', killed: 0, survived: 0, noCoverage: 1, timeout: 0, total: 1, score: 0 },
    ]);
  });

  it('для схеми v2 не рахує CompileError/Ignored у score і відрізає projectRoot', () => {
    expect(parseStrykerReport(fixture('stryker-v2.json'), { rootDir: '/other' })).toEqual([
      { path: 'src/acts/acts.ts', killed: 2, survived: 1, noCoverage: 0, timeout: 0, total: 5, score: 66.67 },
      { path: 'src/types.ts', killed: 0, survived: 0, noCoverage: 0, timeout: 0, total: 1, score: null },
    ]);
  });

  it('для порожнього рядка повертає порожній список', () => {
    expect(parseStrykerReport('')).toEqual([]);
  });

  it('для зламаного JSON кидає помилку з назвою формату', () => {
    expect(() => parseStrykerReport('{"files": {')).toThrow(ReportParseError);
    expect(() => parseStrykerReport('{"files": {')).toThrow(/Stryker mutation\.json: не вдалося розібрати JSON/);
  });

  it('для JSON без files кидає зрозумілу помилку', () => {
    expect(() => parseStrykerReport('{"schemaVersion": "2"}')).toThrow(/немає об'єкта «files»/);
  });
});
