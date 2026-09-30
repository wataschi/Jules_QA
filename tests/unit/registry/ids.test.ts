import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CASE_ID_PATTERN,
  formatCaseId,
  generateSectionCode,
  nextCaseId,
  slugify,
  transliterate,
} from '../../../src/registry/ids.js';
import { createSection, sectionPath } from '../../../src/registry/sections-store.js';
import { getCase, updateCase } from '../../../src/registry/cases-store.js';
import { createTempRegistry, seedCase, seedProject, type TempRegistry } from './temp-db.js';

describe('транслітерація й коди секцій', () => {
  it('переводить українську та російську в латиницю', () => {
    expect(transliterate('Карта договору')).toBe('karta dohovoru');
    expect(transliterate('Акти')).toBe('akty');
    expect(transliterate('Щоденний звіт')).toBe('shchodennyy zvit');
    expect(transliterate("Ін'єкція")).toBe('inyektsiya');
    expect(transliterate('Общие настройки')).toBe('obshchye nastroyky');
  });

  it('slugify дає латинський слаг', () => {
    expect(slugify('Кібер Проєкт')).toBe('kiber-proyekt');
    expect(slugify('!!!', 'fallback')).toBe('fallback');
  });

  it('код секції — 3–6 літер і відповідає схемі', () => {
    const code = generateSectionCode('Карта договору');
    expect(code.length).toBeGreaterThanOrEqual(3);
    expect(code.length).toBeLessThanOrEqual(6);
    expect(code).toMatch(/^[A-Z][A-Z0-9]{1,7}$/);
  });

  it('обходить уже зайняті коди в проєкті', () => {
    const first = generateSectionCode('Акти');
    const second = generateSectionCode('Акти', [first]);
    const third = generateSectionCode('Акти', [first, second]);
    expect(new Set([first, second, third]).size).toBe(3);
    for (const code of [first, second, third]) {
      expect(code).toMatch(/^[A-Z][A-Z0-9]{1,7}$/);
    }
  });

  it('коротку назву доповнює до 3 символів', () => {
    expect(generateSectionCode('Я').length).toBeGreaterThanOrEqual(3);
  });
});

describe('ID кейсів', () => {
  let temp: TempRegistry;

  beforeEach(() => {
    temp = createTempRegistry();
  });

  afterEach(() => {
    temp.cleanup();
  });

  it('формат <KEY>-<CODE>-<NNN> із трьома цифрами', () => {
    expect(formatCaseId('CYBER', 'KARDOG', 7)).toBe('CYBER-KARDOG-007');
    expect(formatCaseId('CYBER', 'AKT', 1234)).toBe('CYBER-AKT-1234');
    expect(CASE_ID_PATTERN.test('CYBER-KARDOG-007')).toBe(true);
    expect(CASE_ID_PATTERN.test('CYBER-KARDOG-7')).toBe(false);
  });

  it('лічильник рахує в межах секції', () => {
    const { project, section, child } = seedProject();
    const a = nextCaseId(project.key, section.id, section.code);
    const b = nextCaseId(project.key, section.id, section.code);
    const c = nextCaseId(project.key, child.id, child.code);

    expect(a.endsWith('-001')).toBe(true);
    expect(b.endsWith('-002')).toBe(true);
    expect(c.endsWith('-001')).toBe(true);
    expect(c.startsWith(`${project.key}-${child.code}-`)).toBe(true);
  });

  it('ID не змінюється при перейменуванні й переміщенні між секціями', () => {
    const { project, section, child } = seedProject();
    const created = seedCase(project.id, section.id, { title: 'Акти доступні' });
    const originalId = created.id;
    expect(originalId.includes(section.code)).toBe(true);

    updateCase(originalId, { title: 'Акти недоступні' }, { reason: 'перейменування' });
    updateCase(originalId, { sectionId: child.id }, { reason: 'переміщення' });

    const moved = getCase(originalId);
    expect(moved?.id).toBe(originalId);
    expect(moved?.sectionId).toBe(child.id);
    expect(moved?.title).toBe('Акти недоступні');
    // Код у ID лишається від секції, де кейс народився.
    expect(originalId.includes(section.code)).toBe(true);
  });

  it('видалений номер не переюзується', () => {
    const { project, section } = seedProject();
    const first = seedCase(project.id, section.id, { title: 'Перший' });
    const second = seedCase(project.id, section.id, { title: 'Другий' });
    expect(first.id).not.toBe(second.id);
    const third = nextCaseId(project.key, section.id, section.code);
    expect(third.endsWith('-003')).toBe(true);
  });

  it('шлях секції збирається з батьків', () => {
    const { project, section } = seedProject();
    const deep = createSection({ projectId: project.id, name: 'Підписання', parentId: section.id });
    expect(sectionPath(deep.id)).toBe('Карта договору / Підписання');
  });
});
