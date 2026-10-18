import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeAssertionChanges } from '../../../src/ingest/index.js';

const diff = readFileSync(path.resolve(import.meta.dirname, '../../fixtures/ingest/assertions.diff'), 'utf-8');

describe('analyzeAssertionChanges', () => {
  const changes = analyzeAssertionChanges(diff);

  it('знаходить видалені й змінені перевірки з номерами рядків старого файлу', () => {
    expect(changes).toEqual([
      {
        file: 'src/acts/acts.test.ts',
        line: 12,
        before: 'expect(result.ok).toBe(false);',
        after: 'expect(result.ok).toBeFalsy();',
        kind: 'modified',
      },
      { file: 'src/acts/acts.test.ts', line: 13, before: "expect(result.errors).toEqual(['amount']);", kind: 'removed' },
      { file: 'src/acts/acts.test.ts', line: 42, before: 'expect(list()).toHaveLength(0);', kind: 'removed' },
      {
        file: 'tests/unit/test_acts.py',
        line: 30,
        before: 'assert total(act) == 121',
        after: 'assert total(act) >= 0',
        kind: 'modified',
      },
      { file: 'tests/unit/test_acts.py', line: 31, before: 'self.assertEqual(act.currency, "UAH")', kind: 'removed' },
      { file: 'e2e/old.spec.ts', line: 3, before: "await expect(page.getByText('Акти')).toBeVisible();", kind: 'removed' },
    ]);
  });

  it('не рахує нові файли, не-тестові файли, коментарі й переформатування', () => {
    const files = new Set(changes.map((change) => change.file));
    expect(files.has('src/acts/new.test.ts')).toBe(false);
    expect(files.has('src/acts/acts.ts')).toBe(false);
    expect(changes.some((change) => change.before.includes('oldWay'))).toBe(false);
    expect(changes.some((change) => change.before.includes('totalWithVat'))).toBe(false);
  });

  it('враховує власні testFileGlobs', () => {
    const only = analyzeAssertionChanges(diff, { testFileGlobs: ['**/*.py'] });
    expect(only.map((change) => change.file)).toEqual(['tests/unit/test_acts.py', 'tests/unit/test_acts.py']);
    const withSource = analyzeAssertionChanges(diff, { testFileGlobs: ['src/**'] });
    expect(withSource.some((change) => change.file === 'src/acts/acts.ts' && change.before === "assert(act, 'act is required');")).toBe(true);
  });

  it('рядок «---» усередині ханку — видалений код, а не заголовок файлу', () => {
    const tricky = [
      'diff --git a/a.test.ts b/a.test.ts',
      '--- a/a.test.ts',
      '+++ b/a.test.ts',
      '@@ -5,3 +5,1 @@',
      '--- comment-like line',
      '-  expect(x).toBe(1);',
      ' done();',
    ].join('\n');
    expect(analyzeAssertionChanges(tricky)).toEqual([{ file: 'a.test.ts', line: 6, before: 'expect(x).toBe(1);', kind: 'removed' }]);
  });

  it('розуміє should (Cypress/Chai) і не плутає з назвою тесту', () => {
    const cy = [
      '--- a/cypress/e2e/acts.cy.spec.ts',
      '+++ b/cypress/e2e/acts.cy.spec.ts',
      '@@ -1,2 +1,1 @@',
      "-it('should open acts', () => {",
      "-  cy.get('[data-test=acts]').should('be.visible');",
      '+it(\'opens\', () => {',
    ].join('\n');
    expect(analyzeAssertionChanges(cy)).toEqual([
      { file: 'cypress/e2e/acts.cy.spec.ts', line: 2, before: "cy.get('[data-test=acts]').should('be.visible');", kind: 'removed' },
    ]);
  });

  it('для порожнього диффа повертає порожній список', () => {
    expect(analyzeAssertionChanges('')).toEqual([]);
  });

  it('на тексті без ханків нічого не знаходить і не кидає', () => {
    expect(analyzeAssertionChanges('це не diff\n- expect(x)')).toEqual([]);
  });
});
