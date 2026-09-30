/**
 * Дашборд реєстру. Усе — SQL-агрегати: у JS лише склеювання результатів
 * у форму `DashboardData` з `types.ts`.
 *
 * `flakeScore` кейса — частка `failed` + `healed` серед останніх 10 результатів.
 * `healed` — сирий статус із бази (self-heal рушія), в API він виглядає як
 * `passed`, але для нестабільності це такий самий сигнал, як падіння.
 */
import { query, queryOne, scalar, type Row } from './db.js';
import { touchAutomationResult } from './cases-store.js';
import { countPendingProposals } from './proposals-store.js';
import { countOpenDefects } from './defects-store.js';
import { requireProject } from './projects-store.js';
import { runSummary } from './runs-store.js';
import type {
  AutomationStatus,
  CasePriority,
  CaseStatus,
  DashboardData,
  ItemStatus,
  RegistryRun,
} from './types.js';

const CASE_STATUSES: CaseStatus[] = ['draft', 'in_review', 'approved', 'deprecated'];
const AUTOMATION_STATUSES: AutomationStatus[] = ['manual', 'candidate', 'automated', 'quarantined'];
const PRIORITIES: CasePriority[] = ['P1', 'P2', 'P3', 'P4'];

function bucket<T extends string>(rows: Row[], keys: readonly T[], keyColumn = 'k'): Record<T, number> {
  const result = Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
  for (const row of rows) {
    const key = String(row[keyColumn] ?? '') as T;
    if (key in result) result[key] = Number(row.n ?? 0);
  }
  return result;
}

export interface FlakeRow {
  caseId: string;
  title: string;
  flakeScore: number;
  results: number;
  lastResult?: ItemStatus;
}

/** `flakeScore` для всіх кейсів проєкту, у яких є хоч один результат. */
export function flakeScores(projectId: string): FlakeRow[] {
  return query<Row>(
    `WITH ranked AS (
       SELECT ri.case_id,
              ri.status,
              ri.updated_at,
              ROW_NUMBER() OVER (PARTITION BY ri.case_id ORDER BY ri.updated_at DESC, ri.id DESC) AS rn
       FROM run_items ri
       JOIN cases c ON c.id = ri.case_id
       WHERE c.project_id = ? AND ri.status <> 'untested'
     ),
     last10 AS (SELECT * FROM ranked WHERE rn <= 10)
     SELECT l.case_id,
            c.title,
            COUNT(*) AS results,
            SUM(CASE WHEN l.status IN ('failed', 'healed') THEN 1 ELSE 0 END) AS bad,
            MAX(CASE WHEN l.rn = 1 THEN l.status END) AS last_status
     FROM last10 l
     JOIN cases c ON c.id = l.case_id
     GROUP BY l.case_id
     ORDER BY (CAST(SUM(CASE WHEN l.status IN ('failed', 'healed') THEN 1 ELSE 0 END) AS REAL) / COUNT(*)) DESC,
              COUNT(*) DESC`,
    [projectId],
  ).map((row) => {
    const results = Number(row.results ?? 0);
    const bad = Number(row.bad ?? 0);
    const raw = String(row.last_status ?? '');
    return {
      caseId: String(row.case_id),
      title: String(row.title ?? ''),
      flakeScore: results > 0 ? Number((bad / results).toFixed(4)) : 0,
      results,
      lastResult: raw ? ((raw === 'healed' ? 'passed' : raw) as ItemStatus) : undefined,
    };
  });
}

/** Записує порахований `flakeScore` у `case.automation` (кеш для списків). */
export function persistFlakeScores(projectId: string): number {
  const rows = flakeScores(projectId);
  for (const row of rows) {
    touchAutomationResult(row.caseId, { flakeScore: row.flakeScore });
  }
  return rows.length;
}

export function dashboard(projectId: string): DashboardData {
  const project = requireProject(projectId);

  const cases = {
    total: Number(scalar<number>('SELECT COUNT(*) FROM cases WHERE project_id = ?', [projectId]) ?? 0),
    byStatus: bucket(
      query<Row>('SELECT status AS k, COUNT(*) AS n FROM cases WHERE project_id = ? GROUP BY status', [
        projectId,
      ]),
      CASE_STATUSES,
    ),
    byAutomation: bucket(
      query<Row>(
        `SELECT json_extract(automation, '$.status') AS k, COUNT(*) AS n
         FROM cases WHERE project_id = ? GROUP BY k`,
        [projectId],
      ),
      AUTOMATION_STATUSES,
    ),
    byPriority: bucket(
      query<Row>('SELECT priority AS k, COUNT(*) AS n FROM cases WHERE project_id = ? GROUP BY priority', [
        projectId,
      ]),
      PRIORITIES,
    ),
  };

  const coverageRow = queryOne<Row>(
    `SELECT
       COUNT(*) AS blocks,
       SUM(CASE WHEN EXISTS (SELECT 1 FROM coverage cv WHERE cv.block_id = b.id) THEN 1 ELSE 0 END) AS covered
     FROM blocks b
     JOIN sources s ON s.id = b.source_id
     WHERE s.project_id = ? AND b.change_state <> 'removed'`,
    [projectId],
  );
  const linkRow = queryOne<Row>(
    `SELECT
       SUM(CASE WHEN cv.kind = 'derived' THEN 1 ELSE 0 END) AS derived,
       COUNT(*) AS total,
       COUNT(DISTINCT cv.case_id) AS cases_with_source
     FROM coverage cv
     JOIN cases c ON c.id = cv.case_id
     WHERE c.project_id = ?`,
    [projectId],
  );

  const blocks = Number(coverageRow?.blocks ?? 0);
  const coveredBlocks = Number(coverageRow?.covered ?? 0);
  const linkTotal = Number(linkRow?.total ?? 0);
  const coverage = {
    blocks,
    coveredBlocks,
    gaps: blocks - coveredBlocks,
    derivedShare: linkTotal > 0 ? Number((Number(linkRow?.derived ?? 0) / linkTotal).toFixed(4)) : 0,
    casesWithSource: Number(linkRow?.cases_with_source ?? 0),
  };

  const runsRow = queryOne<Row>(
    `SELECT
       SUM(CASE WHEN started_at >= ? THEN 1 ELSE 0 END) AS last7d,
       SUM(CASE WHEN started_at >= ? THEN 1 ELSE 0 END) AS last30d,
       SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END) AS open
     FROM registry_runs WHERE project_id = ?`,
    [isoDaysAgo(7), isoDaysAgo(30), projectId],
  );

  const pass7Row = queryOne<Row>(
    `SELECT
       SUM(CASE WHEN ri.status IN ('passed', 'healed') THEN 1 ELSE 0 END) AS passed,
       SUM(CASE WHEN ri.status = 'failed' THEN 1 ELSE 0 END) AS failed
     FROM run_items ri
     JOIN registry_runs r ON r.id = ri.run_id
     WHERE r.project_id = ? AND r.started_at >= ?`,
    [projectId, isoDaysAgo(7)],
  );
  const passed7 = Number(pass7Row?.passed ?? 0);
  const failed7 = Number(pass7Row?.failed ?? 0);

  const recent = query<Row>(
    `SELECT id, title, kind, state, started_at FROM registry_runs
     WHERE project_id = ? ORDER BY started_at DESC LIMIT 6`,
    [projectId],
  ).map((row) => ({
    id: String(row.id),
    title: String(row.title),
    kind: row.kind as RegistryRun['kind'],
    state: row.state as RegistryRun['state'],
    startedAt: String(row.started_at),
    summary: runSummary(String(row.id)),
  }));

  const runs = {
    last7d: Number(runsRow?.last7d ?? 0),
    last30d: Number(runsRow?.last30d ?? 0),
    passRate7d: passed7 + failed7 > 0 ? Number((passed7 / (passed7 + failed7)).toFixed(4)) : null,
    open: Number(runsRow?.open ?? 0),
    recent,
  };

  const flaky = flakeScores(projectId)
    .filter((row) => row.flakeScore > 0)
    .slice(0, 10)
    .map((row) => ({
      caseId: row.caseId,
      title: row.title,
      flakeScore: row.flakeScore,
      lastResult: row.lastResult,
    }));

  const modules = query<Row>(
    `WITH RECURSIVE tree(root, id) AS (
       SELECT id, id FROM sections WHERE project_id = ? AND parent_id IS NULL
       UNION ALL
       SELECT t.root, s.id FROM sections s JOIN tree t ON s.parent_id = t.id
     )
     SELECT t.root AS section_id,
            root_sec.name AS name,
            COUNT(c.id) AS cases,
            SUM(CASE WHEN json_extract(c.automation, '$.status') = 'automated' THEN 1 ELSE 0 END) AS automated,
            -- прогалина трасування: кейс модуля без жодного зв'язку з вимогою
            SUM(CASE WHEN c.id IS NOT NULL
                      AND NOT EXISTS (SELECT 1 FROM coverage cv WHERE cv.case_id = c.id)
                     THEN 1 ELSE 0 END) AS gaps,
            SUM(CASE WHEN res.passed IS NULL THEN 0 ELSE res.passed END) AS passed,
            SUM(CASE WHEN res.failed IS NULL THEN 0 ELSE res.failed END) AS failed
     FROM tree t
     JOIN sections root_sec ON root_sec.id = t.root
     LEFT JOIN cases c ON c.section_id = t.id
     LEFT JOIN (
       SELECT ri.case_id,
              SUM(CASE WHEN ri.status IN ('passed', 'healed') THEN 1 ELSE 0 END) AS passed,
              SUM(CASE WHEN ri.status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM run_items ri GROUP BY ri.case_id
     ) res ON res.case_id = c.id
     GROUP BY t.root, root_sec.name
     ORDER BY root_sec.position, root_sec.name`,
    [projectId],
  ).map((row) => {
    const passed = Number(row.passed ?? 0);
    const failed = Number(row.failed ?? 0);
    return {
      sectionId: String(row.section_id),
      name: String(row.name),
      cases: Number(row.cases ?? 0),
      automated: Number(row.automated ?? 0),
      passRate: passed + failed > 0 ? Number((passed / (passed + failed)).toFixed(4)) : null,
      gaps: Number(row.gaps ?? 0),
    };
  });

  const pending = {
    proposals: countPendingProposals(projectId),
    drift: driftCount(projectId),
    openDefects: countOpenDefects(projectId),
  };

  return { project, cases, coverage, runs, flaky, modules, pending };
}

/**
 * Дрейф із TestRail: кейс синхронізований (є `testrail.caseId`), але змінився
 * після синхронізації. Точне порівняння `syncHash` робить `GET /testrail/drift`.
 */
export function driftCount(projectId: string): number {
  return Number(
    scalar<number>(
      `SELECT COUNT(*) FROM cases
       WHERE project_id = ?
         AND json_extract(testrail, '$.caseId') IS NOT NULL
         AND (json_extract(testrail, '$.syncedAt') IS NULL
              OR updated_at > json_extract(testrail, '$.syncedAt'))`,
      [projectId],
    ) ?? 0,
  );
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}
