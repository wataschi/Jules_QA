/**
 * Пошук і фільтрація кейсів.
 *
 * Найважливіша деталь: `lower()` у SQLite працює лише з ASCII, тому
 * регістронезалежний пошук для української та російської робиться в JS —
 * нормалізований текст лягає в тіньову колонку `cases.search_text`, яку
 * індексує FTS5. Запит нормалізується тією самою функцією, тому «акти»,
 * «Акти» й «АКТИ» дають однаковий токен.
 *
 * Тут лише чисті функції й генерація SQL — жодного доступу до бази,
 * щоб фільтри можна було тестувати окремо.
 */
import type { CaseFilter } from './types.js';

/** Нормалізація рядка для пошуку: регістр, ё/ъ, апострофи, пунктуація. */
export function normalizeSearch(input: string): string {
  return input
    .normalize('NFC')
    .toLowerCase()
    .replace(/[ёӑ]/g, 'е') // ё, ӑ-подібні → е
    .replace(/ъ/g, '') // твердий знак не несе змісту для пошуку
    .replace(/[’ʼʻ`'´]/g, '') // апострофи: «ін'єкція» == «інєкція»
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export interface SearchableCase {
  title: string;
  checks?: string[];
  preconditions?: string;
  tags?: string[];
}

/**
 * Зліпок для FTS: title + checks + preconditions + tags одним нормалізованим
 * рядком. Саме він лягає в `cases.search_text`, а тригери віддають його в
 * `cases_fts`.
 */
export function buildSearchText(input: SearchableCase): string {
  const parts = [
    input.title ?? '',
    (input.checks ?? []).join(' '),
    input.preconditions ?? '',
    (input.tags ?? []).join(' '),
  ];
  return normalizeSearch(parts.join(' \n '));
}

/**
 * Перетворює користувацький запит у вираз MATCH для FTS5.
 * Кожен токен — префіксний, усі токени обов'язкові (AND).
 * Порожній запит → `null` (фільтр не застосовується).
 */
export function toFtsQuery(raw: string): string | null {
  const normalized = normalizeSearch(raw ?? '');
  if (!normalized) return null;
  const tokens = normalized.split(' ').filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(' AND ');
}

export interface SqlFragment {
  /** Префікс `WITH RECURSIVE ...`, якщо потрібне піддерево секцій. */
  cte: string;
  /** Додаткові JOIN-и (FTS). */
  joins: string;
  /** Умови без слова WHERE, уже склеєні через AND. */
  where: string;
  params: unknown[];
}

/** Порядок пріоритетів для сортування: P1 найважливіший. */
const PRIORITY_ORDER = `CASE c.priority WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END`;

const SORT_COLUMNS: Record<string, string> = {
  id: 'c.id',
  title: 'c.title',
  updatedAt: 'c.updated_at',
  createdAt: 'c.created_at',
  priority: PRIORITY_ORDER,
};

/**
 * `sort=-updatedAt` → `ORDER BY c.updated_at DESC, c.id ASC`.
 * Невідоме поле — тихо падає на дефолт `id`.
 */
export function buildOrderBy(sort?: string): string {
  const raw = (sort ?? 'id').trim();
  const desc = raw.startsWith('-');
  const key = desc ? raw.slice(1) : raw;
  const column = SORT_COLUMNS[key] ?? SORT_COLUMNS.id;
  const direction = desc ? 'DESC' : 'ASC';
  if (column === SORT_COLUMNS.id) return `ORDER BY c.id ${direction}`;
  return `ORDER BY ${column} ${direction}, c.id ASC`;
}

/**
 * Збирає SQL-фільтр для `cases` за `CaseFilter`.
 * Усе фільтрування — на рівні SQL: підсекції через рекурсивний CTE,
 * теги через `json_each`, автоматизація через `json_extract`.
 */
export function buildCaseFilterSql(projectId: string, filter: Partial<CaseFilter> = {}): SqlFragment {
  const where: string[] = ['c.project_id = ?'];
  const params: unknown[] = [projectId];
  let cte = '';
  let joins = '';

  const sectionIds = (filter.sectionIds ?? []).filter(Boolean);
  if (sectionIds.length > 0) {
    const marks = sectionIds.map(() => '?').join(', ');
    if (filter.includeSubsections === false) {
      where.push(`c.section_id IN (${marks})`);
      params.push(...sectionIds);
    } else {
      // CTE-параметри йдуть першими, тому їх треба покласти на початок списку.
      cte = `WITH RECURSIVE subtree(id) AS (
  SELECT id FROM sections WHERE id IN (${marks})
  UNION
  SELECT s.id FROM sections s JOIN subtree t ON s.parent_id = t.id
)`;
      where.push('c.section_id IN (SELECT id FROM subtree)');
      params.unshift(...sectionIds);
    }
  }

  const tags = (filter.tags ?? []).filter(Boolean);
  for (const tag of tags) {
    where.push('EXISTS (SELECT 1 FROM json_each(c.tags) jt WHERE jt.value = ?)');
    params.push(tag);
  }

  const inList = (column: string, values?: readonly string[]): void => {
    const list = (values ?? []).filter(Boolean);
    if (list.length === 0) return;
    where.push(`${column} IN (${list.map(() => '?').join(', ')})`);
    params.push(...list);
  };

  inList('c.kind', filter.kinds);
  inList('c.priority', filter.priorities);
  inList('c.status', filter.statuses);
  inList(`json_extract(c.automation, '$.status')`, filter.automation);

  const match = filter.q ? toFtsQuery(filter.q) : null;
  if (match) {
    joins += ' JOIN cases_fts ON cases_fts.rowid = c.rowid';
    where.push('cases_fts MATCH ?');
    params.push(match);
  }

  return { cte, joins, where: where.join(' AND '), params };
}
