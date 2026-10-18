import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectReportFormat, parseTestReport, ReportParseError } from '../../../src/ingest/index.js';

const fixture = (name: string) =>
  readFileSync(path.resolve(import.meta.dirname, '../../fixtures/ingest', name), 'utf-8');

describe('detectReportFormat', () => {
  it('визначає формат за вмістом', () => {
    expect(detectReportFormat('report.xml', fixture('junit-vitest.xml'))).toBe('junit');
    expect(detectReportFormat('report.xml', fixture('junit-java.xml'))).toBe('junit');
    expect(detectReportFormat('report.xml', fixture('cobertura.xml'))).toBe('cobertura');
    expect(detectReportFormat('report.txt', fixture('lcov.info'))).toBe('lcov');
    expect(detectReportFormat('report.json', fixture('playwright-report.json'))).toBe('playwright-json');
    expect(detectReportFormat('report.json', fixture('vitest-report.json'))).toBe('jest-json');
    expect(detectReportFormat('report.json', fixture('jest-report.json'))).toBe('jest-json');
    expect(detectReportFormat('report.json', fixture('stryker-v1.json'))).toBe('stryker');
    expect(detectReportFormat('report.json', fixture('stryker-v2.json'))).toBe('stryker');
  });

  it('вміст важливіший за ім’я файлу', () => {
    expect(detectReportFormat('coverage/junit.xml', fixture('cobertura.xml'))).toBe('cobertura');
    expect(detectReportFormat('mutation.json', fixture('jest-report.json'))).toBe('jest-json');
  });

  it('stryker без schemaVersion розпізнає за mutants', () => {
    expect(detectReportFormat('x.json', '{"files": {"a.ts": {"mutants": []}}}')).toBe('stryker');
  });

  it('для порожнього або зламаного вмісту підказує ім’я файлу', () => {
    expect(detectReportFormat('test-results/junit.xml', '')).toBe('junit');
    expect(detectReportFormat('coverage/lcov.info', '')).toBe('lcov');
    expect(detectReportFormat('coverage/cobertura-coverage.xml', '')).toBe('cobertura');
    expect(detectReportFormat('reports/mutation/mutation.json', '{"files": {')).toBe('stryker');
    expect(detectReportFormat('playwright-report.json', '{')).toBe('playwright-json');
  });

  it('невідомий вміст і ім’я — unknown', () => {
    expect(detectReportFormat('notes.txt', 'просто текст')).toBe('unknown');
    expect(detectReportFormat('data.json', '{"a": 1}')).toBe('unknown');
    expect(detectReportFormat('a.xml', '<html></html>')).toBe('unknown');
  });
});

describe('parseTestReport', () => {
  it('диспетчеризує junit, playwright-json і jest-json', () => {
    expect(parseTestReport('junit.xml', fixture('junit-pytest.xml'))).toHaveLength(5);
    expect(parseTestReport('pw.json', fixture('playwright-report.json'), { rootDir: '/home/runner/work/cyber/cyber' })[0]!.file).toBe(
      'e2e/acts/acts.spec.ts',
    );
    expect(parseTestReport('vitest.json', fixture('vitest-report.json'), { rootDir: '/home/runner/work/cyber/cyber' })[0]!.file).toBe(
      'src/acts/acts.test.ts',
    );
  });

  it('для порожнього вмісту повертає порожній список', () => {
    expect(parseTestReport('junit.xml', '')).toEqual([]);
  });

  it('для зламаного JSON кидає помилку парсера відповідного формату', () => {
    expect(() => parseTestReport('playwright-report.json', '{"suites": [')).toThrow(/Playwright JSON/);
  });

  it('для звіту покриття або невідомого формату кидає зрозумілу помилку', () => {
    expect(() => parseTestReport('lcov.info', fixture('lcov.info'))).toThrow(ReportParseError);
    expect(() => parseTestReport('lcov.info', fixture('lcov.info'))).toThrow(/це звіт «lcov», а не тестів/);
    expect(() => parseTestReport('notes.txt', 'текст')).toThrow(/формат не розпізнано/);
  });
});
