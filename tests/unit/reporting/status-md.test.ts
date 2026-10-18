import { describe, expect, it } from 'vitest';
import { renderStatusMarkdown, type StatusData } from '../../../src/reporting/status-md.js';

function base(overrides: Partial<StatusData> = {}): StatusData {
  return {
    projectName: 'Cyber',
    branch: 'main',
    sha: '3f2a91c0d4e5f6a7b8c9',
    modules: [],
    failed: [],
    p1WithoutTests: [],
    contradictions: [],
    testsWithoutCase: 0,
    directPushes: [],
    ...overrides,
  };
}

const full = base({
  modules: [
    { name: 'Оплати', cases: 27, withTests: 27, passed: 27, failed: 0, mutationScore: 83, openTasks: 0 },
    { name: 'Акти', cases: 42, withTests: 38, passed: 37, failed: 1, mutationScore: 71, openTasks: 2 },
  ],
  failed: [
    {
      caseIds: ['CYBER-ACT-021'],
      title: 'Акт із датою в майбутньому відхиляється',
      file: 'tests/acts/date.test.ts',
      defectId: 'CYBER-D-7',
    },
  ],
  p1WithoutTests: [{ caseId: 'CYBER-ACT-030', title: 'Акт чужого контрагента недоступний за прямим URL' }],
  contradictions: [
    { module: 'Акти', text: 'Сума: у вимозі поле обов\'язкове, у макеті без позначки', openDays: 3 },
  ],
});

describe('renderStatusMarkdown', () => {
  it('рендерить формат із прикладу плану', () => {
    expect(renderStatusMarkdown(full)).toBe(
      [
        '# Стан тестування · main @ 3f2a91c',
        '',
        'Проєкт: Cyber',
        '',
        '| Модуль    | Кейси | З тестами | Пройшли | Впали | Мутації | Задачі QA |',
        '|-----------|------:|----------:|--------:|------:|--------:|----------:|',
        '| Акти      |    42 |        38 |      37 |     1 |     71% |         2 |',
        '| Оплати    |    27 |        27 |      27 |     0 |     83% |         0 |',
        '| **Разом** |    69 |        65 |      64 |     1 |     76% |         2 |',
        '',
        '## Впали',
        '- CYBER-ACT-021 Акт із датою в майбутньому відхиляється · tests/acts/date.test.ts · дефект CYBER-D-7',
        '',
        '## P1 без тестів',
        '- CYBER-ACT-030 Акт чужого контрагента недоступний за прямим URL',
        '',
        '## Суперечності вимога ↔ макет ↔ код',
        "- Акти / Сума: у вимозі поле обов'язкове, у макеті без позначки · питання до QA відкрите 3 дні",
        '',
        '_Файл згенеровано Jules QA. Не редагуйте вручну._',
        '',
      ].join('\n'),
    );
  });

  it('дає однаковий текст незалежно від порядку вхідних даних', () => {
    const shuffled: StatusData = {
      ...full,
      modules: [...full.modules].reverse(),
      p1WithoutTests: [
        { caseId: 'CYBER-ACT-031', title: 'Б' },
        { caseId: 'CYBER-ACT-030', title: 'А' },
      ],
    };
    const ordered: StatusData = { ...shuffled, p1WithoutTests: [...shuffled.p1WithoutTests].reverse() };
    expect(renderStatusMarkdown(shuffled)).toBe(renderStatusMarkdown(ordered));
    expect(renderStatusMarkdown(full)).toBe(renderStatusMarkdown({ ...full }));
  });

  it('пише час лише в шапці й лише якщо його передано', () => {
    const withTime = renderStatusMarkdown({ ...full, generatedAt: '2026-10-18 10:00 UTC' });
    expect(withTime.split('\n')[2]).toBe('Проєкт: Cyber · оновлено 2026-10-18 10:00 UTC');
    expect(renderStatusMarkdown(full)).not.toContain('оновлено');
  });

  it('пише «Усе зелено», коли проблем немає, і не виводить порожні розділи', () => {
    const text = renderStatusMarkdown(
      base({ modules: [{ name: 'Оплати', cases: 3, withTests: 3, passed: 3, failed: 0, mutationScore: null, openTasks: 0 }] }),
    );
    expect(text).toContain('✅ Усе зелено');
    expect(text).toContain('| Оплати    |     3 |');
    expect(text).toContain('|       — |');
    expect(text).not.toContain('## ');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('для порожнього проєкту не пише «Усе зелено»', () => {
    const text = renderStatusMarkdown(base());
    expect(text).toContain('Модулів із кейсами ще немає.');
    expect(text).not.toContain('Усе зелено');
  });

  it('виводить тести без кейса й коміти повз PR без дублів', () => {
    const text = renderStatusMarkdown(
      base({
        testsWithoutCase: 4,
        directPushes: [
          { sha: 'abcdef1234567', author: 'ivan' },
          { sha: '1234567abcdef' },
          { sha: 'abcdef1234567', author: 'ivan' },
        ],
        dashboardUrl: 'https://jules.example.ts.net/projects/cyber',
      }),
    );
    expect(text).toContain('## Тести без кейса: 4');
    expect(text).toContain('## Коміти в main повз PR\n- abcdef1 · ivan\n- 1234567\n');
    expect(text).toContain('[Відкрити дашборд](https://jules.example.ts.net/projects/cyber)');
    expect(text).not.toContain('Усе зелено');
  });

  it('екранує | у назві модуля й склеює переноси рядків', () => {
    const text = renderStatusMarkdown(
      base({
        modules: [{ name: 'Акти | архів', cases: 1, withTests: 0, passed: 0, failed: 0, mutationScore: 50.4, openTasks: 0 }],
        p1WithoutTests: [{ caseId: 'X-1', title: 'рядок\nдругий' }],
      }),
    );
    expect(text).toContain('| Акти \\| архів |');
    expect(text).toContain('- X-1 рядок другий');
    expect(text).toContain('50%');
  });

  it('узгоджує відмінки днів', () => {
    const text = renderStatusMarkdown(
      base({
        contradictions: [
          { module: 'А', text: 'один', openDays: 1 },
          { module: 'Б', text: 'п’ять', openDays: 5 },
          { module: 'В', text: 'одинадцять', openDays: 11 },
        ],
      }),
    );
    expect(text).toContain('відкрите 1 день');
    expect(text).toContain('відкрите 5 днів');
    expect(text).toContain('відкрите 11 днів');
  });
});
