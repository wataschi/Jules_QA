import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJunitXml, ReportParseError } from '../../../src/ingest/index.js';

const fixture = (name: string) =>
  readFileSync(path.resolve(import.meta.dirname, '../../fixtures/ingest', name), 'utf-8');

describe('parseJunitXml — Vitest', () => {
  const results = parseJunitXml(fixture('junit-vitest.xml'));

  it('бере файл із classname-шляху і розкладає ланцюжок describe у fullName', () => {
    expect(results).toHaveLength(5);
    expect(results[1]).toMatchObject({
      file: 'src/acts/acts.test.ts',
      name: 'CYBER-ACT-015 рахує суму з ПДВ',
      fullName: 'Акти > Підсумки > CYBER-ACT-015 рахує суму з ПДВ',
      status: 'failed',
      framework: 'vitest',
      durationMs: 5,
    });
  });

  it('не дублює файл у fullName, коли назва suite — це шлях файлу', () => {
    expect(results[3]!.fullName).toBe('картка договору відкривається');
  });

  it('переводить секунди в мілісекунди', () => {
    expect(results.map((item) => item.durationMs)).toEqual([3, 5, 0, 700, 21]);
  });

  it('віддає текст failure як помилку без дублювання message', () => {
    expect(results[1]!.error).toMatch(/^AssertionError: expected 120 to be 121/);
    expect(results[1]!.error).toContain('src/acts/acts.test.ts:27:24');
  });

  it('позначає skipped', () => {
    expect(results[2]).toMatchObject({ name: 'експорт у PDF', status: 'skipped' });
    expect(results[0]!.status).toBe('passed');
  });
});

describe('parseJunitXml — pytest', () => {
  const results = parseJunitXml(fixture('junit-pytest.xml'));

  it('перетворює модуль pytest у шлях файлу, а клас — у сегмент fullName', () => {
    expect(results[0]).toMatchObject({
      file: 'tests/unit/test_acts.py',
      fullName: 'test_CYBER_ACT_014_act_without_amount_is_rejected',
      framework: 'pytest',
    });
    expect(results[1]).toMatchObject({
      file: 'tests/unit/test_acts.py',
      name: 'test_CYBER_ACT_015_sum_with_vat',
      fullName: 'TestActTotals > test_CYBER_ACT_015_sum_with_vat',
      status: 'failed',
    });
  });

  it('надає перевагу атрибуту file і рахує error як падіння', () => {
    expect(results[3]).toMatchObject({
      file: 'tests/integration/test_db.py',
      status: 'failed',
      durationMs: 1502,
    });
    expect(results[3]!.error).toContain('ConnectionRefusedError');
  });

  it('збирає message і тіло failure в одну помилку', () => {
    expect(results[1]!.error).toContain('assert 120 == 121');
    expect(results[1]!.error).toContain('tests/unit/test_acts.py:31');
  });

  it('не ріже параметризовану назву і не підставляє «pytest» у fullName', () => {
    expect(results[4]).toMatchObject({ file: 'tests/unit/test_parse.py', name: 'test_parse[case-1]', fullName: 'test_parse[case-1]' });
    expect(results.every((item) => !item.fullName.includes('pytest'))).toBe(true);
  });

  it('позначає skipped', () => {
    expect(results[2]).toMatchObject({ name: 'test_export_pdf', status: 'skipped' });
  });
});

describe('parseJunitXml — Java і крайні випадки', () => {
  it('лишає classname як файл, якщо він не схожий на шлях, і рахує flakyFailure як ретрай', () => {
    const results = parseJunitXml(fixture('junit-java.xml'));
    expect(results[0]).toMatchObject({ file: 'com.example.acts.ActServiceTest', fullName: 'savesAct', framework: 'junit' });
    expect(results[1]).toMatchObject({ status: 'passed', retries: 1 });
  });

  it('не обрізає повідомлення з «>» усередині атрибута', () => {
    const results = parseJunitXml(fixture('junit-java.xml'));
    expect(results[2]!.status).toBe('failed');
    expect(results[2]!.error).toContain('expected: 2 > 1 but was: false');
    expect(results[2]!.error).toContain('ActServiceTest.java:42');
  });

  it('бере file з testsuite і робить абсолютний шлях відносним до rootDir', () => {
    const xml = `<testsuites><testsuite name="Акти" file="/repo/src/acts.test.ts">
      <testcase name="зберігає" classname="Акти" time="0.5"/></testsuite></testsuites>`;
    expect(parseJunitXml(xml, { rootDir: '/repo' })).toEqual([
      { file: 'src/acts.test.ts', name: 'зберігає', fullName: 'зберігає', status: 'passed', durationMs: 500, framework: 'junit' },
    ]);
  });

  it('додає назву suite у fullName, якщо вона не дублює файл', () => {
    const xml = `<testsuite name="Акти"><testcase name="зберігає" classname="src/acts.test.ts" file="./src/acts.test.ts"/></testsuite>`;
    expect(parseJunitXml(xml)[0]).toMatchObject({ file: 'src/acts.test.ts', fullName: 'Акти > зберігає' });
  });

  it('для порожнього рядка повертає порожній список', () => {
    expect(parseJunitXml('')).toEqual([]);
    expect(parseJunitXml('  \n ')).toEqual([]);
  });

  it('для зламаного XML кидає помилку з назвою формату', () => {
    expect(() => parseJunitXml(fixture('junit-broken.xml'))).toThrow(ReportParseError);
    expect(() => parseJunitXml(fixture('junit-broken.xml'))).toThrow(/JUnit XML: зламаний XML/);
    expect(() => parseJunitXml('<testsuites><testsuite></testsuites>')).toThrow(/JUnit XML/);
  });

  it('для чужого XML кидає зрозумілу помилку', () => {
    expect(() => parseJunitXml('<coverage line-rate="1"></coverage>')).toThrow(/JUnit XML: очікувався кореневий <testsuites>/);
    expect(() => parseJunitXml('просто текст')).toThrow(/JUnit XML/);
  });
});
