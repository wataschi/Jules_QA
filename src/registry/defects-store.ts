/**
 * Дефекти з дедуплікацією: `dedupKey` = sha256(caseId + нормалізований заголовок).
 * Той самий дефект не множиться на кожному прогоні — інкрементується `seenCount`.
 */
import { createHash } from 'node:crypto';
import { execute, nowIso, query, queryOne, scalar, type Row } from './db.js';
import { newId } from './ids.js';
import { normalizeSearch } from './search.js';
import { defectSchema, type Defect, type Page } from './types.js';

function rowToDefect(row: Row): Defect {
  return defectSchema.parse({
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    details: row.details ?? '',
    severity: row.severity,
    status: row.status,
    caseId: row.case_id ?? undefined,
    runItemId: row.run_item_id ?? undefined,
    dedupKey: row.dedup_key,
    seenCount: Number(row.seen_count ?? 1),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    externalKey: row.external_key ?? undefined,
    externalUrl: row.external_url ?? undefined,
  });
}

/** Ключ дедуплікації: кейс + нормалізований заголовок. */
export function buildDedupKey(caseId: string | undefined, title: string): string {
  const base = `${caseId ?? 'no-case'}::${normalizeSearch(title)}`;
  return createHash('sha256').update(base, 'utf8').digest('hex').slice(0, 32);
}

export interface UpsertDefectInput {
  projectId: string;
  title: string;
  details?: string;
  severity?: Defect['severity'];
  status?: Defect['status'];
  caseId?: string;
  runItemId?: string;
  dedupKey?: string;
}

/** Створює дефект або піднімає `seenCount` існуючого з тим самим `dedupKey`. */
export function upsertDefect(input: UpsertDefectInput): Defect {
  const dedupKey = input.dedupKey ?? buildDedupKey(input.caseId, input.title);
  const at = nowIso();
  const existing = queryOne<Row>('SELECT * FROM defects WHERE project_id = ? AND dedup_key = ?', [
    input.projectId,
    dedupKey,
  ]);

  if (existing) {
    execute(
      `UPDATE defects
         SET seen_count = seen_count + 1,
             last_seen_at = ?,
             run_item_id = COALESCE(?, run_item_id),
             details = CASE WHEN ? <> '' THEN ? ELSE details END,
             severity = COALESCE(?, severity),
             status = CASE WHEN status IN ('fixed', 'wontfix') THEN 'open' ELSE status END
       WHERE id = ?`,
      [
        at,
        input.runItemId ?? null,
        input.details ?? '',
        input.details ?? '',
        input.severity ?? null,
        existing.id,
      ],
    );
    return rowToDefect(queryOne<Row>('SELECT * FROM defects WHERE id = ?', [existing.id]) as Row);
  }

  const id = newId('def');
  execute(
    `INSERT INTO defects
       (id, project_id, title, details, severity, status, case_id, run_item_id, dedup_key,
        seen_count, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      id,
      input.projectId,
      input.title,
      input.details ?? '',
      input.severity ?? 'medium',
      input.status ?? 'open',
      input.caseId ?? null,
      input.runItemId ?? null,
      dedupKey,
      at,
      at,
    ],
  );
  return rowToDefect(queryOne<Row>('SELECT * FROM defects WHERE id = ?', [id]) as Row);
}

export interface ListDefectsOptions {
  projectId: string;
  status?: string;
  caseId?: string;
  page?: number;
  limit?: number;
}

export function listDefects(options: ListDefectsOptions): Page<Defect> {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 50)));
  const where = ['project_id = ?'];
  const params: unknown[] = [options.projectId];
  if (options.status) {
    where.push('status = ?');
    params.push(options.status);
  }
  if (options.caseId) {
    where.push('case_id = ?');
    params.push(options.caseId);
  }
  const clause = where.join(' AND ');

  const total = Number(scalar<number>(`SELECT COUNT(*) FROM defects WHERE ${clause}`, params) ?? 0);
  const items = query<Row>(
    `SELECT * FROM defects WHERE ${clause} ORDER BY last_seen_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, (page - 1) * limit],
  ).map(rowToDefect);
  return { items, total, page, limit };
}

export function getDefect(id: string): Defect | null {
  const row = queryOne<Row>('SELECT * FROM defects WHERE id = ?', [id]);
  return row ? rowToDefect(row) : null;
}

export interface UpdateDefectPatch {
  title?: string;
  details?: string;
  severity?: Defect['severity'];
  status?: Defect['status'];
  externalKey?: string;
  externalUrl?: string;
}

export function updateDefect(id: string, patch: UpdateDefectPatch): Defect {
  const existing = getDefect(id);
  if (!existing) throw new Error(`Дефект «${id}» не знайдено`);

  const columns: Record<keyof UpdateDefectPatch, string> = {
    title: 'title',
    details: 'details',
    severity: 'severity',
    status: 'status',
    externalKey: 'external_key',
    externalUrl: 'external_url',
  };
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [field, column] of Object.entries(columns) as Array<[keyof UpdateDefectPatch, string]>) {
    if (patch[field] === undefined) continue;
    sets.push(`${column} = ?`);
    params.push(patch[field]);
  }
  if (sets.length === 0) return existing;
  params.push(id);
  execute(`UPDATE defects SET ${sets.join(', ')} WHERE id = ?`, params);
  return getDefect(id) as Defect;
}

export function countOpenDefects(projectId: string): number {
  return Number(
    scalar<number>(
      `SELECT COUNT(*) FROM defects WHERE project_id = ? AND status IN ('open', 'triaged')`,
      [projectId],
    ) ?? 0,
  );
}
