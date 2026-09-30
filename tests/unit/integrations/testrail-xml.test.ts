import { describe, expect, it } from 'vitest';
import type { ExportCase } from '../../../src/integrations/testrail-csv.js';
import {
  buildTestrailXml,
  escapeXml,
  parseTestrailXml,
  parseXml,
} from '../../../src/integrations/testrail-xml.js';
import { testrailMappingSchema, type TestrailMapping } from '../../../src/registry/types.js';

function mapping(overrides: Partial<TestrailMapping> = {}): TestrailMapping {
  return testrailMappingSchema.parse({
    id: 'map-1',
    projectId: 'cyber',
    name: 'Кібер — акти',
    typeMap: { positive: 1, negative: 7, security: 3 },
    priorityMap: { P1: 4, P2: 3 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

const first: ExportCase = {
  id: 'CYBER-REG-014',
  title: 'Акт без суми — форма не зберігається',
  sectionPath: 'Кібер / Карта договору / Акти',
  kind: 'negative',
  priority: 'P1',
  preconditions: 'Роль «Менеджер» & активний договір',
  checks: ['Показано текст «Обов\'язкове поле»', 'Кнопка «Зберегти» неактивна'],
  steps: [
    { action: 'Відкрити форму акта', expected: 'Показано поля Номер і Сума' },
    { action: 'Зберегти без суми', expected: 'Акт не створено' },
  ],
  tags: ['acts', 'validation'],
  refs: ['blk-12', 'blk-13'],
  testrailCaseId: 4021,
};

const second: ExportCase = {
  id: 'CYBER-SEC-002',
  title: 'Прямий URL акта без авторизації — 403',
  sectionPath: 'Кібер / Безпека',
  kind: 'security',
  priority: 'P2',
  preconditions: '',
  checks: ['Відповідь 403', 'Дані акта не показані'],
  steps: [],
  tags: ['authz'],
  refs: [],
};

describe('buildTestrailXml', () => {
  it('будує suite → sections → cases з вкладеністю за sectionPath', () => {
    const xml = buildTestrailXml([first, second], mapping());
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<name>Кібер</name>');
    expect(xml).toContain('<name>Карта договору</name>');
    expect(xml).toContain('<name>Акти</name>');
    expect(xml).toContain('<name>Безпека</name>');
    expect(xml).toContain('<case>');
  });

  it('кладе наш ID у custom-поле з mapping.idField', () => {
    const xml = buildTestrailXml([first], mapping({ idField: 'custom_jules_id' }));
    expect(xml).toContain('<custom_jules_id>CYBER-REG-014</custom_jules_id>');
  });

  it('екранує XML-небезпечні символи', () => {
    const xml = buildTestrailXml([first], mapping());
    expect(xml).toContain('Роль «Менеджер» &amp; активний договір');
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;|#)/);
    expect(escapeXml('a<b>&"c\'')).toBe('a&lt;b&gt;&amp;&quot;c&apos;');
  });

  it('мапить type/priority у числа, але зберігає канонічні значення в custom', () => {
    const xml = buildTestrailXml([first], mapping());
    expect(xml).toContain('<type>7</type>');
    expect(xml).toContain('<priority>4</priority>');
    expect(xml).toContain('<jules_kind>negative</jules_kind>');
    expect(xml).toContain('<jules_priority>P1</jules_priority>');
  });
});

describe('round-trip build → parse', () => {
  it('повертає ті самі кейси', () => {
    const map = mapping();
    const parsed = parseTestrailXml(buildTestrailXml([first, second], map));
    expect(parsed.warnings).toEqual([]);
    expect(parsed.cases).toHaveLength(2);

    const one = parsed.cases.find((item) => item.id === 'CYBER-REG-014')!;
    expect(one.title).toBe(first.title);
    expect(one.sectionPath).toBe(first.sectionPath);
    expect(one.kind).toBe('negative');
    expect(one.priority).toBe('P1');
    expect(one.preconditions).toBe(first.preconditions);
    expect(one.checks).toEqual(first.checks);
    expect(one.steps).toEqual(first.steps);
    expect(one.tags).toEqual(first.tags);
    expect(one.refs).toEqual(first.refs);
    expect(one.testrailCaseId).toBe(4021);

    const two = parsed.cases.find((item) => item.id === 'CYBER-SEC-002')!;
    expect(two.sectionPath).toBe('Кібер / Безпека');
    expect(two.kind).toBe('security');
    expect(two.testrailCaseId).toBeUndefined();
    expect(two.steps).toBeUndefined();
  });

  it('переживає кастомний idField', () => {
    const map = mapping({ idField: 'custom_jules_id' });
    const parsed = parseTestrailXml(buildTestrailXml([first], map));
    expect(parsed.cases[0]?.id).toBe('CYBER-REG-014');
  });

  it('кейси без секції не губляться', () => {
    const noSection: ExportCase = { ...second, sectionPath: '' };
    const parsed = parseTestrailXml(buildTestrailXml([noSection], mapping()));
    expect(parsed.cases).toHaveLength(1);
    expect(parsed.cases[0]?.sectionPath).toBe('Без секції');
  });
});

describe('parseTestrailXml (чужі файли)', () => {
  it('попереджає про кейс без нашого ID', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<suite>
  <name>Чужий</name>
  <sections>
    <section>
      <name>Акти</name>
      <cases>
        <case>
          <id>C77</id>
          <title>Перевірка суми</title>
          <type>Functional</type>
          <priority>High</priority>
        </case>
      </cases>
    </section>
  </sections>
</suite>`;
    const parsed = parseTestrailXml(xml);
    expect(parsed.cases).toHaveLength(1);
    expect(parsed.cases[0]?.id).toBeUndefined();
    expect(parsed.cases[0]?.testrailCaseId).toBe(77);
    expect(parsed.cases[0]?.sectionPath).toBe('Акти');
    expect(parsed.warnings.some((w) => w.includes('без нашого ID'))).toBe(true);
    expect(parsed.warnings.some((w) => w.includes('Functional'))).toBe(true);
  });

  it('читає CDATA і коментарі', () => {
    const xml = `<?xml version="1.0"?>
<!-- експорт -->
<suite><cases><case>
  <title><![CDATA[Акт & сума < 0]]></title>
  <custom><custom_tc_id>CYBER-REG-001</custom_tc_id></custom>
</case></cases></suite>`;
    const parsed = parseTestrailXml(xml);
    expect(parsed.cases[0]?.title).toBe('Акт & сума < 0');
    expect(parsed.cases[0]?.id).toBe('CYBER-REG-001');
  });

  it('порожній XML дає попередження, а не падіння', () => {
    expect(parseTestrailXml('').cases).toEqual([]);
    expect(parseTestrailXml('<suite></suite>').warnings).toContain(
      'У XML не знайдено жодного кейса.',
    );
  });
});

describe('parseXml', () => {
  it('будує дерево з атрибутами й самозакритими тегами', () => {
    const root = parseXml('<a x="1"><b/><c>текст</c></a>');
    const a = root.children[0]!;
    expect(a.name).toBe('a');
    expect(a.attrs.x).toBe('1');
    expect(a.children.map((node) => node.name)).toEqual(['b', 'c']);
    expect(a.children[1]?.text).toBe('текст');
  });

  it('повідомляє про незакриті теги, а не втрачає дані', () => {
    const warnings: string[] = [];
    const root = parseXml('<a><b>текст</a>', warnings);
    expect(root.children[0]?.children[0]?.text).toBe('текст');
    expect(warnings.length).toBeGreaterThan(0);
  });
});
