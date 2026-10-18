/**
 * Задачі для агентів розробників і питання до людей.
 *
 * Життєвий цикл (docs/agent-driven-qa-plan.md, 4.4):
 *   queued → claimed (оренда) → review → done
 *            ↘ needs_info → queued        ↘ queued (QA просить інакше)
 *            ↘ failed → queued            ↘ rejected
 * Прострочена оренда повертає задачу в `queued`. Задачі з PR завершуються,
 * лише коли QA підтвердив намір І PR злито; решта — після підтвердження QA.
 *
 * ID задачі людський: `<PROJECT.KEY>-T-<N>`, лічильник у межах проєкту.
 */
import { execute, fromJson, nowIso, placeholders, query, queryOne, toJson, tx, type Row } from './db.js';
import { newId } from './ids.js';
import { requireProject } from './projects-store.js';
import { listSections } from './sections-store.js';
import { matchGlob, ownersForPath, parseCodeowners } from '../ingest/index.js';
import {
  taskReportSchema,
  taskSchema,
  type CasePriority,
  type Section,
  type Task,
  type TaskAnchor,
  type TaskEvent,
  type TaskKind,
  type TaskReport,
  type TaskState,
  type Page,
} from './types.js';

/** Задачі, результат яких — PR із тестами. Інші завершуються погодженням QA. */
export const PR_KINDS: ReadonlySet<TaskKind> = new Set(['add_test', 'change_test', 'remove_test', 'stabilize']);
/** Агенти не беруть питання: це робота людей. */
export const AGENT_KINDS: ReadonlySet<TaskKind> = new Set([
  'add_test',
  'change_test',
  'remove_test',
  'plan_module',
  'read_asset',
  'triage',
  'stabilize',
]);
const ACTIVE_STATES: TaskState[] = ['new', 'queued', 'claimed', 'needs_info', 'review', 'failed'];

export type ActorKind = 'qa' | 'system' | 'agent' | 'dev';

function rowToTask(row: Row): Task {
  return taskSchema.parse({
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    state: row.state,
    title: row.title,
    text: row.text ?? '',
    author: row.author,
    authorKind: row.author_kind,
    anchor: fromJson<TaskAnchor>(row.anchor, {}),
    sectionId: row.section_id ?? undefined,
    owners: fromJson<string[]>(row.owners, []),
    priority: row.priority ?? 'P2',
    parentId: row.parent_id ?? undefined,
    dedupKey: row.dedup_key ?? undefined,
    leaseHolder: row.lease_holder ?? undefined,
    leaseUntil: row.lease_until ?? undefined,
    attempts: Number(row.attempts ?? 0),
    branch: row.branch ?? undefined,
    prUrl: row.pr_url ?? undefined,
    prNumber: row.pr_number ?? undefined,
    report: row.report ? fromJson<TaskReport | undefined>(row.report, undefined) : undefined,
    qaConfirmedBy: row.qa_confirmed_by ?? undefined,
    qaConfirmedAt: row.qa_confirmed_at ?? undefined,
    mergedAt: row.merged_at ?? undefined,
    queuedAt: row.queued_at,
    doneAt: row.done_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function rowToEvent(row: Row): TaskEvent {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    at: String(row.at),
    author: String(row.author),
    authorKind: row.author_kind as TaskEvent['authorKind'],
    type: row.type as TaskEvent['type'],
    text: String(row.text ?? ''),
    data: fromJson<Record<string, unknown>>(row.data, {}),
  };
}

export function getTask(id: string): Task | null {
  const row = queryOne<Row>('SELECT * FROM tasks WHERE id = ?', [id]);
  return row ? rowToTask(row) : null;
}

export function requireTask(id: string): Task {
  const task = getTask(id);
  if (!task) throw new Error(`Задачу «${id}» не знайдено`);
  return task;
}

export function addEvent(
  taskId: string,
  event: { author: string; authorKind: ActorKind; type: TaskEvent['type']; text: string; data?: Record<string, unknown> },
): TaskEvent {
  const id = newId('tev');
  execute(
    'INSERT INTO task_events (id, task_id, at, author, author_kind, type, text, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, taskId, nowIso(), event.author, event.authorKind, event.type, event.text, toJson(event.data ?? {})],
  );
  return rowToEvent(queryOne<Row>('SELECT * FROM task_events WHERE id = ?', [id]) as Row);
}

export function listEvents(taskId: string): TaskEvent[] {
  return query<Row>('SELECT * FROM task_events WHERE task_id = ? ORDER BY at, rowid', [taskId]).map(rowToEvent);
}

function nextTaskId(projectId: string): string {
  const project = requireProject(projectId);
  execute(
    `INSERT INTO task_counters (project_id, next) VALUES (?, 1)
     ON CONFLICT(project_id) DO UPDATE SET next = next + 1`,
    [projectId],
  );
  const n = Number(queryOne<Row>('SELECT next FROM task_counters WHERE project_id = ?', [projectId])?.next ?? 1);
  return `${project.key}-T-${n}`;
}

/* ───────────────────────────── маршрутизація ───────────────────────────── */

/** Найконкретніший модуль для файлу: секція, чий glob збігся й найдовший. */
export function sectionForFile(projectId: string, file: string, sections: Section[] = listSections(projectId)): Section | null {
  let best: { section: Section; weight: number } | null = null;
  for (const section of sections) {
    for (const pattern of section.paths) {
      if (!matchGlob(pattern, file)) continue;
      if (!best || pattern.length > best.weight) best = { section, weight: pattern.length };
    }
  }
  return best?.section ?? null;
}

/** Модуль задачі за її якорем: кейс → секція кейса, блок → секція джерела, файл → glob-и секцій. */
export function resolveSectionId(projectId: string, anchor: TaskAnchor): string | undefined {
  if (anchor.sectionId) return anchor.sectionId;
  if (anchor.caseId) {
    const row = queryOne<Row>('SELECT section_id FROM cases WHERE id = ?', [anchor.caseId]);
    if (row?.section_id) return String(row.section_id);
  }
  const blockId = anchor.blockId ?? (anchor.assetId ? assetBlockId(anchor.assetId) : undefined);
  if (blockId) {
    const row = queryOne<Row>(
      'SELECT s.section_id FROM blocks b JOIN sources s ON s.id = b.source_id WHERE b.id = ?',
      [blockId],
    );
    if (row?.section_id) return String(row.section_id);
  }
  if (anchor.sourceId) {
    const row = queryOne<Row>('SELECT section_id FROM sources WHERE id = ?', [anchor.sourceId]);
    if (row?.section_id) return String(row.section_id);
  }
  if (anchor.testId) {
    const row = queryOne<Row>(
      `SELECT c.section_id FROM test_links tl JOIN cases c ON c.id = tl.case_id WHERE tl.test_id = ? LIMIT 1`,
      [anchor.testId],
    );
    if (row?.section_id) return String(row.section_id);
  }
  if (anchor.file) return sectionForFile(projectId, anchor.file)?.id;
  return undefined;
}

function assetBlockId(assetId: string): string | undefined {
  const row = queryOne<Row>('SELECT block_id FROM assets WHERE id = ?', [assetId]);
  return (row?.block_id as string | null) ?? undefined;
}

/**
 * Власники модуля: явні власники секції перекривають CODEOWNERS. Для CODEOWNERS
 * перевіряємо кожен glob секції за його незмінною частиною шляху.
 */
export function resolveOwners(projectId: string, sectionId: string | undefined): string[] {
  if (!sectionId) return [];
  const section = listSections(projectId).find((item) => item.id === sectionId);
  if (!section) return [];
  if (section.owners.length > 0) return section.owners;
  const codeowners = requireProject(projectId).settings.codeowners;
  if (!codeowners || section.paths.length === 0) return [];
  const rules = parseCodeowners(codeowners);
  const owners = new Set<string>();
  for (const pattern of section.paths) {
    const base = pattern.replace(/\/?\*.*$/, '');
    for (const owner of ownersForPath(rules, `${base}/x`)) owners.add(owner);
  }
  return [...owners].sort();
}

/* ─────────────────────────────── створення ─────────────────────────────── */

export interface CreateTaskInput {
  projectId: string;
  kind: TaskKind;
  title: string;
  text?: string;
  anchor?: TaskAnchor;
  priority?: CasePriority;
  author: string;
  authorKind: ActorKind;
  parentId?: string;
  /** Не плодити однакові відкриті задачі: «той самий тест упав на main» — одна задача. */
  dedupKey?: string;
}

/** Створює задачу в `queued` або повертає відкриту з тим самим `dedupKey`. */
export function createTask(input: CreateTaskInput): { task: Task; created: boolean } {
  return tx(() => {
    if (input.dedupKey) {
      const existing = queryOne<Row>(
        `SELECT * FROM tasks WHERE project_id = ? AND dedup_key = ? AND state IN (${placeholders(ACTIVE_STATES.length)})`,
        [input.projectId, input.dedupKey, ...ACTIVE_STATES],
      );
      if (existing) {
        const task = rowToTask(existing);
        // Та сама причина виникла знову, а попередня спроба не вдалась — пробуємо ще раз.
        if (task.state === 'failed') {
          setState(task.id, 'queued', { queued_at: nowIso() });
          addEvent(task.id, { author: input.author, authorKind: input.authorKind, type: 'status', text: 'Причина повторилась — задача знову в черзі', data: { state: 'queued' } });
          return { task: requireTask(task.id), created: false };
        }
        return { task, created: false };
      }
    }

    const anchor = input.anchor ?? {};
    const sectionId = resolveSectionId(input.projectId, anchor);
    const owners = resolveOwners(input.projectId, sectionId);
    const id = nextTaskId(input.projectId);
    const at = nowIso();
    execute(
      `INSERT INTO tasks
         (id, project_id, kind, state, title, text, author, author_kind, anchor, section_id, owners, priority,
          parent_id, dedup_key, queued_at, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.projectId,
        input.kind,
        input.title,
        input.text ?? '',
        input.author,
        input.authorKind,
        toJson(anchor),
        sectionId ?? null,
        toJson(owners),
        input.priority ?? 'P2',
        input.parentId ?? null,
        input.dedupKey ?? null,
        at,
        at,
        at,
      ],
    );
    addEvent(id, { author: input.author, authorKind: input.authorKind, type: 'status', text: 'Задачу створено', data: { state: 'queued' } });
    return { task: requireTask(id), created: true };
  });
}

/* ──────────────────────────────── перелік ──────────────────────────────── */

export interface TaskListItem extends Task {
  ageHours: number;
  sectionName?: string;
}

function ageHours(task: Task, now = Date.now()): number {
  return Math.max(0, Math.round(((now - Date.parse(task.queuedAt)) / 3_600_000) * 10) / 10);
}

export interface ListTasksOptions {
  projectId: string;
  states?: TaskState[];
  kinds?: TaskKind[];
  sectionId?: string;
  owner?: string;
  q?: string;
  page?: number;
  limit?: number;
}

export function listTasks(options: ListTasksOptions): Page<TaskListItem> {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 50)));
  const where = ['t.project_id = ?'];
  const params: unknown[] = [options.projectId];
  if (options.states?.length) {
    where.push(`t.state IN (${placeholders(options.states.length)})`);
    params.push(...options.states);
  }
  if (options.kinds?.length) {
    where.push(`t.kind IN (${placeholders(options.kinds.length)})`);
    params.push(...options.kinds);
  }
  if (options.sectionId) {
    where.push('t.section_id = ?');
    params.push(options.sectionId);
  }
  if (options.owner) {
    const aliases = loginAliases(options.owner);
    where.push(
      `EXISTS (SELECT 1 FROM json_each(t.owners) o WHERE ltrim(lower(o.value), '@') IN (${placeholders(aliases.length)}))`,
    );
    params.push(...aliases);
  }
  if (options.q) {
    where.push('(lower(t.title) LIKE ? OR lower(t.text) LIKE ? OR lower(t.id) LIKE ?)');
    const like = `%${options.q.toLowerCase()}%`;
    params.push(like, like, like);
  }
  const clause = where.join(' AND ');
  const total = Number(queryOne<Row>(`SELECT COUNT(*) AS n FROM tasks t WHERE ${clause}`, params)?.n ?? 0);
  const rows = query<Row>(
    `SELECT t.*, s.name AS section_name FROM tasks t LEFT JOIN sections s ON s.id = t.section_id
     WHERE ${clause}
     ORDER BY CASE t.state WHEN 'needs_info' THEN 0 WHEN 'review' THEN 1 WHEN 'queued' THEN 2 WHEN 'claimed' THEN 3 ELSE 4 END,
              t.priority, t.queued_at
     LIMIT ? OFFSET ?`,
    [...params, limit, (page - 1) * limit],
  );
  const now = Date.now();
  return {
    items: rows.map((row) => {
      const task = rowToTask(row);
      return { ...task, ageHours: ageHours(task, now), sectionName: (row.section_name as string | null) ?? undefined };
    }),
    total,
    page,
    limit,
  };
}

/**
 * Як людина може значитись у власниках: повний логін (`alice@corp`) або
 * хендл із CODEOWNERS (`@alice`) — частина логіна до `@`. Команди CODEOWNERS
 * (`@org/team`) з логіном не зіставляються: їх задають власниками секції.
 */
export function loginAliases(login: string): string[] {
  const full = login.trim().toLowerCase().replace(/^@/, '');
  const local = full.split('@')[0];
  return [...new Set([full, local].filter(Boolean))];
}

export function isOwner(owners: string[], login: string): boolean {
  const aliases = new Set(loginAliases(login));
  return owners.some((owner) => aliases.has(owner.trim().toLowerCase().replace(/^@/, '')));
}

/**
 * Вхідні задачі для агента: лише ті, що агент може взяти. Спершу задачі,
 * де людина — власник модуля, потім модулі змінених файлів, далі за пріоритетом і віком.
 */
export function inbox(
  projectId: string,
  options: { login?: string; paths?: string[]; limit?: number } = {},
): { tasks: Array<TaskListItem & { mine: boolean; touched: boolean }>; total: number } {
  const kinds = [...AGENT_KINDS];
  const rows = query<Row>(
    `SELECT t.*, s.name AS section_name FROM tasks t LEFT JOIN sections s ON s.id = t.section_id
     WHERE t.project_id = ? AND t.kind IN (${placeholders(kinds.length)})
       AND (t.state = 'queued' OR (t.state = 'claimed' AND t.lease_holder = ?))`,
    [projectId, ...kinds, options.login ?? ''],
  );
  const sections = listSections(projectId);
  const touchedSections = new Set(
    (options.paths ?? []).map((file) => sectionForFile(projectId, file, sections)?.id).filter(Boolean) as string[],
  );
  const login = options.login?.toLowerCase();
  const now = Date.now();
  const items = rows.map((row) => {
    const task = rowToTask(row);
    const mine = Boolean(login && isOwner(task.owners, login));
    const touched = Boolean(task.sectionId && touchedSections.has(task.sectionId));
    return { ...task, ageHours: ageHours(task, now), sectionName: (row.section_name as string | null) ?? undefined, mine, touched };
  });
  items.sort(
    (a, b) =>
      Number(b.state === 'claimed') - Number(a.state === 'claimed') ||
      Number(b.mine) - Number(a.mine) ||
      Number(b.touched) - Number(a.touched) ||
      a.priority.localeCompare(b.priority) ||
      a.queuedAt.localeCompare(b.queuedAt),
  );
  return { tasks: items.slice(0, options.limit ?? 20), total: items.length };
}

/* ─────────────────────────────── переходи ──────────────────────────────── */

function setState(id: string, state: TaskState, extra: Record<string, unknown> = {}): void {
  const columns = Object.keys(extra);
  const sets = ['state = ?', 'updated_at = ?', ...columns.map((column) => `${column} = ?`)];
  execute(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, [state, nowIso(), ...columns.map((c) => extra[c]), id]);
}

function leaseExpired(task: Task, now = Date.now()): boolean {
  return !task.leaseUntil || Date.parse(task.leaseUntil) <= now;
}

function finishJob(taskId: string, holder: string, outcome: string, patch: { prUrl?: string; branch?: string } = {}): void {
  execute(
    `UPDATE agent_jobs SET finished_at = ?, outcome = ?, pr_url = COALESCE(?, pr_url), branch = COALESCE(?, branch)
     WHERE id = (SELECT id FROM agent_jobs WHERE task_id = ? AND holder = ? AND finished_at IS NULL ORDER BY started_at DESC LIMIT 1)`,
    [nowIso(), outcome, patch.prUrl ?? null, patch.branch ?? null, taskId, holder],
  );
}

export interface ClaimOptions {
  agent?: string;
  model?: string;
  leaseMinutes?: number;
}

/** Бере задачу в роботу з орендою. Повторний claim тим самим власником продовжує оренду. */
export function claimTask(id: string, holder: string, options: ClaimOptions = {}): Task {
  return tx(() => {
    const task = requireTask(id);
    if (!AGENT_KINDS.has(task.kind)) throw new Error('Питання до людей агент не бере');
    const minutes = options.leaseMinutes ?? requireProject(task.projectId).settings.thresholds.leaseMinutes;
    const leaseUntil = new Date(Date.now() + minutes * 60_000).toISOString();

    if (task.state === 'claimed' && task.leaseHolder === holder) {
      setState(id, 'claimed', { lease_until: leaseUntil });
      return requireTask(id);
    }
    const claimable = task.state === 'queued' || task.state === 'failed' || (task.state === 'claimed' && leaseExpired(task));
    if (!claimable) {
      const who = task.state === 'claimed' ? ` (зараз у ${task.leaseHolder})` : '';
      throw new Error(`Задача вже в стані «${task.state}»${who}`);
    }
    if (task.state === 'claimed' && task.leaseHolder) finishJob(id, task.leaseHolder, 'expired');

    setState(id, 'claimed', { lease_holder: holder, lease_until: leaseUntil, attempts: task.attempts + 1 });
    execute(
      `INSERT INTO agent_jobs (id, project_id, task_id, holder, agent, model, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [newId('job'), task.projectId, id, holder, options.agent ?? null, options.model ?? null, nowIso()],
    );
    addEvent(id, {
      author: holder,
      authorKind: 'agent',
      type: 'status',
      text: `Узято в роботу${options.model ? ` (${options.agent ?? 'агент'}, ${options.model})` : ''}`,
      data: { state: 'claimed', leaseUntil },
    });
    return requireTask(id);
  });
}

function requireHolder(task: Task, holder: string): void {
  if (task.state !== 'claimed') throw new Error(`Задача не в роботі (стан «${task.state}»)`);
  if (task.leaseHolder !== holder) throw new Error(`Задачу взяв ${task.leaseHolder}, а не ${holder}`);
}

export function heartbeatTask(id: string, holder: string): Task {
  const task = requireTask(id);
  requireHolder(task, holder);
  const minutes = requireProject(task.projectId).settings.thresholds.leaseMinutes;
  setState(id, 'claimed', { lease_until: new Date(Date.now() + minutes * 60_000).toISOString() });
  return requireTask(id);
}

export function releaseTask(id: string, holder: string, reason = ''): Task {
  return tx(() => {
    const task = requireTask(id);
    requireHolder(task, holder);
    setState(id, 'queued', { lease_holder: null, lease_until: null });
    finishJob(id, holder, 'released');
    addEvent(id, { author: holder, authorKind: 'agent', type: 'status', text: reason || 'Повернуто в чергу', data: { state: 'queued' } });
    return requireTask(id);
  });
}

/** Агент перепитує QA: задача чекає відповіді й не займає оренду. */
export function askQuestion(id: string, holder: string, text: string): Task {
  return tx(() => {
    const task = requireTask(id);
    requireHolder(task, holder);
    setState(id, 'needs_info', { lease_holder: null, lease_until: null });
    finishJob(id, holder, 'needs_info');
    addEvent(id, { author: holder, authorKind: 'agent', type: 'question', text });
    return requireTask(id);
  });
}

/** Відповідь людини: задача повертається в чергу. */
export function answerTask(id: string, author: string, authorKind: ActorKind, text: string): Task {
  return tx(() => {
    const task = requireTask(id);
    addEvent(id, { author, authorKind, type: 'answer', text });
    if (task.state === 'needs_info') setState(id, 'queued', { queued_at: task.queuedAt });
    return requireTask(id);
  });
}

export function commentTask(id: string, author: string, authorKind: ActorKind, text: string): TaskEvent {
  requireTask(id);
  return addEvent(id, { author, authorKind, type: 'comment', text });
}

function prNumberFromUrl(url?: string): number | undefined {
  const match = url?.match(/\/pull\/(\d+)/);
  return match ? Number(match[1]) : undefined;
}

/**
 * Звіт агента: PR, тести і «що перевіряє» простими словами. Задача переходить
 * у `review` — далі слово за QA (намір) і розробником (код у PR).
 */
export function reportTask(id: string, holder: string, report: Partial<TaskReport>): Task {
  return tx(() => {
    const task = requireTask(id);
    requireHolder(task, holder);
    const parsed = taskReportSchema.parse(report);
    if (PR_KINDS.has(task.kind) && !parsed.prUrl) {
      throw new Error('Для цієї задачі потрібне посилання на PR: агент віддає результат лише через PR');
    }
    const prNumber = prNumberFromUrl(parsed.prUrl);
    // Злиття рахується лише для PR цього звіту: після «інакше» старий PR уже не закриває задачу.
    const merged = prNumber
      ? queryOne<Row>(`SELECT merged_at FROM pull_requests WHERE project_id = ? AND number = ? AND state = 'merged'`, [task.projectId, prNumber])
      : undefined;
    setState(id, 'review', {
      merged_at: (merged?.merged_at as string | undefined) ?? null,
      lease_holder: null,
      lease_until: null,
      report: toJson(parsed),
      pr_url: parsed.prUrl ?? null,
      pr_number: prNumber ?? null,
      branch: parsed.branch ?? null,
      qa_confirmed_by: null,
      qa_confirmed_at: null,
    });
    finishJob(id, holder, 'reported', { prUrl: parsed.prUrl, branch: parsed.branch });
    addEvent(id, {
      author: holder,
      authorKind: 'agent',
      type: 'interpretation',
      text: parsed.summary,
      data: { checks: parsed.checks, tests: parsed.tests, prUrl: parsed.prUrl },
    });
    return requireTask(id);
  });
}

export function failTask(id: string, holder: string, reason: string): Task {
  return tx(() => {
    const task = requireTask(id);
    requireHolder(task, holder);
    setState(id, 'failed', { lease_holder: null, lease_until: null });
    finishJob(id, holder, 'failed');
    addEvent(id, { author: holder, authorKind: 'agent', type: 'status', text: reason || 'Не вдалося', data: { state: 'failed' } });
    return requireTask(id);
  });
}

/** QA повертає невдалу задачу в чергу: агент візьме її знову. */
export function retryTask(id: string, author: string, authorKind: ActorKind, note = ''): Task {
  return tx(() => {
    const task = requireTask(id);
    if (task.state !== 'failed') throw new Error(`Повторити можна лише невдалу задачу (зараз «${task.state}»)`);
    setState(id, 'queued', { queued_at: nowIso() });
    addEvent(id, { author, authorKind, type: 'status', text: note || 'Повторити', data: { state: 'queued' } });
    return requireTask(id);
  });
}

/** QA підтверджує намір. Задача з PR закривається, коли PR злито; без PR — одразу. */
export function confirmTask(id: string, reviewer: string): Task {
  return tx(() => {
    const task = requireTask(id);
    if (task.state !== 'review') throw new Error(`Підтвердити можна лише задачу на перевірці (зараз «${task.state}»)`);
    const at = nowIso();
    const done = !PR_KINDS.has(task.kind) || Boolean(task.mergedAt);
    setState(id, done ? 'done' : 'review', { qa_confirmed_by: reviewer, qa_confirmed_at: at, done_at: done ? at : null });
    addEvent(id, {
      author: reviewer,
      authorKind: 'qa',
      type: 'status',
      text: done ? 'QA підтвердив, задачу закрито' : 'QA підтвердив намір, чекаємо злиття PR',
      data: { state: done ? 'done' : 'review' },
    });
    return requireTask(id);
  });
}

/** QA просить інакше: задача повертається в чергу з коментарем. */
export function requestChanges(id: string, reviewer: string, note: string): Task {
  return tx(() => {
    const task = requireTask(id);
    if (task.state !== 'review') throw new Error(`Повернути можна лише задачу на перевірці (зараз «${task.state}»)`);
    setState(id, 'queued', { qa_confirmed_by: null, qa_confirmed_at: null, queued_at: nowIso() });
    addEvent(id, { author: reviewer, authorKind: 'qa', type: 'comment', text: note || 'Потрібно інакше', data: { state: 'queued' } });
    return requireTask(id);
  });
}

export function rejectTask(id: string, author: string, authorKind: ActorKind, note = ''): Task {
  return tx(() => {
    const task = requireTask(id);
    if (task.state === 'done' || task.state === 'rejected') throw new Error(`Задача вже в стані «${task.state}»`);
    if (task.state === 'claimed' && task.leaseHolder) finishJob(id, task.leaseHolder, 'rejected');
    setState(id, 'rejected', { lease_holder: null, lease_until: null, done_at: nowIso() });
    addEvent(id, { author, authorKind, type: 'status', text: note || 'Відхилено', data: { state: 'rejected' } });
    return requireTask(id);
  });
}

/** Закриває задачу без PR від імені системи (наприклад, погоджено план чи прочитання). */
export function completeTask(id: string, author: string, authorKind: ActorKind, note: string): Task {
  return tx(() => {
    const task = requireTask(id);
    if (task.state === 'done' || task.state === 'rejected') return task;
    setState(id, 'done', { lease_holder: null, lease_until: null, done_at: nowIso() });
    addEvent(id, { author, authorKind, type: 'status', text: note, data: { state: 'done' } });
    return task;
  });
}

/**
 * Подія PR із CI. Злиття фіксує `merged_at` і закриває задачі, де QA вже
 * підтвердив намір. Закриття без злиття повертає задачі в чергу.
 */
export function applyPrEvent(projectId: string, prNumber: number, state: 'opened' | 'merged' | 'closed'): number {
  return tx(() => {
    const rows = query<Row>(`SELECT * FROM tasks WHERE project_id = ? AND pr_number = ? AND state = 'review'`, [projectId, prNumber]);
    for (const row of rows) {
      const task = rowToTask(row);
      const at = nowIso();
      if (state === 'merged') {
        const done = Boolean(task.qaConfirmedAt);
        setState(task.id, done ? 'done' : 'review', { merged_at: at, done_at: done ? at : null });
        addEvent(task.id, {
          author: 'ci',
          authorKind: 'system',
          type: 'status',
          text: done ? `PR #${prNumber} злито, задачу закрито` : `PR #${prNumber} злито, чекаємо підтвердження QA`,
          data: { state: done ? 'done' : 'review' },
        });
      } else if (state === 'closed') {
        setState(task.id, 'queued', { pr_url: null, pr_number: null, queued_at: at, qa_confirmed_by: null, qa_confirmed_at: null });
        addEvent(task.id, { author: 'ci', authorKind: 'system', type: 'status', text: `PR #${prNumber} закрито без злиття — задача знову в черзі`, data: { state: 'queued' } });
      }
    }
    return state === 'opened' ? 0 : rows.length;
  });
}

/** Повертає в чергу задачі з простроченою орендою. Викликається фоновою задачею. */
export function expireLeases(now = new Date()): string[] {
  return tx(() => {
    const rows = query<Row>(`SELECT * FROM tasks WHERE state = 'claimed' AND lease_until IS NOT NULL AND lease_until <= ?`, [
      now.toISOString(),
    ]);
    for (const row of rows) {
      const task = rowToTask(row);
      setState(task.id, 'queued', { lease_holder: null, lease_until: null });
      if (task.leaseHolder) finishJob(task.id, task.leaseHolder, 'expired');
      addEvent(task.id, { author: 'jules', authorKind: 'system', type: 'status', text: 'Оренда прострочена — задача знову в черзі', data: { state: 'queued' } });
    }
    return rows.map((row) => String(row.id));
  });
}

/** Задачі в черзі, що чекають довше порогу. */
export function staleTasks(projectId: string, hours: number, now = new Date()): TaskListItem[] {
  const threshold = new Date(now.getTime() - hours * 3_600_000).toISOString();
  const kinds = [...AGENT_KINDS];
  return query<Row>(
    `SELECT * FROM tasks WHERE project_id = ? AND state = 'queued' AND queued_at <= ? AND kind IN (${placeholders(kinds.length)})
     ORDER BY queued_at`,
    [projectId, threshold, ...kinds],
  ).map((row) => {
    const task = rowToTask(row);
    return { ...task, ageHours: ageHours(task, now.getTime()) };
  });
}

/** Записує, що саме з входів віддано агенту, — журнал для гігієни даних. */
export function recordGiven(taskId: string, holder: string, given: Array<{ kind: string; id: string }>): void {
  const row = queryOne<Row>(
    'SELECT id, given FROM agent_jobs WHERE task_id = ? AND holder = ? AND finished_at IS NULL ORDER BY started_at DESC LIMIT 1',
    [taskId, holder],
  );
  if (!row) return;
  const current = fromJson<Array<{ kind: string; id: string }>>(row.given, []);
  const keys = new Set(current.map((item) => `${item.kind}:${item.id}`));
  for (const item of given) if (!keys.has(`${item.kind}:${item.id}`)) current.push(item);
  execute('UPDATE agent_jobs SET given = ? WHERE id = ?', [toJson(current), row.id]);
}

export interface AgentJob {
  id: string;
  taskId: string;
  holder: string;
  agent?: string;
  model?: string;
  given: Array<{ kind: string; id: string }>;
  branch?: string;
  prUrl?: string;
  outcome?: string;
  startedAt: string;
  finishedAt?: string;
}

export function listJobs(taskId: string): AgentJob[] {
  return query<Row>('SELECT * FROM agent_jobs WHERE task_id = ? ORDER BY started_at DESC', [taskId]).map((row) => ({
    id: String(row.id),
    taskId: String(row.task_id),
    holder: String(row.holder),
    agent: (row.agent as string | null) ?? undefined,
    model: (row.model as string | null) ?? undefined,
    given: fromJson(row.given, []),
    branch: (row.branch as string | null) ?? undefined,
    prUrl: (row.pr_url as string | null) ?? undefined,
    outcome: (row.outcome as string | null) ?? undefined,
    startedAt: String(row.started_at),
    finishedAt: (row.finished_at as string | null) ?? undefined,
  }));
}

/** Частка результатів агентів, які QA погодив з першої спроби, у розрізі моделей. */
export function acceptanceByModel(projectId: string): Array<{ model: string; reported: number; firstTime: number }> {
  const rows = query<Row>(
    `SELECT COALESCE(j.model, 'невідомо') AS model, j.task_id,
            (SELECT COUNT(*) FROM agent_jobs j2 WHERE j2.task_id = j.task_id AND j2.outcome = 'reported') AS reports,
            t.qa_confirmed_at
     FROM agent_jobs j JOIN tasks t ON t.id = j.task_id
     WHERE j.project_id = ? AND j.outcome = 'reported'`,
    [projectId],
  );
  const byModel = new Map<string, { reported: number; firstTime: number }>();
  for (const row of rows) {
    const key = String(row.model);
    const bucket = byModel.get(key) ?? { reported: 0, firstTime: 0 };
    bucket.reported += 1;
    if (row.qa_confirmed_at && Number(row.reports) === 1) bucket.firstTime += 1;
    byModel.set(key, bucket);
  }
  return [...byModel.entries()].map(([model, value]) => ({ model, ...value })).sort((a, b) => a.model.localeCompare(b.model));
}

export function countTasks(projectId: string): Record<TaskState, number> {
  const result = { new: 0, queued: 0, claimed: 0, needs_info: 0, review: 0, failed: 0, done: 0, rejected: 0 } as Record<TaskState, number>;
  for (const row of query<Row>('SELECT state, COUNT(*) AS n FROM tasks WHERE project_id = ? GROUP BY state', [projectId])) {
    result[row.state as TaskState] = Number(row.n);
  }
  return result;
}
