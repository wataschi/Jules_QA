import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCaseFilterSql,
  buildOrderBy,
  buildSearchText,
  normalizeSearch,
  toFtsQuery,
} from '../../../src/registry/search.js';
import { listCases, resolveCaseIds, updateCase } from '../../../src/registry/cases-store.js';
import { createTempRegistry, seedCase, seedProject, type TempRegistry } from './temp-db.js';

describe('нормалізація пошуку', () => {
  it('складає регістр для української та російської', () => {
    expect(normalizeSearch('Акти')).toBe('акти');
    expect(normalizeSearch('АКТИ НЕДОСТУПНІ')).toBe('акти недоступні');
    expect(normalizeSearch('Договір')).toBe(normalizeSearch('ДОГОВІР'));
    expect(normalizeSearch('Ёлка')).toBe('елка');
    expect(normalizeSearch('Подъезд')).toBe('подезд');
  });

  it('прибирає пунктуацію й апострофи', () => {
    expect(normalizeSearch("Ін'єкція SQL — критично!")).toBe('інєкція sql критично');
    expect(normalizeSearch('  кілька   пробілів  ')).toBe('кілька пробілів');
  });

  it('search_text склеює title, checks, preconditions і tags', () => {
    const text = buildSearchText({
      title: 'Акти недоступні',
      checks: ['Відкрити Реєстр'],
      preconditions: 'Користувач Залогінений',
      tags: ['Регрес'],
    });
    expect(text).toContain('акти недоступні');
    expect(text).toContain('відкрити реєстр');
    expect(text).toContain('користувач залогінений');
    expect(text).toContain('регрес');
  });

  it('запит FTS — префіксні токени через AND', () => {
    expect(toFtsQuery('акти')).toBe('"акти"*');
    expect(toFtsQuery('Акти недоступні')).toBe('"акти"* AND "недоступні"*');
    expect(toFtsQuery('   ')).toBeNull();
    expect(toFtsQuery('лапки"всередині')).toBe('"лапки"* AND "всередині"*');
  });
});

describe('генерація SQL для фільтрів', () => {
  it('рекурсивний CTE для підсекцій', () => {
    const sql = buildCaseFilterSql('p1', { sectionIds: ['s1'], includeSubsections: true });
    expect(sql.cte).toContain('WITH RECURSIVE subtree');
    expect(sql.where).toContain('c.section_id IN (SELECT id FROM subtree)');
    expect(sql.params).toEqual(['s1', 'p1']);
  });

  it('без підсекцій — простий IN', () => {
    const sql = buildCaseFilterSql('p1', { sectionIds: ['s1', 's2'], includeSubsections: false });
    expect(sql.cte).toBe('');
    expect(sql.where).toContain('c.section_id IN (?, ?)');
    expect(sql.params).toEqual(['p1', 's1', 's2']);
  });

  it('теги через json_each, автоматизація через json_extract', () => {
    const sql = buildCaseFilterSql('p1', { tags: ['регрес'], automation: ['automated'] });
    expect(sql.where).toContain('json_each(c.tags)');
    expect(sql.where).toContain("json_extract(c.automation, '$.status') IN (?)");
  });

  it('сортування з префіксом «-» дає DESC', () => {
    expect(buildOrderBy('title')).toBe('ORDER BY c.title ASC, c.id ASC');
    expect(buildOrderBy('-updatedAt')).toBe('ORDER BY c.updated_at DESC, c.id ASC');
    expect(buildOrderBy('id')).toBe('ORDER BY c.id ASC');
    expect(buildOrderBy('-id')).toBe('ORDER BY c.id DESC');
    expect(buildOrderBy('wat')).toBe('ORDER BY c.id ASC');
    expect(buildOrderBy('priority')).toContain('CASE c.priority');
  });
});

describe('FTS5 у базі', () => {
  let temp: TempRegistry;

  beforeEach(() => {
    temp = createTempRegistry();
  });

  afterEach(() => {
    temp.cleanup();
  });

  it('«акти» знаходить кейс із заголовком «Акти недоступні…»', () => {
    const { project, section } = seedProject();
    const target = seedCase(project.id, section.id, {
      title: 'Акти недоступні для клієнта без підписаного договору',
      checks: ['Відкрити карту договору'],
    });
    seedCase(project.id, section.id, { title: 'Договір відкривається з реєстру' });

    for (const q of ['акти', 'Акти', 'АКТИ', 'акт']) {
      const found = listCases({ projectId: project.id, filter: { q } });
      expect(found.items.map((c) => c.id), `запит «${q}»`).toEqual([target.id]);
    }
  });

  it('шукає по checks, preconditions і tags', () => {
    const { project, section } = seedProject();
    const byCheck = seedCase(project.id, section.id, {
      title: 'Перший',
      checks: ['Кнопка «Завантажити» ВИДИМА'],
    });
    const byPrecondition = seedCase(project.id, section.id, {
      title: 'Другий',
      preconditions: 'Користувач має роль Адміністратор',
    });
    const byTag = seedCase(project.id, section.id, { title: 'Третій', tags: ['Смоук'] });

    expect(listCases({ projectId: project.id, filter: { q: 'завантажити' } }).items.map((c) => c.id)).toEqual([
      byCheck.id,
    ]);
    expect(listCases({ projectId: project.id, filter: { q: 'адміністратор' } }).items.map((c) => c.id)).toEqual([
      byPrecondition.id,
    ]);
    expect(listCases({ projectId: project.id, filter: { q: 'смоук' } }).items.map((c) => c.id)).toEqual([byTag.id]);
  });

  it('індекс оновлюється після правки й видалення з нього', () => {
    const { project, section } = seedProject();
    const target = seedCase(project.id, section.id, { title: 'Акти недоступні' });

    updateCase(target.id, { title: 'Договори недоступні' }, { reason: 'перейменування' });
    expect(listCases({ projectId: project.id, filter: { q: 'акти' } }).total).toBe(0);
    expect(listCases({ projectId: project.id, filter: { q: 'договори' } }).total).toBe(1);
  });

  it('пошук комбінується з іншими фільтрами й сортуванням', () => {
    const { project, section, child } = seedProject();
    const inChild = seedCase(project.id, child.id, { title: 'Акти у підсекції', priority: 'P1' });
    seedCase(project.id, section.id, { title: 'Акти у батьківській секції', priority: 'P3' });

    const both = listCases({ projectId: project.id, filter: { q: 'акти', sectionIds: [section.id] } });
    expect(both.total).toBe(2);

    const onlyChild = listCases({
      projectId: project.id,
      filter: { q: 'акти', sectionIds: [child.id], includeSubsections: false },
    });
    expect(onlyChild.items.map((c) => c.id)).toEqual([inChild.id]);

    const byPriority = listCases({ projectId: project.id, filter: { q: 'акти' }, sort: 'priority' });
    expect(byPriority.items[0]?.priority).toBe('P1');

    expect(resolveCaseIds(project.id, { q: 'акти' })).toHaveLength(2);
  });

  it('пагінація рахує total незалежно від сторінки', () => {
    const { project, section } = seedProject();
    for (let i = 0; i < 7; i += 1) {
      seedCase(project.id, section.id, { title: `Кейс номер ${i}` });
    }
    const first = listCases({ projectId: project.id, limit: 3, page: 1 });
    const third = listCases({ projectId: project.id, limit: 3, page: 3 });
    expect(first.total).toBe(7);
    expect(first.items).toHaveLength(3);
    expect(third.total).toBe(7);
    expect(third.items).toHaveLength(1);
    expect(first.items.map((c) => c.id)).not.toEqual(third.items.map((c) => c.id));
  });
});
