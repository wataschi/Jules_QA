/** Вибірки кейсів: статичний список або збережений фільтр. */
import { execute, fromJson, nowIso, query, queryOne, toJson, type Row } from './db.js';
import { slugify } from './ids.js';
import { getCaseListItems, listAllCases } from './cases-store.js';
import {
  selectionInputSchema,
  selectionSchema,
  type CaseFilter,
  type CaseListItem,
  type Selection,
} from './types.js';

function rowToSelection(row: Row): Selection {
  return selectionSchema.parse({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description ?? '',
    mode: row.mode ?? 'filter',
    caseIds: fromJson<string[]>(row.case_ids, []),
    filter: fromJson<CaseFilter | undefined>(row.filter, undefined),
    stopOnFailure: Boolean(row.stop_on_failure),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function listSelections(projectId: string): Selection[] {
  return query<Row>('SELECT * FROM selections WHERE project_id = ? ORDER BY name', [projectId]).map(
    rowToSelection,
  );
}

export function getSelection(id: string): Selection | null {
  const row = queryOne<Row>('SELECT * FROM selections WHERE id = ?', [id]);
  return row ? rowToSelection(row) : null;
}

export function requireSelection(id: string): Selection {
  const selection = getSelection(id);
  if (!selection) throw new Error(`Вибірку «${id}» не знайдено`);
  return selection;
}

export interface CreateSelectionInput {
  projectId: string;
  name: string;
  description?: string;
  mode?: 'static' | 'filter';
  caseIds?: string[];
  filter?: CaseFilter;
  stopOnFailure?: boolean;
  /** Дозволяє скрипту міграції задати стабільний ID для ідемпотентності. */
  id?: string;
}

export function createSelection(input: CreateSelectionInput): Selection {
  const parsed = selectionInputSchema.parse(input);
  const id = uniqueSelectionId(input.id ?? slugify(parsed.name, 'selection'));
  const at = nowIso();
  execute(
    `INSERT INTO selections
       (id, project_id, name, description, mode, case_ids, filter, stop_on_failure, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      parsed.projectId,
      parsed.name,
      parsed.description ?? '',
      parsed.mode ?? (parsed.caseIds && parsed.caseIds.length > 0 ? 'static' : 'filter'),
      toJson(parsed.caseIds ?? []),
      parsed.filter ? toJson(parsed.filter) : null,
      parsed.stopOnFailure ?? false,
      at,
      at,
    ],
  );
  return requireSelection(id);
}

export interface UpdateSelectionPatch {
  name?: string;
  description?: string;
  mode?: 'static' | 'filter';
  caseIds?: string[];
  filter?: CaseFilter | null;
  stopOnFailure?: boolean;
}

export function updateSelection(id: string, patch: UpdateSelectionPatch): Selection {
  const existing = requireSelection(id);
  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.name !== undefined) {
    sets.push('name = ?');
    params.push(patch.name);
  }
  if (patch.description !== undefined) {
    sets.push('description = ?');
    params.push(patch.description);
  }
  if (patch.mode !== undefined) {
    sets.push('mode = ?');
    params.push(patch.mode);
  }
  if (patch.caseIds !== undefined) {
    sets.push('case_ids = ?');
    params.push(toJson(patch.caseIds));
  }
  if ('filter' in patch) {
    sets.push('filter = ?');
    params.push(patch.filter ? toJson(patch.filter) : null);
  }
  if (patch.stopOnFailure !== undefined) {
    sets.push('stop_on_failure = ?');
    params.push(patch.stopOnFailure);
  }
  if (sets.length === 0) return existing;

  sets.push('updated_at = ?');
  params.push(nowIso(), id);
  execute(`UPDATE selections SET ${sets.join(', ')} WHERE id = ?`, params);
  return requireSelection(id);
}

export function deleteSelection(id: string): void {
  requireSelection(id);
  execute('DELETE FROM selections WHERE id = ?', [id]);
}

export interface ResolvedSelection {
  caseIds: string[];
  cases: CaseListItem[];
}

/**
 * Для `mode='static'` — збережений порядок ID (без зниклих кейсів);
 * для `mode='filter'` — перерахунок наживо на рівні SQL.
 */
export function resolveSelection(id: string): ResolvedSelection {
  const selection = requireSelection(id);

  if (selection.mode === 'static') {
    const cases = getCaseListItems(selection.caseIds).filter(
      (c) => c.projectId === selection.projectId,
    );
    return { caseIds: cases.map((c) => c.id), cases };
  }

  const filter = selection.filter ?? {};
  const cases = listAllCases(selection.projectId, filter);
  return { caseIds: cases.map((c) => c.id), cases };
}

function uniqueSelectionId(base: string): string {
  let candidate = base;
  let counter = 2;
  while (queryOne('SELECT id FROM selections WHERE id = ?', [candidate])) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  return candidate;
}
