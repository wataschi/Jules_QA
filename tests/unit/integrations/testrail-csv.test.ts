import { describe, expect, it } from 'vitest';
import {
  BOM,
  buildTestrailCsv,
  csvEscape,
  parseCsvRows,
  parseTestrailCsv,
  type ExportCase,
} from '../../../src/integrations/testrail-csv.js';
import { testrailMappingSchema, type TestrailMapping } from '../../../src/registry/types.js';

function mapping(overrides: Partial<TestrailMapping> = {}): TestrailMapping {
  return testrailMappingSchema.parse({
    id: 'map-1',
    projectId: 'cyber',
    name: 'Стандартний мапінг',
    typeMap: { positive: 1, negative: 7, security: 3 },
    priorityMap: { P1: 4, P2: 3, P3: 2, P4: 1 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

const sampleCase: ExportCase = {
  id: 'CYBER-REG-014',
  title: 'Акт без суми — форма не зберігається, поле «Сума» підсвічене',
  sectionPath: 'Кібер / Карта договору / Акти',
  kind: 'negative',
  priority: 'P1',
  preconditions: 'Користувач із роллю «Менеджер», відкрита карта активного договору',
  checks: [
    'Під полем «Сума» показано текст «Обов\'язкове поле»',
    'Кнопка «Зберегти» лишається неактивною',
  ],
  steps: [
    { action: 'Відкрити форму створення акта', expected: 'Показано форму з полями Номер і Сума' },
    { action: 'Натиснути «Зберегти», не заповнивши суму', expected: 'Акт не створено' },
  ],
  tags: ['acts', 'validation'],
  refs: ['blk-12'],
  testrailCaseId: 4021,
};

describe('buildTestrailCsv', () => {
  it('починається з BOM і використовує CRLF (зокрема всередині полів)', () => {
    const csv = buildTestrailCsv([sampleCase], mapping());
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv).toMatch(/^﻿[^\n\r]+\r\n/); // шапка завершується CRLF
    expect(csv.endsWith('\r\n')).toBe(true);
    // Жодного «самотнього» LF без CR — Excel такий файл ламає.
    expect(csv.replace(/\r\n/g, '')).not.toContain('\n');
    expect(csv.replace(/\r\n/g, '')).not.toContain('\r');
  });

  it('кладе наш ID у колонку mapping.idField — основа round-trip', () => {
    const csv = buildTestrailCsv([sampleCase], mapping({ idField: 'custom_jules_id' }));
    const [header, firstRow] = csv.slice(BOM.length).split('\r\n');
    expect(header?.split(',')[0]).toBe('custom_jules_id');
    expect(firstRow).toContain('CYBER-REG-014');
  });

  it('не ламає кирилицю й екранує лапки подвоєнням', () => {
    const withQuotes: ExportCase = {
      ...sampleCase,
      title: 'Поле "Сума" — помилка при 0',
    };
    const csv = buildTestrailCsv([withQuotes], mapping());
    expect(csv).toContain('Акт');
    expect(csv).toContain('"Поле ""Сума"" — помилка при 0"');
    const parsed = parseTestrailCsv(csv, mapping());
    expect(parsed.cases[0]?.title).toBe('Поле "Сума" — помилка при 0');
  });

  it('мапить kind і priority у числа TestRail', () => {
    const csv = buildTestrailCsv([sampleCase], mapping());
    const row = csv.slice(BOM.length).split('\r\n')[1] ?? '';
    // negative → 7, P1 → 4
    expect(row).toContain(',7,4,');
  });

  it('template=steps_separated: кожен крок окремим рядком, решта полів лише в першому', () => {
    const csv = buildTestrailCsv([sampleCase], mapping({ template: 'steps_separated' }));
    const rows = parseCsvRows(csv, ',');
    expect(rows).toHaveLength(3); // шапка + 2 кроки
    expect(rows[1]?.[0]).toBe('CYBER-REG-014');
    expect(rows[2]?.[0]).toBe('');
    expect(rows[2]?.[2]).toBe(''); // title лише в першому рядку
    const header = rows[0] ?? [];
    const stepsIndex = header.indexOf('Steps');
    const expectedIndex = header.indexOf('Expected Result');
    expect(rows[2]?.[stepsIndex]).toBe('Натиснути «Зберегти», не заповнивши суму');
    expect(rows[2]?.[expectedIndex]).toBe('Акт не створено');
  });

  it('template=checklist: перевірки одним полем із маркерами', () => {
    const csv = buildTestrailCsv([sampleCase], mapping());
    const rows = parseCsvRows(csv, ',');
    const checksIndex = (rows[0] ?? []).indexOf('Checklist');
    const checks = rows[1]?.[checksIndex] ?? '';
    expect(checks.split(/\r?\n/)).toEqual([
      '- Під полем «Сума» показано текст «Обов\'язкове поле»',
      '- Кнопка «Зберегти» лишається неактивною',
    ]);
  });

  it('шанує власний розділювач колонок', () => {
    const csv = buildTestrailCsv([sampleCase], mapping({ delimiter: ';' }));
    expect(csv.slice(BOM.length).split('\r\n')[0]).toContain('custom_tc_id;ID;Title');
  });
});

describe('round-trip build → parse', () => {
  it('checklist: повертає ті самі значення', () => {
    const map = mapping();
    const parsed = parseTestrailCsv(buildTestrailCsv([sampleCase], map), map);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.cases).toHaveLength(1);
    const item = parsed.cases[0]!;
    expect(item.id).toBe(sampleCase.id);
    expect(item.title).toBe(sampleCase.title);
    expect(item.sectionPath).toBe(sampleCase.sectionPath);
    expect(item.kind).toBe('negative');
    expect(item.priority).toBe('P1');
    expect(item.preconditions).toBe(sampleCase.preconditions);
    expect(item.checks).toEqual(sampleCase.checks);
    expect(item.tags).toEqual(sampleCase.tags);
    expect(item.refs).toEqual(sampleCase.refs);
    expect(item.testrailCaseId).toBe(4021);
    expect(item.steps).toEqual(sampleCase.steps);
  });

  it('steps_separated: кроки збираються назад в один кейс', () => {
    const map = mapping({ template: 'steps_separated' });
    const parsed = parseTestrailCsv(buildTestrailCsv([sampleCase], map), map);
    expect(parsed.cases).toHaveLength(1);
    expect(parsed.cases[0]?.steps).toEqual(sampleCase.steps);
    expect(parsed.cases[0]?.checks).toEqual(sampleCase.checks);
  });

  it('багаторядкові кроки переживають round-trip', () => {
    const map = mapping({ template: 'steps_separated' });
    const multiline: ExportCase = {
      ...sampleCase,
      steps: [
        {
          action: 'Заповнити форму:\nНомер = A-1\nСума = 0',
          expected: 'Показано помилку:\n«Сума має бути більше 0»',
        },
      ],
    };
    const csv = buildTestrailCsv([multiline], map);
    const parsed = parseTestrailCsv(csv, map);
    expect(parsed.cases[0]?.steps).toEqual(multiline.steps);
  });

  it('кілька кейсів і кирилиця в заголовках', () => {
    const map = mapping({ template: 'steps_separated' });
    const second: ExportCase = {
      ...sampleCase,
      id: 'CYBER-REG-015',
      title: 'Прямий URL на акт чужого договору — 403',
      kind: 'security',
      priority: 'P2',
      checks: ['Сторінка повертає 403', 'Дані акта не показані'],
      steps: [{ action: 'Відкрити /acts/9999 без прав', expected: 'Показано 403' }],
      tags: ['authz'],
      refs: [],
      testrailCaseId: undefined,
    };
    const parsed = parseTestrailCsv(buildTestrailCsv([sampleCase, second], map), map);
    expect(parsed.cases.map((item) => item.id)).toEqual(['CYBER-REG-014', 'CYBER-REG-015']);
    expect(parsed.cases[1]?.title).toBe('Прямий URL на акт чужого договору — 403');
    expect(parsed.cases[1]?.kind).toBe('security');
    expect(parsed.cases[1]?.testrailCaseId).toBeUndefined();
  });
});

describe('parseTestrailCsv (чужі файли)', () => {
  it('попереджає, коли немає колонки з нашим ID', () => {
    const csv = `${BOM}ID,Title,Section\r\nC10,Перевірка суми,Акти\r\n`;
    const parsed = parseTestrailCsv(csv, mapping());
    expect(parsed.warnings.some((w) => w.includes('custom_tc_id'))).toBe(true);
    expect(parsed.cases[0]?.title).toBe('Перевірка суми');
    expect(parsed.cases[0]?.testrailCaseId).toBe(10);
  });

  it('попереджає про невідомий тип і пріоритет', () => {
    const csv = `${BOM}custom_tc_id,ID,Title,Section,Type,Priority\r\nCYBER-REG-001,,Заголовок,Акти,99,Urgent\r\n`;
    const parsed = parseTestrailCsv(csv, mapping());
    expect(parsed.cases[0]?.kind).toBeUndefined();
    expect(parsed.cases[0]?.priority).toBeUndefined();
    expect(parsed.warnings.filter((w) => w.includes('невідом'))).toHaveLength(2);
  });

  it('читає файли з LF замість CRLF і без BOM', () => {
    const csv = 'custom_tc_id,ID,Title\nCYBER-REG-002,,Заголовок\n';
    const parsed = parseTestrailCsv(csv, mapping());
    expect(parsed.cases[0]?.id).toBe('CYBER-REG-002');
  });

  it('порожній файл дає попередження, а не падіння', () => {
    expect(parseTestrailCsv('', mapping()).cases).toEqual([]);
    expect(parseTestrailCsv('', mapping()).warnings.length).toBeGreaterThan(0);
  });
});

describe('csvEscape', () => {
  it('беремо в лапки лише те, що треба', () => {
    expect(csvEscape('просто', ',')).toBe('просто');
    expect(csvEscape('є, кома', ',')).toBe('"є, кома"');
    expect(csvEscape('є "лапки"', ',')).toBe('"є ""лапки"""');
    expect(csvEscape('рядок\nдругий', ',')).toBe('"рядок\r\nдругий"');
    expect(csvEscape(' пробіл ', ',')).toBe('" пробіл "');
    expect(csvEscape('є, кома', ';')).toBe('є, кома');
  });
});
