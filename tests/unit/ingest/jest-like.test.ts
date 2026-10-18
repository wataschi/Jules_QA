import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJestLikeJson, ReportParseError } from '../../../src/ingest/index.js';

const fixture = (name: string) =>
  readFileSync(path.resolve(import.meta.dirname, '../../fixtures/ingest', name), 'utf-8');
const REPO = '/home/runner/work/cyber/cyber';

describe('parseJestLikeJson — Vitest --reporter=json', () => {
  const results = parseJestLikeJson(fixture('vitest-report.json'), { rootDir: REPO });

  it('розпізнає Vitest і збирає fullName з ancestorTitles', () => {
    expect(results).toHaveLength(4);
    expect(results[1]).toMatchObject({
      file: 'src/acts/acts.test.ts',
      name: 'CYBER-ACT-015 рахує суму з ПДВ',
      fullName: 'Акти > Підсумки > CYBER-ACT-015 рахує суму з ПДВ',
      status: 'failed',
      durationMs: 5,
      framework: 'vitest',
    });
    expect(results[1]!.error).toMatch(/^AssertionError: expected 120 to be 121/);
  });

  it('тест без describe має fullName, що дорівнює назві', () => {
    expect(results[3]).toMatchObject({ fullName: 'картка договору відкривається', file: 'src/contracts/contract-card.test.ts' });
  });

  it('skipped без тривалості не отримує durationMs', () => {
    expect(results[2]).toMatchObject({ status: 'skipped' });
    expect(results[2]!.durationMs).toBeUndefined();
  });

  it('за замовчуванням відрізає process.cwd()', () => {
    const json = { testResults: [{ name: path.join(process.cwd(), 'src', 'a.test.ts'), assertionResults: [{ ancestorTitles: [], title: 'x', status: 'passed', meta: {} }] }] };
    expect(parseJestLikeJson(JSON.stringify(json))[0]!.file).toBe('src/a.test.ts');
  });
});

describe('parseJestLikeJson — Jest --json', () => {
  const results = parseJestLikeJson(fixture('jest-report.json'), { rootDir: REPO });

  it('розпізнає Jest і рахує ретраї з invocations/retryReasons', () => {
    expect(results[0]).toMatchObject({
      file: 'web/src/ContractCard.test.tsx',
      fullName: 'ContractCard > суми > CYBER-CON-003 показує залишок',
      status: 'passed',
      retries: 1,
      framework: 'jest',
    });
  });

  it('pending і todo — це skipped', () => {
    expect(results[2]!.status).toBe('skipped');
    expect(results[3]!.status).toBe('skipped');
  });

  it('прибирає ANSI-коди з failureMessages', () => {
    expect(results[1]!.error).toMatch(/^expect\(received\)\.toEqual\(expected\)/);
    expect(results[1]!.error).not.toContain('\u001b');
  });

  it('обрізає довгу помилку до ~2000 символів', () => {
    const json = { testResults: [{ name: 'a.test.ts', assertionResults: [{ ancestorTitles: [], title: 'x', status: 'failed', failureMessages: ['x'.repeat(5000)] }] }] };
    expect(parseJestLikeJson(JSON.stringify(json))[0]!.error!.length).toBeLessThanOrEqual(2000);
  });

  it('дозволяє явно задати фреймворк', () => {
    expect(parseJestLikeJson(fixture('jest-report.json'), { framework: 'vitest' })[0]!.framework).toBe('vitest');
  });
});

describe('parseJestLikeJson — порожній і зламаний вхід', () => {
  it('для порожнього рядка повертає порожній список', () => {
    expect(parseJestLikeJson('')).toEqual([]);
  });

  it('для зламаного JSON кидає помилку з назвою формату', () => {
    expect(() => parseJestLikeJson('{"testResults": [')).toThrow(ReportParseError);
    expect(() => parseJestLikeJson('{"testResults": [')).toThrow(/Jest\/Vitest JSON: не вдалося розібрати JSON/);
  });

  it('для JSON без testResults кидає зрозумілу помилку', () => {
    expect(() => parseJestLikeJson('{"suites": []}')).toThrow(/немає масиву «testResults»/);
  });
});
