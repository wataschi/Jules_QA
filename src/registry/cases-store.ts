/**
 * Сховище кейсів: CRUD, список із фільтрами й пагінацією на рівні SQL,
 * ревізії на кожну зміну, видача стабільних ID.
 */
import { execute, fromJson, nowIso, query, queryOne, scalar, toJson, tx, type Row } from './db.js';
import { nextCaseId } from './ids.js';
import { requireProject } from './projects-store.js';
import { requireSection, sectionPathMap } from './sections-store.js';
import { addRevision, diffSnapshots, type PatchMap } from './revisions-store.js';
import { buildCaseFilterSql, buildOrderBy, buildSearchText } from './search.js';
import {
  caseInputSchema,
  caseSchema,
  type Case,
  type CaseAutomation,
  type CaseFilter,
  type CaseInput,
  type CaseListItem,
  type CaseStep,
  type CaseTestrail,
  type ItemStatus,
  type Page,
  type Revision,
  type RunItem,
} from './types.js';

export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 50;

/** Поля кейса, які можна змінювати через PATCH / масові операції. */
const MUTABLE_COLUMNS: Record<string, string> = {
  sectionId: 'section_id',
  title: 'title',
  kind: 'kind',
  priority: 'priority',
  status: 'status',
  preconditions: 'preconditions',
  checks: 'checks',
  steps: 'steps',
  tags: 'tags',
  owner: 'owner',
  automation: 'automation',
  testrail: 'testrail',
};

const JSON_FIELDS = new Set(['checks', 'steps', 'tags', 'automation', 'testrail']);

export function rowToCase(row: Row): Case {
  return caseSchema.parse({
    id: row.id,
    projectId: row.project_id,
    sectionId: row.section_id,
    title: row.title,
    kind: row.kind,
    priority: row.priority,
    status: row.status,
    preconditions: row.preconditions ?? '',
    checks: fromJson<string[]>(row.checks, []),
    steps: fromJson<CaseStep[]>(row.steps, []),
    tags: fromJson<string[]>(row.tags, []),
    owner: row.owner ?? undefined,
    automation: fromJson<CaseAutomation>(row.automation, { status: 'manual' }),
    testrail: fromJson<CaseTestrail>(row.testrail, {}),
    version: Number(row.version ?? 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by ?? undefined,
    updatedBy: row.updated_by ?? undefined,
  });
}

export function getCase(id: string): Case | null {
  const row = queryOne<Row>('SELECT * FROM cases WHERE id = ?', [id]);
  return row ? rowToCase(row) : null;
}

export function requireCase(id: string): Case {
  const found = getCase(id);
  if (!found) throw new Error(`Кейс «${id}» не знайдено`);
  return found;
}

const DERIVED_SELECT = `
  (SELECT COUNT(*) FROM coverage cv WHERE cv.case_id = c.id AND cv.kind = 'quote')   AS cov_quote,
  (SELECT COUNT(*) FROM coverage cv WHERE cv.case_id = c.id AND cv.kind = 'derived') AS cov_derived,
  (SELECT ri.status     FROM run_items ri WHERE ri.case_id = c.id AND ri.status <> 'untested' ORDER BY ri.updated_at DESC LIMIT 1) AS last_status,
  (SELECT ri.updated_at FROM run_items ri WHERE ri.case_id = c.id AND ri.status <> 'untested' ORDER BY ri.updated_at DESC LIMIT 1) AS last_at,
  (SELECT ri.run_id     FROM run_items ri WHERE ri.case_id = c.id AND ri.status <> 'untested' ORDER BY ri.updated_at DESC LIMIT 1) AS last_run`;

function rowToListItem(row: Row, paths: Map<string, string>): CaseListItem {
  const base = rowToCase(row);
  const item: CaseListItem = {
    ...base,
    sectionPath: paths.get(base.sectionId) ?? '',
    coverage: { quote: Number(row.cov_quote ?? 0), derived: Number(row.cov_derived ?? 0) },
  };
  if (row.last_status) {
    item.lastResult = {
      status: row.last_status as ItemStatus,
      at: String(row.last_at ?? ''),
      runId: String(row.last_run ?? ''),
    };
  }
  return item;
}

export interface ListCasesOptions {
  projectId: string;
  filter?: Partial<CaseFilter>;
  sort?: string;
  page?: number;
  limit?: number;
}

export function listCases(options: ListCasesOptions): Page<CaseListItem> {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT)));
  const { cte, joins, where, params } = buildCaseFilterSql(options.projectId, options.filter ?? {});
  const order = buildOrderBy(options.sort);

  const total = Number(
    scalar<number>(`${cte} SELECT COUNT(*) FROM cases c${joins} WHERE ${where}`, params) ?? 0,
  );
  const rows = query<Row>(
    `${cte} SELECT c.*, ${DERIVED_SELECT} FROM cases c${joins} WHERE ${where} ${order} LIMIT ? OFFSET ?`,
    [...params, limit, (page - 1) * limit],
  );
  const paths = sectionPathMap(options.projectId);
  return { items: rows.map((row) => rowToListItem(row, paths)), total, page, limit };
}

/** Кейси зі похідними полями за списком ID, у порядку переданих ID. */
export function getCaseListItems(ids: readonly string[]): CaseListItem[] {
  if (ids.length === 0) return [];
  const rows = query<Row>(
    `SELECT c.*, ${DERIVED_SELECT} FROM cases c WHERE c.id IN (${ids.map(() => '?').join(', ')})`,
    [...ids],
  );
  if (rows.length === 0) return [];
  const paths = sectionPathMap(String(rows[0]?.project_id ?? ''));
  const byId = new Map(rows.map((row) => [String(row.id), rowToListItem(row, paths)]));
  return ids.map((id) => byId.get(id)).filter((c): c is CaseListItem => Boolean(c));
}

/** Усі кейси під фільтр, без пагінації — для вибірок і прогонів. */
export function listAllCases(
  projectId: string,
  filter: Partial<CaseFilter> = {},
  sort = 'id',
): CaseListItem[] {
  const items: CaseListItem[] = [];
  let page = 1;
  for (;;) {
    const chunk = listCases({ projectId, filter, sort, limit: MAX_LIMIT, page });
    items.push(...chunk.items);
    if (items.length >= chunk.total || chunk.items.length === 0) break;
    page += 1;
  }
  return items;
}

/** Один кейс із похідними полями — відповідь `GET /cases/:id`. */
export function getCaseDetail(id: string): CaseListItem | null {
  const row = queryOne<Row>(`SELECT c.*, ${DERIVED_SELECT} FROM cases c WHERE c.id = ?`, [id]);
  if (!row) return null;
  return rowToListItem(row, sectionPathMap(String(row.project_id)));
}

/** ID кейсів, що підпадають під фільтр — без пагінації (для вибірок і bulk). */
export function resolveCaseIds(projectId: string, filter: Partial<CaseFilter>, sort = 'id'): string[] {
  const { cte, joins, where, params } = buildCaseFilterSql(projectId, filter);
  return query<{ id: string }>(
    `${cte} SELECT c.id FROM cases c${joins} WHERE ${where} ${buildOrderBy(sort)}`,
    params,
  ).map((r) => r.id);
}

export interface WriteContext {
  author?: string;
  reason?: string;
  batchId?: string;
}

export function createCase(
  projectId: string,
  input: CaseInput,
  ctx: WriteContext = {},
): Case {
  const parsed = caseInputSchema.parse(input);
  return tx(() => {
    const project = requireProject(projectId);
    const section = requireSection(parsed.sectionId);
    if (section.projectId !== project.id) {
      throw new Error('Секція належить іншому проєкту');
    }

    const id = nextCaseId(project.key, section.id, section.code);
    const at = nowIso();
    const checks = parsed.checks ?? [];
    const tags = parsed.tags ?? [];
    const preconditions = parsed.preconditions ?? '';
    const automation: CaseAutomation = parsed.automation ?? { status: 'manual' };

    execute(
      `INSERT INTO cases
         (id, project_id, section_id, title, kind, priority, status, preconditions, checks, steps, tags,
          owner, automation, testrail, version, created_at, updated_at, created_by, updated_by, search_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      [
        id,
        project.id,
        section.id,
        parsed.title,
        parsed.kind ?? 'positive',
        parsed.priority ?? 'P2',
        parsed.status ?? 'draft',
        preconditions,
        toJson(checks),
        toJson(parsed.steps ?? []),
        toJson(tags),
        parsed.owner ?? null,
        toJson(automation),
        toJson(parsed.testrail ?? {}),
        at,
        at,
        parsed.createdBy ?? ctx.author ?? 'local',
        parsed.updatedBy ?? ctx.author ?? 'local',
        buildSearchText({ title: parsed.title, checks, preconditions, tags }),
      ],
    );

    addRevision({
      caseId: id,
      version: 1,
      author: ctx.author ?? parsed.createdBy ?? 'local',
      reason: ctx.reason || 'створення кейса',
      batchId: ctx.batchId,
      patch: { created: { before: null, after: parsed.title } },
      at,
    });

    return requireCase(id);
  });
}

export type CasePatch = Partial<
  Pick<
    Case,
    | 'sectionId'
    | 'title'
    | 'kind'
    | 'priority'
    | 'status'
    | 'preconditions'
    | 'checks'
    | 'steps'
    | 'tags'
    | 'owner'
    | 'automation'
    | 'testrail'
  >
>;

/**
 * Часткове оновлення кейса. Інкрементує `version`, пише ревізію з patch
 * (лише поля, що справді змінилися). ID і `projectId` не змінюються ніколи.
 */
export function updateCase(id: string, patch: CasePatch, ctx: WriteContext = {}): Case {
  return tx(() => {
    const before = requireCase(id);
    if (patch.sectionId && patch.sectionId !== before.sectionId) {
      const target = requireSection(patch.sectionId);
      if (target.projectId !== before.projectId) {
        throw new Error('Перемістити кейс можна лише в секцію того самого проєкту');
      }
    }

    const beforeSnapshot = before as unknown as Record<string, unknown>;
    const afterSnapshot: Record<string, unknown> = { ...beforeSnapshot };
    const sets: string[] = [];
    const params: unknown[] = [];

    for (const [field, column] of Object.entries(MUTABLE_COLUMNS)) {
      if (!(field in patch)) continue;
      const value = (patch as Record<string, unknown>)[field];
      if (value === undefined) continue;
      if (JSON.stringify(value ?? null) === JSON.stringify(beforeSnapshot[field] ?? null)) continue;
      afterSnapshot[field] = value;
      sets.push(`${column} = ?`);
      params.push(JSON_FIELDS.has(field) ? toJson(value) : (value ?? null));
    }

    const patchMap: PatchMap = diffSnapshots(beforeSnapshot, afterSnapshot, Object.keys(MUTABLE_COLUMNS));
    if (Object.keys(patchMap).length === 0) return before;

    const touchesSearch = ['title', 'checks', 'preconditions', 'tags'].some((f) => f in patchMap);
    if (touchesSearch) {
      sets.push('search_text = ?');
      params.push(
        buildSearchText({
          title: String(afterSnapshot.title ?? ''),
          checks: (afterSnapshot.checks as string[]) ?? [],
          preconditions: String(afterSnapshot.preconditions ?? ''),
          tags: (afterSnapshot.tags as string[]) ?? [],
        }),
      );
    }

    const version = before.version + 1;
    const at = nowIso();
    sets.push('version = ?', 'updated_at = ?', 'updated_by = ?');
    params.push(version, at, ctx.author ?? 'local', id);

    execute(`UPDATE cases SET ${sets.join(', ')} WHERE id = ?`, params);
    addRevision({
      caseId: id,
      version,
      author: ctx.author ?? 'local',
      reason: ctx.reason || 'правка вручну',
      batchId: ctx.batchId,
      patch: patchMap,
      at,
    });
    return requireCase(id);
  });
}

export interface DeleteCaseOptions {
  hard?: boolean;
}

/** За замовчуванням — `status='deprecated'`; `hard` видаляє фізично. */
export function deleteCase(id: string, options: DeleteCaseOptions = {}, ctx: WriteContext = {}): void {
  tx(() => {
    const existing = requireCase(id);
    if (!options.hard) {
      updateCase(id, { status: 'deprecated' }, { ...ctx, reason: ctx.reason || 'кейс переведено в deprecated' });
      return;
    }
    addRevision({
      caseId: id,
      version: existing.version + 1,
      author: ctx.author ?? 'local',
      reason: ctx.reason || 'фізичне видалення кейса',
      batchId: ctx.batchId,
      patch: { deleted: { before: snapshotForUndo(existing), after: null } },
    });
    execute('DELETE FROM coverage WHERE case_id = ?', [id]);
    execute('DELETE FROM run_items WHERE case_id = ?', [id]);
    execute('DELETE FROM cases WHERE id = ?', [id]);
  });
}

/** Повний знімок кейса — кладеться в ревізію видалення, щоб undo міг відновити. */
export function snapshotForUndo(source: Case): Record<string, unknown> {
  return {
    id: source.id,
    projectId: source.projectId,
    sectionId: source.sectionId,
    title: source.title,
    kind: source.kind,
    priority: source.priority,
    status: source.status,
    preconditions: source.preconditions,
    checks: source.checks,
    steps: source.steps,
    tags: source.tags,
    // Опційні поля лишаються undefined: JSON їх просто не збереже,
    // а `caseSchema` не приймає null там, де стоїть `.optional()`.
    owner: source.owner,
    automation: source.automation,
    testrail: source.testrail,
    version: source.version,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    createdBy: source.createdBy,
    updatedBy: source.updatedBy,
  };
}

/** Відновлює фізично видалений кейс із знімка (використовує bulk undo). */
export function restoreCaseFromSnapshot(snapshot: Record<string, unknown>): void {
  const cleaned: Record<string, unknown> = { ...snapshot };
  for (const key of ['owner', 'createdBy', 'updatedBy'] as const) {
    if (cleaned[key] === null) delete cleaned[key];
  }
  const restored = caseSchema.parse(cleaned);
  execute(
    `INSERT OR REPLACE INTO cases
       (id, project_id, section_id, title, kind, priority, status, preconditions, checks, steps, tags,
        owner, automation, testrail, version, created_at, updated_at, created_by, updated_by, search_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      restored.id,
      restored.projectId,
      restored.sectionId,
      restored.title,
      restored.kind,
      restored.priority,
      restored.status,
      restored.preconditions,
      toJson(restored.checks),
      toJson(restored.steps),
      toJson(restored.tags),
      restored.owner ?? null,
      toJson(restored.automation),
      toJson(restored.testrail),
      restored.version,
      restored.createdAt,
      restored.updatedAt,
      restored.createdBy ?? null,
      restored.updatedBy ?? null,
      buildSearchText(restored),
    ],
  );
}

export interface AutomationPatch {
  status: CaseAutomation['status'];
  scenarioPath?: string;
  quarantineReason?: string;
}

/** `POST /cases/:id/automation` — прив'язка автосценарію. */
export function setAutomation(id: string, patch: AutomationPatch, ctx: WriteContext = {}): Case {
  const existing = requireCase(id);
  const automation: CaseAutomation = {
    ...existing.automation,
    status: patch.status,
    ...(patch.scenarioPath !== undefined ? { scenarioPath: patch.scenarioPath } : {}),
    ...(patch.quarantineReason !== undefined ? { quarantineReason: patch.quarantineReason } : {}),
  };
  return updateCase(id, { automation }, { ...ctx, reason: ctx.reason || 'зміна автоматизації' });
}

/** Оновлює службові поля автоматизації без нової ревізії (результати рушія). */
export function touchAutomationResult(
  id: string,
  patch: Partial<Pick<CaseAutomation, 'lastAutoRunId' | 'lastAutoStatus' | 'lastAutoAt' | 'flakeScore'>>,
): void {
  const existing = getCase(id);
  if (!existing) return;
  const automation: CaseAutomation = { ...existing.automation, ...patch };
  execute('UPDATE cases SET automation = ? WHERE id = ?', [toJson(automation), id]);
}

/** Оновлює `testrail`-блок без ревізії (синхронізація, не змістова правка). */
export function setTestrailMeta(id: string, patch: Partial<CaseTestrail>): void {
  const existing = getCase(id);
  if (!existing) return;
  execute('UPDATE cases SET testrail = ? WHERE id = ?', [
    toJson({ ...existing.testrail, ...patch }),
    id,
  ]);
}

export interface CaseHistory {
  revisions: Revision[];
  results: RunItem[];
}

export function caseHistory(id: string, limit = 200): CaseHistory {
  const revisions = query<Row>(
    'SELECT * FROM revisions WHERE case_id = ? ORDER BY version DESC, at DESC LIMIT ?',
    [id, limit],
  ).map((row) => ({
    id: String(row.id),
    caseId: String(row.case_id),
    version: Number(row.version),
    at: String(row.at),
    author: String(row.author ?? 'system'),
    reason: String(row.reason ?? ''),
    patch: fromJson<PatchMap>(row.patch, {}),
  }));

  const results = query<Row>(
    'SELECT * FROM run_items WHERE case_id = ? ORDER BY updated_at DESC LIMIT ?',
    [id, limit],
  ).map((row) => ({
    id: String(row.id),
    runId: String(row.run_id),
    caseId: String(row.case_id),
    position: Number(row.position ?? 0),
    status: row.status as ItemStatus,
    comment: String(row.comment ?? ''),
    evidence: fromJson<string[]>(row.evidence, []),
    defectId: row.defect_id ? String(row.defect_id) : undefined,
    autoRunId: row.auto_run_id ? String(row.auto_run_id) : undefined,
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? undefined : Number(row.duration_ms),
    updatedAt: String(row.updated_at),
    updatedBy: row.updated_by ? String(row.updated_by) : undefined,
  }));

  return { revisions, results };
}

/** Кейси за списком ID, у порядку переданих ID. */
export function getCasesByIds(ids: readonly string[]): Case[] {
  if (ids.length === 0) return [];
  const rows = query<Row>(
    `SELECT * FROM cases WHERE id IN (${ids.map(() => '?').join(', ')})`,
    [...ids],
  ).map(rowToCase);
  const byId = new Map(rows.map((c) => [c.id, c]));
  return ids.map((id) => byId.get(id)).filter((c): c is Case => Boolean(c));
}
