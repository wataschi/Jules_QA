/**
 * Тести в коді продукту й результати CI за комітом.
 *
 * Зв'язок «тест ↔ кейс» береться з ID кейса в назві тесту (маніфест).
 * Кожен прийом результатів — окремий прогін реєстру (`kind='ci'`) із SHA,
 * гілкою й PR; результат кейса — зведення його тестів: упав хоч один → `failed`,
 * пройшов із повторами → `healed` (сирий статус, від нього рахується `flakeScore`).
 * Так наявні дашборд, історія кейса й нестабільність працюють і для тестів з коду.
 */
import { execute, fromJson, nowIso, placeholders, query, queryOne, toJson, tx, type Row } from './db.js';
import { newId } from './ids.js';
import { getCase, touchAutomationResult, updateCase } from './cases-store.js';
import { persistFlakeScores } from './dashboard.js';
import { requireProject } from './projects-store.js';
import {
  codeTestSchema,
  type CasePriority,
  type CodeTest,
  type ItemStatus,
  type Page,
  type TestLevelName,
} from './types.js';
import type {
  AssertionChange,
  FileCoverage,
  Framework,
  Manifest,
  MutationFile,
  ParsedTestResult,
  TestLevel,
} from '../ingest/index.js';

export interface IngestResult extends ParsedTestResult {
  key: string;
  caseIds: string[];
  level: TestLevel;
}

export interface IngestRunInput {
  projectId: string;
  sha: string;
  branch: string;
  prNumber?: number;
  event: 'pr' | 'main' | 'local';
  source: 'ci' | 'local';
  runUrl?: string;
  startedAt?: string;
  finishedAt?: string;
  manifest?: Manifest;
  results: IngestResult[];
  coverage?: FileCoverage[];
  mutation?: MutationFile[];
  assertionChanges?: AssertionChange[];
  author?: string;
}

export interface IngestRunOutcome {
  runId: string;
  tests: number;
  failed: number;
  unknownCases: string[];
  /** Тести, що впали в цьому прогоні — для задач розбору на main. */
  failedTests: Array<{ testId: string; file: string; name: string; caseIds: string[]; error?: string }>;
  /** Тести, що пройшли з повторами. */
  flakyTests: Array<{ testId: string; file: string; name: string; caseIds: string[] }>;
}

function rowToTest(row: Row): CodeTest {
  return codeTestSchema.parse({
    id: row.id,
    projectId: row.project_id,
    testKey: row.test_key,
    file: row.file,
    name: row.name,
    fullName: row.full_name,
    level: row.level,
    framework: row.framework,
    author: row.author,
    state: row.state,
    onMain: Boolean(row.on_main),
    caseIds: fromJson<string[]>(row.case_ids, []),
    firstSeenSha: row.first_seen_sha ?? undefined,
    lastSeenSha: row.last_seen_sha ?? undefined,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastResult: row.last_status
      ? { status: row.last_status, at: row.last_at, sha: row.last_sha ?? undefined, runId: row.last_run_id }
      : undefined,
  });
}

/** SELECT тестів разом із кейсами й останнім результатом. */
const TEST_SELECT = `
  SELECT t.*,
    (SELECT json_group_array(case_id) FROM test_links tl WHERE tl.test_id = t.id) AS case_ids,
    lr.status AS last_status, lr.created_at AS last_at, lr.run_id AS last_run_id, rr.sha AS last_sha
  FROM tests t
  LEFT JOIN test_results lr ON lr.id = (
    SELECT id FROM test_results WHERE test_id = t.id ORDER BY created_at DESC, rowid DESC LIMIT 1)
  LEFT JOIN registry_runs rr ON rr.id = lr.run_id`;

function caseExists(ids: readonly string[], projectId: string): Set<string> {
  if (ids.length === 0) return new Set();
  return new Set(
    query<Row>(`SELECT id FROM cases WHERE project_id = ? AND id IN (${placeholders(ids.length)})`, [projectId, ...ids]).map(
      (row) => String(row.id),
    ),
  );
}

function upsertTest(
  projectId: string,
  result: { key: string; file: string; name: string; fullName: string; level: string; framework: Framework },
  sha: string,
  at: string,
): string {
  const existing = queryOne<Row>('SELECT id FROM tests WHERE project_id = ? AND test_key = ?', [projectId, result.key]);
  if (existing) {
    execute(
      `UPDATE tests SET file = ?, name = ?, full_name = ?, level = ?, framework = ?, last_seen_sha = ?, last_seen_at = ?,
         state = CASE WHEN state IN ('quarantined') THEN state ELSE 'active' END
       WHERE id = ?`,
      [result.file, result.name, result.fullName, result.level, result.framework, sha, at, existing.id],
    );
    return String(existing.id);
  }
  const id = newId('tst');
  execute(
    `INSERT INTO tests (id, project_id, test_key, file, name, full_name, level, framework, first_seen_sha, last_seen_sha,
       first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, projectId, result.key, result.file, result.name, result.fullName, result.level, result.framework, sha, sha, at, at],
  );
  return id;
}

function setLinks(testId: string, caseIds: string[]): void {
  execute('DELETE FROM test_links WHERE test_id = ?', [testId]);
  for (const caseId of caseIds) {
    execute('INSERT OR IGNORE INTO test_links (test_id, case_id) VALUES (?, ?)', [testId, caseId]);
  }
}

function caseStatus(statuses: Array<{ status: string; retries: number }>): ItemStatus | 'healed' {
  if (statuses.some((item) => item.status === 'failed')) return 'failed';
  if (statuses.every((item) => item.status === 'skipped')) return 'skipped';
  if (statuses.some((item) => item.status === 'passed' && item.retries > 0)) return 'healed';
  return 'passed';
}

/** Приймає результати одного прогону CI (або локального). */
export function ingestRun(input: IngestRunInput): IngestRunOutcome {
  return tx(() => {
    const project = requireProject(input.projectId);
    const at = nowIso();
    const runId = newId('run');
    const sha7 = input.sha.slice(0, 7);
    const title =
      input.event === 'pr'
        ? `CI · PR #${input.prNumber ?? '?'} @ ${sha7}`
        : input.event === 'main'
          ? `CI · ${input.branch} @ ${sha7}`
          : `Локально · ${input.branch} @ ${sha7}`;
    execute(
      `INSERT INTO registry_runs (id, project_id, kind, title, env, state, executor, started_at, finished_at, note,
         sha, branch, pr_number, source, event, run_url)
       VALUES (?, ?, 'ci', ?, '{}', 'completed', ?, ?, ?, '', ?, ?, ?, ?, ?, ?)`,
      [
        runId,
        project.id,
        title,
        input.author ?? input.source,
        input.startedAt ?? at,
        input.finishedAt ?? at,
        input.sha,
        input.branch,
        input.prNumber ?? null,
        input.source,
        input.event,
        input.runUrl ?? null,
      ],
    );

    const allCaseIds = [...new Set(input.results.flatMap((result) => result.caseIds))];
    const known = caseExists(allCaseIds, project.id);
    const unknownCases = allCaseIds.filter((id) => !known.has(id)).sort();

    const perCase = new Map<string, Array<{ status: string; retries: number; name: string; durationMs?: number }>>();
    const failedTests: IngestRunOutcome['failedTests'] = [];
    const flakyTests: IngestRunOutcome['flakyTests'] = [];
    const seen = new Set<string>();

    for (const result of input.results) {
      if (seen.has(result.key)) continue;
      seen.add(result.key);
      const testId = upsertTest(project.id, result, input.sha, at);
      const caseIds = result.caseIds.filter((id) => known.has(id));
      // Стан тесту, його зв'язки й статус кейса задає main. Прогони PR і локальні
      // лише додають результати; зв'язки ставлять тільки новим тестам, яких на main ще немає.
      const onMain = Number(queryOne<Row>('SELECT on_main FROM tests WHERE id = ?', [testId])?.on_main ?? 0) === 1;
      if (input.event === 'main' || !onMain) setLinks(testId, caseIds);
      if (input.event === 'main') {
        if (result.status === 'skipped') execute(`UPDATE tests SET state = 'skipped' WHERE id = ? AND state = 'active'`, [testId]);
        else execute(`UPDATE tests SET state = 'active' WHERE id = ? AND state = 'skipped'`, [testId]);
        execute('UPDATE tests SET on_main = 1 WHERE id = ?', [testId]);
      }
      execute(
        `INSERT INTO test_results (id, run_id, test_id, status, duration_ms, error, retries, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId('trs'), runId, testId, result.status, result.durationMs ?? null, result.error ?? null, result.retries ?? 0, at],
      );
      if (result.status === 'failed') {
        failedTests.push({ testId, file: result.file, name: result.fullName, caseIds, error: result.error });
      } else if (result.status === 'passed' && (result.retries ?? 0) > 0) {
        flakyTests.push({ testId, file: result.file, name: result.fullName, caseIds });
      }
      for (const caseId of caseIds) {
        const bucket = perCase.get(caseId) ?? [];
        bucket.push({ status: result.status, retries: result.retries ?? 0, name: result.fullName, durationMs: result.durationMs });
        perCase.set(caseId, bucket);
      }
    }

    // Повний маніфест на main: тести, яких у ньому вже немає, прибрані з коду.
    // Порожній маніфест — це радше збій збирання, ніж видалення всіх тестів, тож його пропускаємо.
    if (input.event === 'main' && input.manifest && input.manifest.tests.length > 0) {
      const keys = input.manifest.tests.map((test) => test.key);
      execute(
        `UPDATE tests SET state = 'removed', on_main = 0
         WHERE project_id = ? AND on_main = 1 AND test_key NOT IN (${placeholders(keys.length)})`,
        [project.id, ...keys],
      );
    }

    let position = 0;
    for (const [caseId, statuses] of [...perCase.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const status = caseStatus(statuses);
      const failedNames = statuses.filter((item) => item.status === 'failed').map((item) => item.name);
      const duration = statuses.reduce((sum, item) => sum + (item.durationMs ?? 0), 0);
      execute(
        `INSERT INTO run_items (id, run_id, case_id, position, status, comment, evidence, duration_ms, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId('itm'),
          runId,
          caseId,
          position,
          status,
          failedNames.length ? `Впали: ${failedNames.join('; ')}` : `${statuses.length} тест(ів)`,
          toJson(input.runUrl ? [input.runUrl] : []),
          Math.round(duration),
          at,
          'ci',
        ],
      );
      position += 1;
      if (input.event !== 'main' || status === 'skipped') continue;
      touchAutomationResult(caseId, {
        lastAutoRunId: runId,
        lastAutoStatus: status === 'failed' ? 'failed' : 'passed',
        lastAutoAt: at,
      });
    }

    for (const file of input.coverage ?? []) {
      execute(
        `INSERT INTO code_coverage (id, project_id, run_id, sha, branch, path, lines_found, lines_hit, branches_found, branches_hit, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, sha, path) DO UPDATE SET lines_found = excluded.lines_found, lines_hit = excluded.lines_hit,
           branches_found = excluded.branches_found, branches_hit = excluded.branches_hit, run_id = excluded.run_id`,
        [newId('cov'), project.id, runId, input.sha, input.branch, file.path, file.linesFound, file.linesHit,
          file.branchesFound ?? null, file.branchesHit ?? null, at],
      );
    }
    for (const file of input.mutation ?? []) {
      execute(
        `INSERT INTO code_coverage (id, project_id, run_id, sha, branch, path, mutants_total, mutants_killed, mutants_survived, mutation_score, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, sha, path) DO UPDATE SET mutants_total = excluded.mutants_total,
           mutants_killed = excluded.mutants_killed, mutants_survived = excluded.mutants_survived,
           mutation_score = excluded.mutation_score`,
        [newId('cov'), project.id, runId, input.sha, input.branch, file.path, file.total, file.killed, file.survived, file.score, at],
      );
    }

    if (input.prNumber && input.event === 'pr') {
      upsertPullRequest(project.id, input.prNumber, {
        sha: input.sha,
        headBranch: input.branch,
        assertionChanges: input.assertionChanges ?? [],
      });
    }

    if (input.event === 'main') {
      markAutomatedFromMain(project.id);
      unmarkRemovedFromMain(project.id);
    }
    persistFlakeScores(project.id);

    return {
      runId,
      tests: seen.size,
      failed: failedTests.length,
      unknownCases,
      failedTests,
      flakyTests,
    };
  });
}

/**
 * Статус автоматизації виводиться з коду: кейс із живим тестом на main —
 * `automated`. Карантин — рішення людини, його не чіпаємо.
 */
function markAutomatedFromMain(projectId: string): void {
  const rows = query<Row>(
    `SELECT DISTINCT c.id FROM cases c
       JOIN test_links tl ON tl.case_id = c.id
       JOIN tests t ON t.id = tl.test_id AND t.on_main = 1 AND t.state = 'active'
     WHERE c.project_id = ? AND json_extract(c.automation, '$.status') IN ('manual', 'candidate')`,
    [projectId],
  );
  for (const row of rows) {
    const current = getCase(String(row.id));
    if (!current) continue;
    updateCase(
      current.id,
      { automation: { ...current.automation, status: 'automated' } },
      { author: 'ci', reason: 'з’явився тест у коді на main' },
    );
  }
}

/** Кейс, усі тести якого прибрано з коду, знову чекає на автоматизацію. */
function unmarkRemovedFromMain(projectId: string): void {
  const rows = query<Row>(
    `SELECT c.id FROM cases c
     WHERE c.project_id = ? AND json_extract(c.automation, '$.status') = 'automated'
       AND EXISTS (SELECT 1 FROM test_links tl WHERE tl.case_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM test_links tl JOIN tests t ON t.id = tl.test_id WHERE tl.case_id = c.id AND t.state <> 'removed')`,
    [projectId],
  );
  for (const row of rows) {
    const current = getCase(String(row.id));
    if (!current) continue;
    updateCase(
      current.id,
      { automation: { ...current.automation, status: 'candidate' } },
      { author: 'ci', reason: 'тести кейса прибрано з коду на main' },
    );
  }
}

/* ─────────────────────────────── PR і пуші ─────────────────────────────── */

export interface PullRequestInfo {
  projectId: string;
  number: number;
  state: 'opened' | 'merged' | 'closed';
  title?: string;
  url?: string;
  headBranch?: string;
  sha?: string;
  assertionChanges: AssertionChange[];
  updatedAt: string;
  mergedAt?: string;
}

export function upsertPullRequest(
  projectId: string,
  number: number,
  patch: Partial<Omit<PullRequestInfo, 'projectId' | 'number' | 'updatedAt'>>,
): PullRequestInfo {
  const at = nowIso();
  const existing = queryOne<Row>('SELECT * FROM pull_requests WHERE project_id = ? AND number = ?', [projectId, number]);
  if (!existing) {
    execute(
      `INSERT INTO pull_requests (project_id, number, state, title, url, head_branch, sha, assertion_changes, updated_at, merged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [projectId, number, patch.state ?? 'opened', patch.title ?? null, patch.url ?? null, patch.headBranch ?? null,
        patch.sha ?? null, toJson(patch.assertionChanges ?? []), at, patch.state === 'merged' ? at : null],
    );
  } else {
    execute(
      `UPDATE pull_requests SET state = COALESCE(?, state), title = COALESCE(?, title), url = COALESCE(?, url),
         head_branch = COALESCE(?, head_branch), sha = COALESCE(?, sha),
         assertion_changes = COALESCE(?, assertion_changes), updated_at = ?,
         merged_at = CASE WHEN ? = 'merged' THEN ? ELSE merged_at END
       WHERE project_id = ? AND number = ?`,
      [patch.state ?? null, patch.title ?? null, patch.url ?? null, patch.headBranch ?? null, patch.sha ?? null,
        patch.assertionChanges ? toJson(patch.assertionChanges) : null, at, patch.state ?? null, at, projectId, number],
    );
  }
  return getPullRequest(projectId, number) as PullRequestInfo;
}

export function getPullRequest(projectId: string, number: number): PullRequestInfo | null {
  const row = queryOne<Row>('SELECT * FROM pull_requests WHERE project_id = ? AND number = ?', [projectId, number]);
  if (!row) return null;
  return {
    projectId,
    number,
    state: row.state as PullRequestInfo['state'],
    title: (row.title as string | null) ?? undefined,
    url: (row.url as string | null) ?? undefined,
    headBranch: (row.head_branch as string | null) ?? undefined,
    sha: (row.sha as string | null) ?? undefined,
    assertionChanges: fromJson<AssertionChange[]>(row.assertion_changes, []),
    updatedAt: String(row.updated_at),
    mergedAt: (row.merged_at as string | null) ?? undefined,
  };
}

export interface PushCheck {
  id: string;
  sha: string;
  branch: string;
  viaPr: boolean;
  prNumbers: number[];
  author?: string;
  acknowledgedBy?: string;
  createdAt: string;
}

/** Записує перевірку пушу в main. Повертає `true`, якщо коміт прийшов повз PR. */
export function recordPushCheck(
  projectId: string,
  input: { sha: string; branch: string; viaPr: boolean; prNumbers: number[]; author?: string },
): boolean {
  execute(
    `INSERT INTO push_checks (id, project_id, sha, branch, via_pr, pr_numbers, author, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, sha) DO UPDATE SET via_pr = excluded.via_pr, pr_numbers = excluded.pr_numbers`,
    [newId('psh'), projectId, input.sha, input.branch, input.viaPr ? 1 : 0, toJson(input.prNumbers), input.author ?? null, nowIso()],
  );
  return !input.viaPr;
}

export function directPushes(projectId: string, options: { includeAcknowledged?: boolean } = {}): PushCheck[] {
  return query<Row>(
    `SELECT * FROM push_checks WHERE project_id = ? AND via_pr = 0 ${options.includeAcknowledged ? '' : 'AND acknowledged_by IS NULL'}
     ORDER BY created_at DESC LIMIT 50`,
    [projectId],
  ).map((row) => ({
    id: String(row.id),
    sha: String(row.sha),
    branch: String(row.branch),
    viaPr: Boolean(row.via_pr),
    prNumbers: fromJson<number[]>(row.pr_numbers, []),
    author: (row.author as string | null) ?? undefined,
    acknowledgedBy: (row.acknowledged_by as string | null) ?? undefined,
    createdAt: String(row.created_at),
  }));
}

export function acknowledgePush(projectId: string, id: string, by: string): void {
  const result = execute('UPDATE push_checks SET acknowledged_by = ? WHERE project_id = ? AND id = ?', [by, projectId, id]);
  if (Number(result.changes) === 0) throw new Error(`Перевірку пушу «${id}» не знайдено`);
}

/* ─────────────────────────────── читання ───────────────────────────────── */

export function getTest(id: string): CodeTest | null {
  const row = queryOne<Row>(`${TEST_SELECT} WHERE t.id = ?`, [id]);
  return row ? rowToTest(row) : null;
}

export function testsForCase(caseId: string): CodeTest[] {
  return query<Row>(`${TEST_SELECT} WHERE t.id IN (SELECT test_id FROM test_links WHERE case_id = ?) ORDER BY t.file, t.full_name`, [
    caseId,
  ]).map(rowToTest);
}

export interface ListTestsOptions {
  projectId: string;
  caseId?: string;
  file?: string;
  level?: TestLevelName;
  withoutCase?: boolean;
  status?: 'passed' | 'failed' | 'skipped';
  onMain?: boolean;
  q?: string;
  page?: number;
  limit?: number;
}

export function listTests(options: ListTestsOptions): Page<CodeTest> {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const limit = Math.min(500, Math.max(1, Math.floor(options.limit ?? 100)));
  const where = ["t.project_id = ?", "t.state <> 'removed'"];
  const params: unknown[] = [options.projectId];
  if (options.caseId) {
    where.push('t.id IN (SELECT test_id FROM test_links WHERE case_id = ?)');
    params.push(options.caseId);
  }
  if (options.file) {
    where.push('t.file LIKE ?');
    params.push(`${options.file}%`);
  }
  if (options.level) {
    where.push('t.level = ?');
    params.push(options.level);
  }
  if (options.withoutCase) where.push('NOT EXISTS (SELECT 1 FROM test_links tl WHERE tl.test_id = t.id)');
  if (options.onMain) where.push('t.on_main = 1');
  if (options.q) {
    where.push('(lower(t.full_name) LIKE ? OR lower(t.file) LIKE ?)');
    params.push(`%${options.q.toLowerCase()}%`, `%${options.q.toLowerCase()}%`);
  }
  if (options.status) {
    where.push(`(SELECT status FROM test_results WHERE test_id = t.id ORDER BY created_at DESC, rowid DESC LIMIT 1) = ?`);
    params.push(options.status);
  }
  const clause = where.join(' AND ');
  const total = Number(queryOne<Row>(`SELECT COUNT(*) AS n FROM tests t WHERE ${clause}`, params)?.n ?? 0);
  const items = query<Row>(`${TEST_SELECT} WHERE ${clause} ORDER BY t.file, t.full_name LIMIT ? OFFSET ?`, [
    ...params,
    limit,
    (page - 1) * limit,
  ]).map(rowToTest);
  return { items, total, page, limit };
}

export function testsWithoutCaseCount(projectId: string): number {
  return Number(
    queryOne<Row>(
      `SELECT COUNT(*) AS n FROM tests t WHERE t.project_id = ? AND t.state <> 'removed'
         AND NOT EXISTS (SELECT 1 FROM test_links tl WHERE tl.test_id = t.id)`,
      [projectId],
    )?.n ?? 0,
  );
}

/** Погоджені кейси без жодного живого тесту — «кейс без тесту». */
export function casesWithoutTests(
  projectId: string,
  options: { priorities?: CasePriority[] } = {},
): Array<{ caseId: string; title: string; priority: CasePriority; sectionId: string }> {
  const where = ["c.project_id = ?", "c.status = 'approved'"];
  const params: unknown[] = [projectId];
  if (options.priorities?.length) {
    where.push(`c.priority IN (${placeholders(options.priorities.length)})`);
    params.push(...options.priorities);
  }
  return query<Row>(
    `SELECT c.id, c.title, c.priority, c.section_id FROM cases c
     WHERE ${where.join(' AND ')}
       AND NOT EXISTS (SELECT 1 FROM test_links tl JOIN tests t ON t.id = tl.test_id
                       WHERE tl.case_id = c.id AND t.state <> 'removed')
     ORDER BY c.id`,
    params,
  ).map((row) => ({
    caseId: String(row.id),
    title: String(row.title),
    priority: row.priority as CasePriority,
    sectionId: String(row.section_id),
  }));
}

/** Останній прогін CI для гілки (main за замовчуванням) або PR. */
export function latestCiRun(
  projectId: string,
  options: { branch?: string; prNumber?: number; sha?: string } = {},
): { id: string; sha: string; branch: string; startedAt: string; runUrl?: string } | null {
  const where = ["project_id = ?", "kind = 'ci'"];
  const params: unknown[] = [projectId];
  if (options.sha) {
    where.push('sha = ?');
    params.push(options.sha);
  }
  if (options.prNumber) {
    where.push('pr_number = ?');
    params.push(options.prNumber);
  } else if (!options.sha) {
    where.push("event = 'main' AND branch = ?");
    params.push(options.branch ?? 'main');
  }
  const row = queryOne<Row>(`SELECT * FROM registry_runs WHERE ${where.join(' AND ')} ORDER BY started_at DESC, rowid DESC LIMIT 1`, params);
  if (!row) return null;
  return {
    id: String(row.id),
    sha: String(row.sha ?? ''),
    branch: String(row.branch ?? ''),
    startedAt: String(row.started_at),
    runUrl: (row.run_url as string | null) ?? undefined,
  };
}

export interface RunTestResult {
  testId: string;
  file: string;
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  error?: string;
  retries: number;
  caseIds: string[];
  isNew: boolean;
}

/** Результати тестів одного прогону; `isNew` — тест уперше побачено в цьому коміті. */
export function runTestResults(runId: string): RunTestResult[] {
  return query<Row>(
    `SELECT tr.*, t.file, t.full_name, t.first_seen_sha, rr.sha,
       (SELECT json_group_array(case_id) FROM test_links tl WHERE tl.test_id = t.id) AS case_ids
     FROM test_results tr JOIN tests t ON t.id = tr.test_id JOIN registry_runs rr ON rr.id = tr.run_id
     WHERE tr.run_id = ? ORDER BY t.file, t.full_name`,
    [runId],
  ).map((row) => ({
    testId: String(row.test_id),
    file: String(row.file),
    name: String(row.full_name),
    status: row.status as RunTestResult['status'],
    error: (row.error as string | null) ?? undefined,
    retries: Number(row.retries ?? 0),
    caseIds: fromJson<string[]>(row.case_ids, []),
    isNew: row.first_seen_sha === row.sha,
  }));
}

/** Покриття рядків і мутації для коміту, зведені по файлах. */
export function coverageForSha(projectId: string, sha: string): Array<{
  path: string;
  linesFound?: number;
  linesHit?: number;
  mutationScore?: number | null;
  mutantsSurvived?: number;
}> {
  return query<Row>('SELECT * FROM code_coverage WHERE project_id = ? AND sha = ? ORDER BY path', [projectId, sha]).map((row) => ({
    path: String(row.path),
    linesFound: (row.lines_found as number | null) ?? undefined,
    linesHit: (row.lines_hit as number | null) ?? undefined,
    mutationScore: (row.mutation_score as number | null) ?? undefined,
    mutantsSurvived: (row.mutants_survived as number | null) ?? undefined,
  }));
}

/** Тест у карантин (флейк) або назад. */
export function setTestState(id: string, state: 'active' | 'quarantined'): CodeTest {
  const result = execute(`UPDATE tests SET state = ? WHERE id = ? AND state <> 'removed'`, [state, id]);
  if (Number(result.changes) === 0) throw new Error(`Тест «${id}» не знайдено`);
  return getTest(id) as CodeTest;
}

/** Тести, які агент додав у межах задачі, позначаються як написані агентом. */
export function markAgentTests(projectId: string, tests: Array<{ file: string; name: string }>): number {
  let marked = 0;
  for (const test of tests) {
    const name = test.name.trim();
    if (!name) continue;
    const pattern = `%${name.replace(/[\\%_]/g, (char) => `\\${char}`)}`;
    const result = execute(
      `UPDATE tests SET author = 'agent' WHERE project_id = ? AND file = ? AND (full_name = ? OR name = ? OR full_name LIKE ? ESCAPE '\\')`,
      [projectId, test.file, name, name, pattern],
    );
    marked += Number(result.changes);
  }
  return marked;
}
