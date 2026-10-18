import { describe, expect, it } from 'vitest';
import {
  buildWeeklyReport,
  escapeWiki,
  isoWeekLabel,
  weekRange,
  type WeeklyReportData,
} from '../../../src/reporting/weekly-report.js';

function data(overrides: Partial<WeeklyReportData> = {}): WeeklyReportData {
  return {
    projectName: 'Cyber',
    projectKey: 'CYBER',
    weekLabel: '2026-W42',
    period: weekRange('2026-W42'),
    runsOnMain: { count: 14, passRate: 91.2, prevPassRate: 88.4 },
    defects: {
      opened: [
        { id: 'CYBER-D-9', title: 'Сума [без] ПДВ', severity: 'major' },
        { id: 'CYBER-D-8', title: 'Падає *імпорт*', severity: 'critical' },
      ],
      closed: [{ id: 'CYBER-D-7', title: 'Дата в майбутньому' }],
    },
    coverage: { totalCases: 120, casesWithTests: 96, casesWithTestsPrev: 90, p1WithoutTests: 2 },
    tasks: {
      created: 5,
      done: 4,
      open: 3,
      oldest: [
        { id: 'T-2', title: 'Перевірити оплату', ageDays: 2 },
        { id: 'T-1', title: 'Акт без суми', ageDays: 5 },
      ],
    },
    flaky: { count: 3, quarantined: 1, top: [{ caseId: 'CYBER-ACT-4', title: 'Друк акта', flakeScore: 0.42 }] },
    changes: { requirements: 2, designs: 1 },
    ...overrides,
  };
}

describe('isoWeekLabel / weekRange', () => {
  it('рахує ISO-тижні на межі років', () => {
    expect(isoWeekLabel(new Date('2026-10-18T12:00:00Z'))).toBe('2026-W42');
    expect(isoWeekLabel(new Date('2025-12-29T00:00:00Z'))).toBe('2026-W01');
    expect(isoWeekLabel(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
    expect(isoWeekLabel(new Date('2021-01-03T23:59:59Z'))).toBe('2020-W53');
    expect(isoWeekLabel(new Date('2024-12-30T00:00:00Z'))).toBe('2025-W01');
  });

  it('повертає понеділок 00:00Z — неділю 23:59:59.999Z', () => {
    expect(weekRange('2026-W42')).toEqual({ from: '2026-10-12T00:00:00.000Z', to: '2026-10-18T23:59:59.999Z' });
    expect(weekRange('2026-W01')).toEqual({ from: '2025-12-29T00:00:00.000Z', to: '2026-01-04T23:59:59.999Z' });
    expect(isoWeekLabel(new Date(weekRange('2026-W53').from))).toBe('2026-W53');
  });

  it('відхиляє неправильну мітку й неіснуючий тиждень', () => {
    expect(() => weekRange('2026-42')).toThrow(/2026-W42/);
    expect(() => weekRange('2025-W53')).toThrow(/52/);
    expect(() => weekRange('2026-W00')).toThrow();
  });
});

describe('buildWeeklyReport', () => {
  it('формує заголовок задачі й мітку тижня', () => {
    const report = buildWeeklyReport(data());
    expect(report.summary).toBe('QA: тижневий звіт Cyber 2026-W42');
    expect(report.label).toBe('jules-weekly-2026-W42');
  });

  it('рендерить вікі-розмітку Jira Server з таблицями, списками й екрануванням', () => {
    const { wikiMarkup } = buildWeeklyReport(data({ dashboardUrl: 'https://jules.example.ts.net/p/cyber' }));
    expect(wikiMarkup.startsWith('h2. QA: тижневий звіт Cyber 2026-W42\n')).toBe(true);
    expect(wikiMarkup).toContain('Період: 2026-10-12 — 2026-10-18 · проєкт CYBER');
    expect(wikiMarkup).toContain('h3. Прогони на main\n||Показник||Значення||\n|Прогонів|14|\n|Успішність|91% (\\+3 п.п.)|');
    expect(wikiMarkup).toContain('|Кейсів із тестами|96 з 120 (80%)|\n|Приріст за тиждень|\\+6|\n|P1 без тестів|2|');
    expect(wikiMarkup).toContain(
      '||ID||Назва||Серйозність||\n|CYBER-D-8|Падає \\*імпорт\\*|critical|\n|CYBER-D-9|Сума \\[без\\] ПДВ|major|',
    );
    expect(wikiMarkup).toContain('* T-1 Акт без суми — 5 днів\n* T-2 Перевірити оплату — 2 дні');
    expect(wikiMarkup).toContain('* CYBER-ACT-4 Друк акта — 0,42');
    expect(wikiMarkup).toContain('[Відкрити дашборд Jules|https://jules.example.ts.net/p/cyber]');
    expect(wikiMarkup).not.toContain('Висновки');
    expect(wikiMarkup.endsWith('\n')).toBe(true);
  });

  it('додає розділ «Висновки» лише коли їх задано', () => {
    const { wikiMarkup, markdown } = buildWeeklyReport(
      data({ insights: 'Зверніть увагу на {акти}.\n- флейк друку\n- P1 без тестів' }),
    );
    expect(wikiMarkup).toContain('h3. Висновки\n{quote}\nЗверніть увагу на \\{акти\\}.\n* флейк друку\n* P1 без тестів\n{quote}');
    expect(markdown).toContain('### Висновки\n> Зверніть увагу на {акти}.\n> - флейк друку');
    expect(buildWeeklyReport(data({ insights: '   ' })).markdown).not.toContain('Висновки');
  });

  it('рендерить markdown без таблиць для Telegram і дашборда', () => {
    const { markdown } = buildWeeklyReport(data());
    expect(markdown.startsWith('## QA: тижневий звіт Cyber 2026-W42\n')).toBe(true);
    expect(markdown).toContain('- Успішність: **91% (+3 п.п.)**');
    expect(markdown).toContain('- CYBER-D-8 · Падає \\*імпорт\\* · critical');
    expect(markdown).not.toMatch(/^\|/m);
  });

  it('показує динаміку вниз, без змін і відсутність даних', () => {
    expect(buildWeeklyReport(data({ runsOnMain: { count: 3, passRate: 80, prevPassRate: 85 } })).markdown).toContain(
      'Успішність: **80% (−5 п.п.)**',
    );
    expect(buildWeeklyReport(data({ runsOnMain: { count: 3, passRate: 80.2, prevPassRate: 79.9 } })).markdown).toContain(
      'Успішність: **80% (без змін)**',
    );
    expect(buildWeeklyReport(data({ runsOnMain: { count: 0, passRate: null, prevPassRate: 90 } })).markdown).toContain(
      'Успішність: **—**',
    );
    expect(buildWeeklyReport(data({ runsOnMain: { count: 2, passRate: 90, prevPassRate: null } })).markdown).toContain(
      'Успішність: **90%**',
    );
  });

  it('для порожнього тижня не виводить порожніх списків', () => {
    const report = buildWeeklyReport(
      data({
        runsOnMain: { count: 0, passRate: null, prevPassRate: null },
        defects: { opened: [], closed: [] },
        coverage: { totalCases: 0, casesWithTests: 0, casesWithTestsPrev: 0, p1WithoutTests: 0 },
        tasks: { created: 0, done: 0, open: 0, oldest: [] },
        flaky: { count: 0, quarantined: 0, top: [] },
        changes: { requirements: 0, designs: 0 },
      }),
    );
    expect(report.wikiMarkup).toContain('|Кейсів із тестами|0 з 0|');
    expect(report.wikiMarkup).not.toContain('Найстаріші');
    expect(report.wikiMarkup).not.toContain('||ID||');
    expect(report.markdown).toContain('- Приріст за тиждень: **0**');
    expect(buildWeeklyReport(data())).toEqual(buildWeeklyReport(data()));
  });

  it('escapeWiki екранує спецсимволи Jira, не чіпаючи дефіси всередині слів', () => {
    expect(escapeWiki('a|b [c] {d} *e* _f_ !g! ??h?? -i- 2026-10-12')).toBe(
      'a\\|b \\[c\\] \\{d\\} \\*e\\* \\_f\\_ \\!g\\! \\?\\?h\\?\\? \\-i\\- 2026-10-12',
    );
  });
});
