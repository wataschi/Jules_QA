/**
 * CSV для TestRail: побудова файлу експорту й розбір файлу для `pull`.
 *
 * Без зовнішніх залежностей — свій серіалізатор і свій парсер, бо вимоги
 * специфічні:
 *  - UTF-8 **з BOM** і CRLF, інакше Excel ламає кирилицю;
 *  - `template='steps_separated'` — кожен крок окремим рядком, решта полів лише
 *    в першому рядку кейса (так очікує імпорт TestRail);
 *  - `template='checklist'` — перевірки одним полем маркованим списком;
 *  - наш ID кейса завжди в колонці `mapping.idField` — це основа round-trip:
 *    без нього повторний імпорт створює дублі замість оновлення.
 *
 * `mapping.delimiter` — розділювач КОЛОНОК (дефолт `,`). Списки (теги,
 * посилання) склеюються через «, » і розбираються за `,` або `;`.
 */
import type { CaseKind, CasePriority, TestrailMapping } from '../registry/types.js';

export interface ExportCase {
  id: string;
  title: string;
  sectionPath: string;
  kind: CaseKind;
  priority: CasePriority;
  preconditions: string;
  checks: string[];
  steps: Array<{ action: string; expected: string }>;
  tags: string[];
  /** Посилання на блоки вимог. */
  refs: string[];
  testrailCaseId?: number;
}

export const BOM = '﻿';
const EOL = '\r\n';
const CHECK_MARKER = '- ';

/** Логічні поля експорту → дефолтні назви колонок TestRail. */
export const DEFAULT_COLUMNS = {
  id: 'custom_tc_id',
  testrailCaseId: 'ID',
  title: 'Title',
  sectionPath: 'Section',
  kind: 'Type',
  priority: 'Priority',
  preconditions: 'Preconditions',
  checks: 'Checklist',
  steps: 'Steps',
  stepExpected: 'Expected Result',
  tags: 'Tags',
  refs: 'References',
} as const;

export type ExportField = keyof typeof DEFAULT_COLUMNS;

/** Назва колонки для логічного поля: `mapping.fields` > `idField` > дефолт. */
export function columnName(field: ExportField, mapping: TestrailMapping): string {
  if (field === 'id') return mapping.fields.id ?? mapping.idField ?? DEFAULT_COLUMNS.id;
  return mapping.fields[field] ?? DEFAULT_COLUMNS[field];
}

function columnOrder(mapping: TestrailMapping): ExportField[] {
  const base: ExportField[] = [
    'id',
    'testrailCaseId',
    'title',
    'sectionPath',
    'kind',
    'priority',
    'preconditions',
    'checks',
    'steps',
  ];
  if (mapping.template === 'steps_separated') base.push('stepExpected');
  base.push('tags', 'refs');
  return base;
}

/* ─────────────────────────── кодування значень ────────────────────────── */

function mapKind(kind: CaseKind, mapping: TestrailMapping): string {
  const mapped = mapping.typeMap[kind];
  return typeof mapped === 'number' ? String(mapped) : kind;
}

function mapPriority(priority: CasePriority, mapping: TestrailMapping): string {
  const mapped = mapping.priorityMap[priority];
  return typeof mapped === 'number' ? String(mapped) : priority;
}

/** Перевірки → одне поле з маркерами. */
export function encodeChecks(checks: string[]): string {
  return checks
    .map((check) => `${CHECK_MARKER}${check.replace(/\r?\n/g, ' ').trim()}`)
    .join('\n');
}

export function decodeChecks(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•–—☐]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length > 0);
}

/** Кроки в одне поле (для `checklist`): «1. дія» + «→ очікуваний результат». */
export function encodeSteps(steps: ExportCase['steps']): string {
  const lines: string[] = [];
  steps.forEach((step, index) => {
    lines.push(`${index + 1}. ${step.action.replace(/\r?\n/g, ' ').trim()}`);
    const expected = step.expected.replace(/\r?\n/g, ' ').trim();
    if (expected) lines.push(`→ ${expected}`);
  });
  return lines.join('\n');
}

export function decodeSteps(text: string): ExportCase['steps'] {
  const steps: ExportCase['steps'] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const expected = line.match(/^(?:→|->|=>)\s*(.*)$/);
    if (expected && steps.length > 0) {
      const last = steps[steps.length - 1]!;
      last.expected = last.expected ? `${last.expected} ${expected[1]!.trim()}` : expected[1]!.trim();
      continue;
    }
    const action = line.replace(/^\d+[.)]\s*/, '').trim();
    if (action) steps.push({ action, expected: '' });
  }
  return steps;
}

function encodeList(values: string[]): string {
  return values.map((value) => value.trim()).filter(Boolean).join(', ');
}

function decodeList(text: string): string[] {
  return text
    .split(/[,;\n]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

/* ────────────────────────────── серіалізація ──────────────────────────── */

/**
 * Екранує значення: лапки подвоюються, «небезпечні» поля беруться в лапки.
 * Переноси всередині поля теж приводяться до CRLF — інакше Excel показує
 * багаторядковий крок одним рядком.
 */
export function csvEscape(value: string, delimiter: string): string {
  const normalized = value.replace(/\r\n|\r|\n/g, EOL);
  const needsQuotes =
    normalized.includes(delimiter) ||
    normalized.includes('"') ||
    normalized.includes('\n') ||
    normalized.includes('\r') ||
    normalized !== normalized.trim();
  if (!needsQuotes) return normalized;
  return `"${normalized.replace(/"/g, '""')}"`;
}

function row(values: string[], delimiter: string): string {
  return values.map((value) => csvEscape(value, delimiter)).join(delimiter);
}

/** Будує CSV для імпорту в TestRail. UTF-8 з BOM, CRLF. */
export function buildTestrailCsv(cases: ExportCase[], mapping: TestrailMapping): string {
  const delimiter = mapping.delimiter || ',';
  const fields = columnOrder(mapping);
  const lines: string[] = [row(fields.map((field) => columnName(field, mapping)), delimiter)];

  for (const item of cases) {
    const base: Record<ExportField, string> = {
      id: item.id,
      testrailCaseId: item.testrailCaseId ? String(item.testrailCaseId) : '',
      title: item.title,
      sectionPath: item.sectionPath,
      kind: mapKind(item.kind, mapping),
      priority: mapPriority(item.priority, mapping),
      preconditions: item.preconditions,
      checks: encodeChecks(item.checks),
      steps: '',
      stepExpected: '',
      tags: encodeList(item.tags),
      refs: encodeList(item.refs),
    };

    if (mapping.template === 'steps_separated') {
      const steps = item.steps.length > 0 ? item.steps : [];
      if (steps.length === 0) {
        lines.push(row(fields.map((field) => base[field]), delimiter));
        continue;
      }
      steps.forEach((step, index) => {
        // Решта полів — лише в першому рядку кейса: так TestRail склеює кроки
        // в один кейс, а не плодить копії.
        const values = fields.map((field) => {
          if (field === 'steps') return step.action;
          if (field === 'stepExpected') return step.expected;
          return index === 0 ? base[field] : '';
        });
        lines.push(row(values, delimiter));
      });
      continue;
    }

    base.steps = encodeSteps(item.steps);
    lines.push(row(fields.map((field) => base[field]), delimiter));
  }

  return BOM + lines.join(EOL) + EOL;
}

/* ──────────────────────────────── розбір ─────────────────────────────── */

/** Розбирає CSV у матрицю рядків (лапки, CRLF, переноси всередині полів). */
export function parseCsvRows(text: string, delimiter: string): string[][] {
  const input = text.startsWith(BOM) ? text.slice(1) : text;
  const rows: string[][] = [];
  let current: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      current.push(field);
      field = '';
      continue;
    }
    if (char === '\r') {
      if (input[i + 1] === '\n') i += 1;
      current.push(field);
      rows.push(current);
      current = [];
      field = '';
      continue;
    }
    if (char === '\n') {
      current.push(field);
      rows.push(current);
      current = [];
      field = '';
      continue;
    }
    field += char;
  }
  if (field.length > 0 || current.length > 0) {
    current.push(field);
    rows.push(current);
  }
  return rows.filter((r) => r.some((value) => value.trim().length > 0));
}

function reverseNumberMap(map: Record<string, number>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(map)) out.set(String(value), key);
  return out;
}

const KNOWN_KINDS = new Set<CaseKind>([
  'positive',
  'negative',
  'neutral',
  'security',
  'a11y',
  'performance',
]);
const KNOWN_PRIORITIES = new Set<CasePriority>(['P1', 'P2', 'P3', 'P4']);

/** Розбирає CSV, отриманий з TestRail (або наш власний експорт). */
export function parseTestrailCsv(
  text: string,
  mapping: TestrailMapping,
): { cases: Partial<ExportCase>[]; warnings: string[] } {
  const warnings: string[] = [];
  const delimiter = mapping.delimiter || ',';
  const rows = parseCsvRows(text, delimiter);
  if (rows.length === 0) return { cases: [], warnings: ['CSV порожній.'] };

  const header = (rows[0] ?? []).map((value) => value.trim());
  const indexByColumn = new Map<string, number>();
  header.forEach((name, index) => {
    const key = name.toLowerCase();
    if (!indexByColumn.has(key)) indexByColumn.set(key, index);
  });

  const fields = columnOrder(mapping);
  const columnIndex = new Map<ExportField, number>();
  for (const field of fields) {
    const index = indexByColumn.get(columnName(field, mapping).toLowerCase());
    if (index !== undefined) columnIndex.set(field, index);
  }

  const idIndex = columnIndex.get('id');
  if (idIndex === undefined) {
    warnings.push(
      `У CSV немає колонки «${columnName('id', mapping)}» з нашим ID — round-trip неможливий, ` +
        'кейси прийдуть без привʼязки.',
    );
  }
  for (const required of ['title'] as ExportField[]) {
    if (!columnIndex.has(required)) {
      warnings.push(`У CSV немає колонки «${columnName(required, mapping)}».`);
    }
  }

  const typeReverse = reverseNumberMap(mapping.typeMap);
  const priorityReverse = reverseNumberMap(mapping.priorityMap);

  // CRLF всередині поля — деталь формату; далі працюємо з LF.
  const cell = (record: string[], field: ExportField): string => {
    const index = columnIndex.get(field);
    if (index === undefined) return '';
    return (record[index] ?? '').replace(/\r\n/g, '\n').trim();
  };

  const cases: Partial<ExportCase>[] = [];
  const stepsSeparated = mapping.template === 'steps_separated';

  for (let r = 1; r < rows.length; r += 1) {
    const record = rows[r]!;
    const rawId = idIndex === undefined ? '' : (record[idIndex] ?? '').trim();
    const title = cell(record, 'title');
    const action = cell(record, 'steps');
    const expected = cell(record, 'stepExpected');

    // Рядок-продовження: немає ні ID, ні заголовка — це наступний крок кейса.
    const isContinuation = stepsSeparated && !rawId && !title && cases.length > 0;
    if (isContinuation) {
      const previous = cases[cases.length - 1]!;
      if (action || expected) {
        previous.steps = [...(previous.steps ?? []), { action, expected }];
      }
      continue;
    }

    if (!rawId && !title) {
      warnings.push(`Рядок ${r + 1}: немає ні ID, ні заголовка — пропущено.`);
      continue;
    }

    const parsed: Partial<ExportCase> = {};
    if (rawId) parsed.id = rawId;
    if (title) parsed.title = title;

    const section = cell(record, 'sectionPath');
    if (section) parsed.sectionPath = section;

    const preconditions = cell(record, 'preconditions');
    if (preconditions) parsed.preconditions = preconditions;

    const kindRaw = cell(record, 'kind');
    if (kindRaw) {
      const candidate = typeReverse.get(kindRaw) ?? kindRaw.toLowerCase();
      if (KNOWN_KINDS.has(candidate as CaseKind)) {
        parsed.kind = candidate as CaseKind;
      } else {
        warnings.push(`Рядок ${r + 1}: невідомий тип «${kindRaw}» — поле не заповнено.`);
      }
    }

    const priorityRaw = cell(record, 'priority');
    if (priorityRaw) {
      const candidate = priorityReverse.get(priorityRaw) ?? priorityRaw.toUpperCase();
      if (KNOWN_PRIORITIES.has(candidate as CasePriority)) {
        parsed.priority = candidate as CasePriority;
      } else {
        warnings.push(`Рядок ${r + 1}: невідомий пріоритет «${priorityRaw}» — поле не заповнено.`);
      }
    }

    const checksRaw = cell(record, 'checks');
    if (checksRaw) parsed.checks = decodeChecks(checksRaw);

    const tagsRaw = cell(record, 'tags');
    if (tagsRaw) parsed.tags = decodeList(tagsRaw);

    const refsRaw = cell(record, 'refs');
    if (refsRaw) parsed.refs = decodeList(refsRaw);

    const testrailIdRaw = cell(record, 'testrailCaseId').replace(/^C/i, '');
    if (testrailIdRaw) {
      const numeric = Number(testrailIdRaw);
      if (Number.isInteger(numeric) && numeric > 0) parsed.testrailCaseId = numeric;
      else warnings.push(`Рядок ${r + 1}: нечисловий ID TestRail «${testrailIdRaw}» — проігноровано.`);
    }

    if (stepsSeparated) {
      parsed.steps = action || expected ? [{ action, expected }] : [];
    } else if (action) {
      parsed.steps = decodeSteps(action);
    }

    cases.push(parsed);
  }

  return { cases, warnings };
}
