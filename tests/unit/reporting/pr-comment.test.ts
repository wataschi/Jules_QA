import { describe, expect, it } from 'vitest';
import { renderPrComment, type PrCommentData } from '../../../src/reporting/pr-comment.js';

function base(overrides: Partial<PrCommentData> = {}): PrCommentData {
  return {
    projectName: 'Cyber',
    prNumber: 42,
    sha: 'abcdef1234567890',
    touchedCases: [],
    newTests: [],
    failed: [],
    testsWithoutCase: [],
    assertionChanges: [],
    ...overrides,
  };
}

describe('renderPrComment', () => {
  it('починається рівно з маркера й має зелений підсумок', () => {
    const text = renderPrComment(
      base({
        touchedCases: [
          { caseId: 'CYBER-ACT-2', title: 'Друге', status: 'passed' },
          { caseId: 'CYBER-ACT-1', title: 'Перше', status: 'passed' },
        ],
        newTests: [{ file: 'tests/acts.test.ts', name: 'зберігає акт', caseIds: ['CYBER-ACT-1'] }],
        coverage: { linesFound: 200, linesHit: 164 },
        dashboardUrl: 'https://jules.example.ts.net/pr/42',
      }),
    );
    expect(text).toBe(
      [
        '<!-- jules-qa -->',
        '### Jules QA · Cyber · PR #42 @ abcdef1',
        '',
        '✅ **Усі тести пройшли** · зачеплено кейсів: 2 · нових тестів: 1',
        '',
        'Покриття змінених рядків: 82% (164 з 200)',
        '',
        '#### Зачеплені кейси',
        '- ✅ CYBER-ACT-1 Перше',
        '- ✅ CYBER-ACT-2 Друге',
        '',
        '#### Нові тести',
        '- `tests/acts.test.ts` › зберігає акт · CYBER-ACT-1',
        '',
        '[Відкрити в Jules](https://jules.example.ts.net/pr/42)',
        '',
      ].join('\n'),
    );
  });

  it('показує ❌ і обрізану помилку, екрануючи ```', () => {
    const error = `Expected 1\n\`\`\`js\nboom\n\`\`\`\n${'x'.repeat(400)}`;
    const text = renderPrComment(
      base({
        failed: [{ file: 'tests/a.test.ts', name: 'падає', caseIds: ['CYBER-ACT-3'], error }],
        assertionChanges: [{ file: 'tests/a.test.ts', line: 3, before: 'expect(a).toBe(1)', kind: 'removed' }],
      }),
    );
    expect(text.split('\n')[0]).toBe('<!-- jules-qa -->');
    expect(text).toContain('❌ **Впало тестів: 1**');
    expect(text).toContain('- **падає** · `tests/a.test.ts` · CYBER-ACT-3\n  ```\n  Expected 1\n');
    // Лише дві огорожі — відкривальна й закривальна, бектики з помилки розбиті.
    expect(text.match(/^ {2}```$/gm)).toHaveLength(2);
    expect(text).toContain('`​`​`js');
    expect(text).toContain('…\n  ```');
    expect(text).not.toContain('x'.repeat(301));
  });

  it('виносить зміни асертів в окремий розділ із міткою qa:assertion-change', () => {
    const text = renderPrComment(
      base({
        assertionChanges: [
          { file: 'tests/b.test.ts', line: 10, before: 'expect(sum).toBe(100)', after: 'expect(sum).toBe(90)', kind: 'modified' },
          { file: 'tests/a.test.ts', line: 5, before: 'expect(`x`).toBe(1)', kind: 'removed' },
        ],
        newTests: [{ file: 'tests/n.test.ts', name: 'новий', caseIds: [] }],
      }),
    );
    expect(text).toContain('⚠️ **Тести зелені, але є що перевірити** · змінено перевірок: 2 · зачеплено кейсів: 0 · нових тестів: 1');
    expect(text).toContain('#### ⚠️ Змінено наявні перевірки — потрібне погодження QA');
    expect(text).toContain('`qa:assertion-change`');
    expect(text).toContain('- `tests/a.test.ts:5` видалено: ``expect(`x`).toBe(1)``');
    expect(text).toContain('- `tests/b.test.ts:10` змінено: `expect(sum).toBe(100)` → `expect(sum).toBe(90)`');
    // Розділ асертів іде перед рештою.
    expect(text.indexOf('Змінено наявні перевірки')).toBeLessThan(text.indexOf('#### Нові тести'));
    expect(text.indexOf('tests/a.test.ts:5')).toBeLessThan(text.indexOf('tests/b.test.ts:10'));
  });

  it('попереджає про тести без кейса й кейси без тесту', () => {
    const text = renderPrComment(
      base({
        touchedCases: [{ caseId: 'CYBER-ACT-9', title: 'Без тесту', status: 'untested' }],
        testsWithoutCase: [{ file: 'tests/c.test.ts', name: 'щось' }],
      }),
    );
    expect(text).toContain('⚠️ **Тести зелені, але є що перевірити** · тестів без кейса: 1 · кейсів без тесту: 1');
    expect(text).toContain('- ⚪ CYBER-ACT-9 Без тесту · без тесту');
    expect(text).toContain('#### Тести без кейса');
    expect(text).toContain('- `tests/c.test.ts` › щось');
  });

  it('обрізає довгі списки до 20 з «…і ще N»', () => {
    const tests = Array.from({ length: 25 }, (_, i) => ({ file: `tests/t${String(i).padStart(2, '0')}.test.ts`, name: 'x' }));
    const text = renderPrComment(base({ testsWithoutCase: tests }));
    expect(text).toContain('tests/t19.test.ts');
    expect(text).not.toContain('tests/t20.test.ts');
    expect(text).toContain('- …і ще 5');
  });

  it('для порожнього PR пише, що нічого не зачеплено', () => {
    const text = renderPrComment(base({ coverage: { linesFound: 0, linesHit: 0 } }));
    expect(text).toContain('✅ **Усі тести пройшли** · зачеплено кейсів: 0 · нових тестів: 0');
    expect(text).toContain('Покриття змінених рядків: —');
    expect(text).toContain('Цей PR не зачепив тестів і кейсів.');
    expect(text.endsWith('\n')).toBe(true);
    expect(renderPrComment(base())).toBe(renderPrComment(base()));
  });
});
