/**
 * Історія змін кейсів. Будь-яка зміна кейса інкрементує `version`
 * і пише сюди ревізію з `patch` (лише змінені поля, before/after) і `reason`.
 */
import { execute, fromJson, nowIso, query, toJson, type Row } from './db.js';
import { newId } from './ids.js';
import { revisionSchema, type Revision } from './types.js';

export type PatchMap = Record<string, { before: unknown; after: unknown }>;

function rowToRevision(row: Row): Revision {
  return revisionSchema.parse({
    id: row.id,
    caseId: row.case_id,
    version: Number(row.version),
    at: row.at,
    author: row.author ?? 'system',
    reason: row.reason ?? '',
    patch: fromJson<PatchMap>(row.patch, {}),
  });
}

export interface AddRevisionInput {
  caseId: string;
  version: number;
  patch: PatchMap;
  reason?: string;
  author?: string;
  /** Пакет масової операції — потрібен для `POST /cases/bulk/undo`. */
  batchId?: string;
  at?: string;
}

export function addRevision(input: AddRevisionInput): Revision {
  const id = newId('rev');
  execute(
    `INSERT INTO revisions (id, case_id, version, at, author, reason, patch, batch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.caseId,
      input.version,
      input.at ?? nowIso(),
      input.author ?? 'system',
      input.reason ?? '',
      toJson(input.patch ?? {}),
      input.batchId ?? null,
    ],
  );
  return rowToRevision(
    query<Row>('SELECT * FROM revisions WHERE id = ?', [id])[0] as Row,
  );
}

export function listRevisions(caseId: string, limit = 200): Revision[] {
  return query<Row>(
    'SELECT * FROM revisions WHERE case_id = ? ORDER BY version DESC, at DESC LIMIT ?',
    [caseId, limit],
  ).map(rowToRevision);
}

/** Ревізії одного пакета масової операції — від найновішої до найстарішої. */
export function listBatchRevisions(batchId: string): Revision[] {
  return query<Row>(
    'SELECT * FROM revisions WHERE batch_id = ? ORDER BY at DESC, version DESC',
    [batchId],
  ).map(rowToRevision);
}

export function batchExists(batchId: string): boolean {
  return query<Row>('SELECT 1 FROM revisions WHERE batch_id = ? LIMIT 1', [batchId]).length > 0;
}

/** Порівнює два знімки кейса й повертає patch лише зі зміненими полями. */
export function diffSnapshots(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields?: readonly string[],
): PatchMap {
  const keys = fields ?? Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
  const patch: PatchMap = {};
  for (const key of keys) {
    if (key === 'version' || key === 'updatedAt' || key === 'updatedBy') continue;
    const a = before[key];
    const b = after[key];
    if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) continue;
    patch[key] = { before: a ?? null, after: b ?? null };
  }
  return patch;
}
