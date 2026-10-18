import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compareTokens,
  figmaVariableToCssName,
  figmaVariablesToTokens,
  normalizeColor,
  parseCssVariables,
} from '../../../src/integrations/design-tokens.js';

const VARIABLES = path.resolve(import.meta.dirname, '../../fixtures/figma/variables-local.json');

function readVariables(): unknown {
  return JSON.parse(readFileSync(VARIABLES, 'utf-8'));
}

const CSS = `
/* Тема за замовчуванням */
:root {
  --color-primary-500: #1D4ED8;
  --spacing-md: 16px; /* базовий відступ */
  --font-family-base: "Inter";
  --color-button-bg: var(--color-primary-500);
  color: var(--color-primary-500);
}
[data-theme='dark'] {
  --color-overlay: rgba(0, 0, 0, 0.5);
  --radius-card-large: 10px !important;
}
.legacy { --unused-token: 3px }
/* --commented-out: red; */
`;

describe('parseCssVariables', () => {
  it('збирає змінні з :root і будь-яких селекторів, прибирає коментарі', () => {
    expect(parseCssVariables(CSS)).toEqual({
      '--color-primary-500': '#1D4ED8',
      '--spacing-md': '16px',
      '--font-family-base': '"Inter"',
      '--color-button-bg': 'var(--color-primary-500)',
      '--color-overlay': 'rgba(0, 0, 0, 0.5)',
      '--radius-card-large': '10px',
      '--unused-token': '3px',
    });
  });

  it('останнє визначення перемагає', () => {
    expect(parseCssVariables(':root{--a: 1px;} .x{--a:  2px ;}')).toEqual({ '--a': '2px' });
  });

  it('повертає порожній об’єкт для CSS без змінних і порожнього рядка', () => {
    expect(parseCssVariables('body { color: red; }')).toEqual({});
    expect(parseCssVariables('')).toEqual({});
  });
});

describe('normalizeColor', () => {
  it('розгортає короткий hex і переводить у нижній регістр', () => {
    expect(normalizeColor('#ABC')).toBe('#aabbcc');
    expect(normalizeColor('#1D4ED8')).toBe('#1d4ed8');
    expect(normalizeColor('#abcd')).toBe('#aabbccdd');
  });

  it('прибирає непрозору альфу ff і лишає напівпрозору', () => {
    expect(normalizeColor('#112233FF')).toBe('#112233');
    expect(normalizeColor('#11223380')).toBe('#11223380');
  });

  it('розуміє rgb/rgba через кому, через пробіл і з відсотками', () => {
    expect(normalizeColor('rgb(29, 78, 216)')).toBe('#1d4ed8');
    expect(normalizeColor('rgba(0,0,0,0.5)')).toBe('#00000080');
    expect(normalizeColor('rgb(0 0 0 / 50%)')).toBe('#00000080');
    expect(normalizeColor('rgb(100%, 0%, 0%)')).toBe('#ff0000');
    expect(normalizeColor('rgba(255, 0, 0, 1)')).toBe('#ff0000');
  });

  it('повертає null для не-кольорів', () => {
    expect(normalizeColor('16px')).toBeNull();
    expect(normalizeColor('#12345')).toBeNull();
    expect(normalizeColor('rgb(1, 2)')).toBeNull();
    expect(normalizeColor('')).toBeNull();
  });
});

describe('figmaVariablesToTokens', () => {
  it('перетворює змінні першого режиму на CSS-токени, розв’язуючи аліаси', () => {
    expect(figmaVariablesToTokens(readVariables())).toEqual({
      '--color-primary-500': '#1d4ed8',
      '--color-overlay': '#00000080',
      '--spacing-md': '16',
      '--font-family-base': 'Inter',
      '--color-button-bg': '#1d4ed8',
      '--radius-card-large': '12',
    });
  });

  it('нормалізує імена: слеші й пробіли → дефіси, нижній регістр', () => {
    expect(figmaVariableToCssName('color/primary/500')).toBe('--color-primary-500');
    expect(figmaVariableToCssName('Radius / Card Large')).toBe('--radius-card-large');
  });

  it('повертає порожній об’єкт для порожньої чи чужої відповіді', () => {
    expect(figmaVariablesToTokens(null)).toEqual({});
    expect(figmaVariablesToTokens({ status: 403, error: true })).toEqual({});
    expect(figmaVariablesToTokens({ meta: { variables: {} } })).toEqual({});
  });

  it('не зациклюється на кільцевих аліасах', () => {
    const payload = {
      meta: {
        variables: {
          a: { id: 'a', name: 'a', resolvedType: 'COLOR', valuesByMode: { m: { type: 'VARIABLE_ALIAS', id: 'b' } } },
          b: { id: 'b', name: 'b', resolvedType: 'COLOR', valuesByMode: { m: { type: 'VARIABLE_ALIAS', id: 'a' } } },
        },
      },
    };
    expect(figmaVariablesToTokens(payload)).toEqual({});
  });
});

describe('compareTokens', () => {
  const figma = figmaVariablesToTokens(readVariables());
  const css = parseCssVariables(CSS);

  it('порівнює кольори після нормалізації, px як числа, і розгортає var()', () => {
    const result = compareTokens(figma, css);
    expect(result.matched).toEqual([
      '--color-button-bg',
      '--color-overlay',
      '--color-primary-500',
      '--font-family-base',
      '--spacing-md',
    ]);
    expect(result.mismatched).toEqual([{ name: '--radius-card-large', figma: '12', code: '10px' }]);
    expect(result.missingInCode).toEqual([]);
    expect(result.extraInCode).toEqual(['--unused-token']);
  });

  it('враховує допуск для чисел', () => {
    const result = compareTokens(figma, css, { tolerance: 2 });
    expect(result.mismatched).toEqual([]);
    expect(result.matched).toContain('--radius-card-large');
  });

  it('позначає розбіжність кольору й токени, яких немає в коді', () => {
    const result = compareTokens(
      { '--color-primary': '#1d4ed8', '--color-danger': '#ff0000' },
      { '--color-primary': 'rgb(29, 78, 217)' },
    );
    expect(result.mismatched).toEqual([{ name: '--color-primary', figma: '#1d4ed8', code: 'rgb(29, 78, 217)' }]);
    expect(result.missingInCode).toEqual(['--color-danger']);
  });

  it('на порожніх входах дає порожній результат', () => {
    expect(compareTokens({}, {})).toEqual({ matched: [], mismatched: [], missingInCode: [], extraInCode: [] });
  });
});
