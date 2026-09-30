/**
 * Прогони реєстру (`registry_runs` + `run_items`).
 *
 * Це «людський» прогін: кейси зі вибірки або списку ID, ручні статуси,
 * дефекти з дедуплікацією, `rerun-failed` і потік подій для SSE.
 * Авточастина зв'язується з рушієм через `run_items.auto_run_id`.
 */
import { EventEmitter } from 'node:events';
import { execute, fromJson, nowIso, query, queryOne, scalar, toJson, tx, type Row } from './db.js';
import { newId } from './ids.js';
import { getCase, getCaseListItems } from './cases-store.js';
import { requireProject } from './projects-store.js';
import { sectionPathMap } from './sections-store.js';
import { resolveSelection } from './selections-store.js';
import { buildDedupKey, upsertDefect } from './defects-store.js';
import {
  registryRunSchema,
  runItemSchema,
  type Case,
  type ItemStatus,
  type Page,
  type RegistryRun,
  type RunDetail,
  type RunItem,
  type RunKind,
  type RunSummary,
} from './types.js';

/** Події для `GET /runs/:id/stream`. */
export interface RunEvent {
  runId: string;
  type: 'item' | 'done';
  payload: unknown;
}

export const runEvents = new EventEmitter();
runEvents.setMaxListeners(0);

const EMPTY_SUMMARY: RunSummary = {
  total: 0,
  passed: 0,
  failed: 0,
  blocked: 0,
  skipped: 0,
  untested: 0,
};

export function runSummary(runId: string): RunSummary {
  const row = queryOne<Row>(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status IN ('passed', 'healed') THEN 1 ELSE 0 END) AS passed,
       SUM(CASE WHEN status = 'failed'   THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status = 'blocked'  THEN 1 ELSE 0 END) AS blocked,
       SUM(CASE WHEN status = 'skipped'  THEN 1 ELSE 0 END) AS skipped,
       SUM(CASE WHEN status = 'untested' THEN 1 ELSE 0 END) AS untested
     FROM run_items WHERE run_id = ?`,
    [runId],
  );
  if (!row) return { ...EMPTY_SUMMARY };
  return {
    total: Number(row.total ?? 0),
    passed: Number(row.passed ?? 0),
    failed: Number(row.failed ?? 0),
    blocked: Number(row.blocked ?? 0),
    skipped: Number(row.skipped ?? 0),
    untested: Number(row.untested ?? 0),
  };
}

function rowToRun(row: Row): RegistryRun {
  return registryRunSchema.parse({
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    selectionId: row.selection_id ?? undefined,
    env: fromJson<RegistryRun['env']>(row.env, {}),
    state: row.state,
    executor: row.executor ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    summary: runSummary(String(row.id)),
    note: row.note ?? '',
  });
}

/**
 * У базі окремо зберігається `healed` — «упав і сам полікувався» (self-heal
 * рушія). Для API це `passed` (кейс у результаті пройшов), а дашборд читає
 * сирий статус, щоб рахувати `flakeScore`.
 */
function normalizeItemStatus(raw: unknown): ItemStatus {
  return raw === 'healed' ? 'passed' : (raw as ItemStatus);
}

function rowToItem(row: Row): RunItem {
  return runItemSchema.parse({
    id: row.id,
    runId: row.run_id,
    caseId: row.case_id,
    position: Number(row.position ?? 0),
    status: normalizeItemStatus(row.status),
    comment: row.comment ?? '',
    evidence: fromJson<string[]>(row.evidence, []),
    defectId: row.defect_id ?? undefined,
    autoRunId: row.auto_run_id ?? undefined,
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? undefined : Number(row.duration_ms),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by ?? undefined,
  });
}

export interface CreateRunInput {
  projectId: string;
  kind?: RunKind;
  title?: string;
  selectionId?: string;
  caseIds?: string[];
  env?: RegistryRun['env'];
  executor?: string;
  note?: string;
}

export function createRun(input: CreateRunInput): RegistryRun {
  return tx(() => {
    const project = requireProject(input.projectId);
    let caseIds = input.caseIds ?? [];
    let stopOnFailure = false;
    let title = input.title;

    if (input.selectionId) {
      const resolved = resolveSelection(input.selectionId);
      caseIds = resolved.caseIds;
      const selectionRow = queryOne<Row>('SELECT name, stop_on_failure FROM selections WHERE id = ?', [
        input.selectionId,
      ]);
      stopOnFailure = Boolean(selectionRow?.stop_on_failure);
      title = title ?? `Прогін: ${selectionRow?.name ?? input.selectionId}`;
    }

    if (caseIds.length === 0) {
      throw new Error('Прогін потребує selectionId або непорожній caseIds');
    }

    const id = newId('run');
    const at = nowIso();
    const env = { ...(input.env ?? {}) };
    // Явно заданий URL закріплює середовище; успадкований від проєкту — ні.
    if (env.baseUrl) env.baseUrlPinned = true;
    if (!env.baseUrl && project.baseUrl) env.baseUrl = project.baseUrl;
    if (stopOnFailure && !env.label) env.label = 'stopOnFailure';

    execute(
      `INSERT INTO registry_runs
         (id, project_id, kind, title, selection_id, env, state, executor, started_at, note)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      [
        id,
        project.id,
        input.kind ?? 'manual',
        title ?? `Прогін ${at.slice(0, 16).replace('T', ' ')}`,
        input.selectionId ?? null,
        toJson(env),
        input.executor ?? null,
        at,
        input.note ?? '',
      ],
    );

    let position = 0;
    for (const caseId of caseIds) {
      const target = getCase(caseId);
      if (!target || target.projectId !== project.id) continue;
      execute(
        `INSERT OR IGNORE INTO run_items (id, run_id, case_id, position, status, updated_at)
         VALUES (?, ?, ?, ?, 'untested', ?)`,
        [newId('rit'), id, caseId, position, at],
      );
      position += 1;
    }

    if (position === 0) {
      throw new Error('Жоден із переданих кейсів не належить проєкту');
    }

    return requireRun(id);
  });
}

export function getRun(id: string): RegistryRun | null {
  const row = queryOne<Row>('SELECT * FROM registry_runs WHERE id = ?', [id]);
  return row ? rowToRun(row) : null;
}

export function requireRun(id: string): RegistryRun {
  const run = getRun(id);
  if (!run) throw new Error(`Прогін «${id}» не знайдено`);
  return run;
}

export interface ListRunsOptions {
  projectId: string;
  kind?: RunKind;
  state?: RegistryRun['state'];
  page?: number;
  limit?: number;
}

export function listRuns(options: ListRunsOptions): Page<RegistryRun> {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 50)));
  const where = ['project_id = ?'];
  const params: unknown[] = [options.projectId];
  if (options.kind) {
    where.push('kind = ?');
    params.push(options.kind);
  }
  if (options.state) {
    where.push('state = ?');
    params.push(options.state);
  }
  const clause = where.join(' AND ');
  const total = Number(scalar<number>(`SELECT COUNT(*) FROM registry_runs WHERE ${clause}`, params) ?? 0);
  const items = query<Row>(
    `SELECT * FROM registry_runs WHERE ${clause} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, (page - 1) * limit],
  ).map(rowToRun);
  return { items, total, page, limit };
}

export function listRunItems(runId: string): RunItem[] {
  return query<Row>('SELECT * FROM run_items WHERE run_id = ? ORDER BY position, case_id', [runId]).map(
    rowToItem,
  );
}

export function getRunItem(runId: string, caseId: string): RunItem | null {
  const row = queryOne<Row>('SELECT * FROM run_items WHERE run_id = ? AND case_id = ?', [runId, caseId]);
  return row ? rowToItem(row) : null;
}

/** Прогін із кейсами — відповідь `GET /runs/:id`. */
export function runDetail(id: string): RunDetail | null {
  const run = getRun(id);
  if (!run) return null;
  const items = listRunItems(id);
  const paths = sectionPathMap(run.projectId);
  const cases = new Map(getCaseListItems(items.map((i) => i.caseId)).map((c) => [c.id, c]));

  return {
    ...run,
    items: items.map((item) => {
      const source = cases.get(item.caseId);
      const shell: Pick<Case, 'id' | 'title' | 'kind' | 'priority' | 'checks' | 'preconditions' | 'automation'> & {
        sectionPath: string;
      } = source
        ? {
            id: source.id,
            title: source.title,
            kind: source.kind,
            priority: source.priority,
            checks: source.checks,
            preconditions: source.preconditions,
            automation: source.automation,
            sectionPath: paths.get(source.sectionId) ?? source.sectionPath,
          }
        : {
            id: item.caseId,
            title: '(кейс видалено)',
            kind: 'positive',
            priority: 'P3',
            checks: [],
            preconditions: '',
            automation: { status: 'manual' },
            sectionPath: '',
          };
      return { ...item, case: shell };
    }),
  };
}

export interface UpdateRunPatch {
  state?: RegistryRun['state'];
  title?: string;
  note?: string;
  executor?: string;
}

export function updateRun(id: string, patch: UpdateRunPatch): RegistryRun {
  const existing = requireRun(id);
  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.title !== undefined) {
    sets.push('title = ?');
    params.push(patch.title);
  }
  if (patch.note !== undefined) {
    sets.push('note = ?');
    params.push(patch.note);
  }
  if (patch.executor !== undefined) {
    sets.push('executor = ?');
    params.push(patch.executor);
  }
  if (patch.state !== undefined) {
    sets.push('state = ?');
    params.push(patch.state);
    if (patch.state === 'completed' || patch.state === 'cancelled') {
      sets.push('finished_at = ?');
      params.push(existing.finishedAt ?? nowIso());
    } else {
      sets.push('finished_at = NULL');
    }
  }
  if (sets.length === 0) return existing;

  params.push(id);
  execute(`UPDATE registry_runs SET ${sets.join(', ')} WHERE id = ?`, params);
  const updated = requireRun(id);
  if (patch.state === 'completed' || patch.state === 'cancelled') {
    runEvents.emit('event', {
      runId: id,
      type: 'done',
      payload: { state: updated.state, summary: updated.summary },
    } satisfies RunEvent);
  }
  return updated;
}

export interface SetItemStatusInput {
  status: ItemStatus;
  comment?: string;
  evidence?: string[];
  durationMs?: number;
  autoRunId?: string;
  updatedBy?: string;
  defect?: { title: string; severity?: 'low' | 'medium' | 'high' | 'critical'; details?: string };
}

export interface SetItemStatusResult {
  item: RunItem;
  defectId?: string;
  summary: RunSummary;
}

/**
 * Ручний результат кейса в прогоні. Якщо передано `defect`, він створюється
 * або дедуплікується за `dedupKey = хеш(caseId + нормалізований заголовок)`.
 */
export function setItemStatus(
  runId: string,
  caseId: string,
  input: SetItemStatusInput,
): SetItemStatusResult {
  const result = tx(() => {
    const run = requireRun(runId);
    const existing = getRunItem(runId, caseId);
    if (!existing) throw new Error(`Кейс «${caseId}» не входить у прогін «${runId}»`);

    let defectId = existing.defectId;
    if (input.defect?.title) {
      const defect = upsertDefect({
        projectId: run.projectId,
        title: input.defect.title,
        details: input.defect.details ?? input.comment ?? '',
        // Серйозність передаємо лише якщо її задали: дедуплікація не має
        // знижувати вже виставлену серйозність до дефолтної.
        ...(input.defect.severity ? { severity: input.defect.severity } : {}),
        caseId,
        runItemId: existing.id,
        dedupKey: buildDedupKey(caseId, input.defect.title),
      });
      defectId = defect.id;
    }

    const at = nowIso();
    execute(
      `UPDATE run_items
         SET status = ?, comment = ?, evidence = ?, defect_id = ?, auto_run_id = COALESCE(?, auto_run_id),
             duration_ms = COALESCE(?, duration_ms), updated_at = ?, updated_by = ?
       WHERE id = ?`,
      [
        input.status,
        input.comment ?? existing.comment,
        toJson(input.evidence ?? existing.evidence),
        defectId ?? null,
        input.autoRunId ?? null,
        input.durationMs ?? null,
        at,
        input.updatedBy ?? 'local',
        existing.id,
      ],
    );

    const item = getRunItem(runId, caseId) as RunItem;
    return { item, defectId, summary: runSummary(runId) };
  });

  runEvents.emit('event', {
    runId,
    type: 'item',
    payload: { item: result.item, summary: result.summary },
  } satisfies RunEvent);
  return result;
}

/** Зв'язує елемент прогону з прогоном рушія (`POST /runs/:id/auto`). */
export function attachAutoRun(runId: string, caseId: string, autoRunId: string): void {
  execute('UPDATE run_items SET auto_run_id = ?, updated_at = ? WHERE run_id = ? AND case_id = ?', [
    autoRunId,
    nowIso(),
    runId,
    caseId,
  ]);
  const item = getRunItem(runId, caseId);
  if (item) {
    runEvents.emit('event', {
      runId,
      type: 'item',
      payload: { item, summary: runSummary(runId) },
    } satisfies RunEvent);
  }
}

export interface AutoResultInput {
  autoRunId: string;
  /** Статус прогону рушія (`RunRecord.status`). */
  engineStatus: 'passed' | 'failed' | 'cancelled' | 'running' | 'queued' | 'paused';
  /** Чи були полікувані кроки (`evidence.summary.healed > 0`). */
  healed?: boolean;
  durationMs?: number;
  evidence?: string[];
  comment?: string;
  /**
   * Прогін не міг виконатись через середовище (ціль віддала 5xx, DNS не
   * вирішився). Кейс позначається `blocked`: це не регресія застосунку.
   */
  blocked?: boolean;
  /**
   * Дефект, знайдений рушієм. Передається лише для підтверджених вердиктів —
   * непідтверджені лишаються в коментарі, щоб не засмічувати список багів.
   */
  defect?: { title: string; severity?: 'low' | 'medium' | 'high' | 'critical'; details?: string };
}

/**
 * Переносить результат прогону рушія в елемент прогону реєстру.
 * `passed` із полікуваними кроками записується як `healed` — для API це
 * `passed`, а дашборд враховує його у `flakeScore`.
 */
export function syncAutoResult(runId: string, caseId: string, input: AutoResultInput): RunItem | null {
  const existing = getRunItem(runId, caseId);
  if (!existing) return null;

  // Ідемпотентність на рівні сховища. Результат того самого автопрогону, який
  // уже зафіксував рушій, не переписуємо: повторний тік мостика інакше множив
  // `seenCount` дефекту й міг перекинути статус (blocked → failed) на тих самих
  // даних. Перевірка мостика лишається, але істина мусить бути тут.
  if (
    existing.updatedBy === 'engine' &&
    existing.status !== 'untested' &&
    existing.autoRunId === input.autoRunId
  ) {
    return existing;
  }

  // Дефект, який знайшов рушій, проходить ту саму дедуплікацію, що й ручний:
  // повторні прогони наростять `seenCount`, а не створять копії.
  let defectId = existing.defectId;
  if (input.defect?.title) {
    const run = requireRun(runId);
    const defect = upsertDefect({
      projectId: run.projectId,
      title: input.defect.title,
      details: input.defect.details ?? '',
      ...(input.defect.severity ? { severity: input.defect.severity } : {}),
      caseId,
      runItemId: existing.id,
      dedupKey: buildDedupKey(caseId, input.defect.title),
    });
    defectId = defect.id;
  }

  const rawStatus =
    input.engineStatus === 'passed'
      ? input.healed
        ? 'healed'
        : 'passed'
      : input.blocked
        ? 'blocked'
        : input.engineStatus === 'failed'
          ? 'failed'
          : input.engineStatus === 'cancelled'
            ? 'blocked'
            : 'untested';

  execute(
    `UPDATE run_items
       SET status = ?, auto_run_id = ?, duration_ms = COALESCE(?, duration_ms),
           evidence = ?, comment = ?, defect_id = ?, updated_at = ?, updated_by = 'engine'
     WHERE id = ?`,
    [
      rawStatus,
      input.autoRunId,
      input.durationMs ?? null,
      toJson(input.evidence ?? existing.evidence),
      input.comment ?? existing.comment,
      defectId ?? null,
      nowIso(),
      existing.id,
    ],
  );

  const item = getRunItem(runId, caseId);
  if (item) {
    runEvents.emit('event', {
      runId,
      type: 'item',
      payload: { item, summary: runSummary(runId) },
    } satisfies RunEvent);
  }
  return item;
}

/** Новий прогін лише з `failed`/`blocked` кейсами вихідного. */
export function rerunFailed(runId: string, executor?: string): RegistryRun {
  const source = requireRun(runId);
  const caseIds = query<{ case_id: string }>(
    `SELECT case_id FROM run_items WHERE run_id = ? AND status IN ('failed', 'blocked') ORDER BY position`,
    [runId],
  ).map((r) => r.case_id);

  if (caseIds.length === 0) {
    throw new Error('У прогоні немає кейсів зі статусом failed або blocked');
  }

  return createRun({
    projectId: source.projectId,
    kind: source.kind,
    title: `Перепрогін: ${source.title}`,
    caseIds,
    env: source.env,
    executor: executor ?? source.executor,
    note: `Створено з прогону ${source.id}`,
  });
}

export function deleteRun(id: string): void {
  requireRun(id);
  execute('DELETE FROM registry_runs WHERE id = ?', [id]);
}
