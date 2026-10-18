/**
 * Дані для `QA_STATUS.md`, коментаря в PR і тижневого звіту — з бази в
 * структури чистих рендерерів `src/reporting/*`. Рендерери детерміновані,
 * тож однакова база дає однаковий файл, і бот не комітить зайвого.
 */
import { query, queryOne, type Row } from '../registry/db.js';
import { requireProject } from '../registry/projects-store.js';
import { descendantIds, listSections } from '../registry/sections-store.js';
import {
  casesWithoutTests,
  coverageForSha,
  directPushes,
  getPullRequest,
  latestCiRun,
  runTestResults,
  testsWithoutCaseCount,
} from '../registry/code-tests-store.js';
import { matchGlob } from '../ingest/index.js';
import type { PrCommentData } from '../reporting/pr-comment.js';
import type { StatusData, StatusModuleRow } from '../reporting/status-md.js';
import type { WeeklyReportData } from '../reporting/weekly-report.js';
import { weekRange } from '../reporting/weekly-report.js';

export function dashboardUrl(projectId: string): string | undefined {
  const project = requireProject(projectId);
  if (project.settings.dashboardUrl) return project.settings.dashboardUrl;
  const base = process.env.JULES_PUBLIC_URL?.replace(/\/+$/, '');
  return base ? `${base}/?project=${encodeURIComponent(projectId)}` : undefined;
}

const ACTIVE_TASK_STATES = "('queued','claimed','needs_info','review','failed')";

/** Статус кейса в прогоні (сирий: `healed` теж пройшов). */
function caseResults(runId: string | undefined): Map<string, string> {
  if (!runId) return new Map();
  return new Map(query<Row>('SELECT case_id, status FROM run_items WHERE run_id = ?', [runId]).map((row) => [String(row.case_id), String(row.status)]));
}

export function buildStatusData(projectId: string, branch = 'main'): StatusData {
  const project = requireProject(projectId);
  const run = latestCiRun(projectId, { branch });
  const results = caseResults(run?.id);
  const coverage = run?.sha ? coverageForSha(projectId, run.sha) : [];
  const sections = listSections(projectId);

  const modules: StatusModuleRow[] = sections
    .filter((section) => !section.parentId)
    .map((section) => {
      const ids = [section.id, ...descendantIds(section.id)];
      const marks = ids.map(() => '?').join(', ');
      const cases = query<Row>(
        `SELECT c.id,
           EXISTS (SELECT 1 FROM test_links tl JOIN tests t ON t.id = tl.test_id WHERE tl.case_id = c.id AND t.state <> 'removed') AS has_test
         FROM cases c WHERE c.section_id IN (${marks}) AND c.status <> 'deprecated'`,
        ids,
      );
      const paths = sections.filter((item) => ids.includes(item.id)).flatMap((item) => item.paths);
      const files = coverage.filter((file) => file.mutationScore !== undefined && file.mutationScore !== null && paths.some((pattern) => matchGlob(pattern, file.path)));
      const mutationScore = files.length
        ? Math.round(files.reduce((sum, file) => sum + Number(file.mutationScore), 0) / files.length)
        : null;
      const openTasks = Number(
        queryOne<Row>(`SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND section_id IN (${marks}) AND state IN ${ACTIVE_TASK_STATES}`, [projectId, ...ids])?.n ?? 0,
      );
      return {
        name: section.name,
        cases: cases.length,
        withTests: cases.filter((row) => Number(row.has_test) === 1).length,
        passed: cases.filter((row) => ['passed', 'healed'].includes(results.get(String(row.id)) ?? '')).length,
        failed: cases.filter((row) => results.get(String(row.id)) === 'failed').length,
        mutationScore,
        openTasks,
      };
    })
    .filter((row) => row.cases > 0 || row.openTasks > 0);

  const failed = run
    ? runTestResults(run.id)
        .filter((result) => result.status === 'failed')
        .map((result) => {
          const defect = result.caseIds.length
            ? queryOne<Row>(`SELECT id FROM defects WHERE case_id = ? AND status IN ('open','triaged') ORDER BY last_seen_at DESC LIMIT 1`, [result.caseIds[0]])
            : undefined;
          return { caseIds: result.caseIds, title: result.name, file: result.file, defectId: (defect?.id as string | undefined) ?? undefined };
        })
    : [];

  const now = Date.now();
  const contradictions = query<Row>(
    `SELECT t.title, t.queued_at, s.name AS section FROM tasks t LEFT JOIN sections s ON s.id = t.section_id
     WHERE t.project_id = ? AND t.kind = 'question' AND t.state IN ${ACTIVE_TASK_STATES} ORDER BY t.queued_at`,
    [projectId],
  ).map((row) => ({
    module: (row.section as string | null) ?? 'Без модуля',
    text: String(row.title),
    openDays: Math.floor((now - Date.parse(String(row.queued_at))) / 86_400_000),
  }));

  return {
    projectName: project.name,
    branch,
    sha: run?.sha ?? '0000000',
    modules,
    failed,
    p1WithoutTests: casesWithoutTests(projectId, { priorities: ['P1'] }).map(({ caseId, title }) => ({ caseId, title })),
    contradictions,
    testsWithoutCase: testsWithoutCaseCount(projectId),
    directPushes: directPushes(projectId).map((push) => ({ sha: push.sha, author: push.author })),
    dashboardUrl: dashboardUrl(projectId),
  };
}

export function buildPrCommentData(projectId: string, prNumber: number, sha?: string): PrCommentData {
  const project = requireProject(projectId);
  const run = latestCiRun(projectId, { prNumber, sha });
  const results = run ? runTestResults(run.id) : [];
  const runCases = caseResults(run?.id);

  const caseIds = [...new Set(results.flatMap((result) => result.caseIds))].sort();
  const titles = new Map(
    caseIds.length
      ? query<Row>(`SELECT id, title FROM cases WHERE id IN (${caseIds.map(() => '?').join(', ')})`, caseIds).map((row) => [String(row.id), String(row.title)])
      : [],
  );
  const toStatus = (raw: string | undefined): 'passed' | 'failed' | 'skipped' | 'untested' =>
    raw === 'healed' || raw === 'passed' ? 'passed' : raw === 'failed' ? 'failed' : raw === 'skipped' ? 'skipped' : 'untested';

  const coverage = run?.sha ? coverageForSha(projectId, run.sha) : [];
  const linesFound = coverage.reduce((sum, file) => sum + (file.linesFound ?? 0), 0);
  const linesHit = coverage.reduce((sum, file) => sum + (file.linesHit ?? 0), 0);

  return {
    projectName: project.name,
    prNumber,
    sha: run?.sha ?? sha ?? '0000000',
    touchedCases: caseIds.map((caseId) => ({ caseId, title: titles.get(caseId) ?? caseId, status: toStatus(runCases.get(caseId)) })),
    newTests: results.filter((result) => result.isNew).map((result) => ({ file: result.file, name: result.name, caseIds: result.caseIds })),
    failed: results
      .filter((result) => result.status === 'failed')
      .map((result) => ({ file: result.file, name: result.name, caseIds: result.caseIds, error: result.error })),
    testsWithoutCase: results.filter((result) => result.isNew && result.caseIds.length === 0).map((result) => ({ file: result.file, name: result.name })),
    assertionChanges: getPullRequest(projectId, prNumber)?.assertionChanges ?? [],
    coverage: linesFound > 0 ? { linesFound, linesHit } : null,
    dashboardUrl: dashboardUrl(projectId),
  };
}

/** Успішність кейсів у прогонах CI на main за період, %. */
function mainPassRate(projectId: string, from: string, to: string): { count: number; passRate: number | null } {
  const row = queryOne<Row>(
    `SELECT COUNT(DISTINCT r.id) AS runs,
       SUM(CASE WHEN i.status IN ('passed','healed') THEN 1 ELSE 0 END) AS passed,
       SUM(CASE WHEN i.status IN ('passed','healed','failed') THEN 1 ELSE 0 END) AS total
     FROM registry_runs r LEFT JOIN run_items i ON i.run_id = r.id
     WHERE r.project_id = ? AND r.kind = 'ci' AND r.event = 'main' AND r.started_at BETWEEN ? AND ?`,
    [projectId, from, to],
  );
  const total = Number(row?.total ?? 0);
  return { count: Number(row?.runs ?? 0), passRate: total > 0 ? Math.round((Number(row?.passed ?? 0) / total) * 100) : null };
}

function casesWithTestsAt(projectId: string, at: string): number {
  return Number(
    queryOne<Row>(
      `SELECT COUNT(DISTINCT tl.case_id) AS n FROM test_links tl JOIN tests t ON t.id = tl.test_id
       WHERE t.project_id = ? AND t.first_seen_at <= ? AND t.state <> 'removed'`,
      [projectId, at],
    )?.n ?? 0,
  );
}

export function buildWeeklyData(projectId: string, weekLabel: string, insights?: string): WeeklyReportData {
  const project = requireProject(projectId);
  const { from, to } = weekRange(weekLabel);
  const prevFrom = new Date(Date.parse(from) - 7 * 86_400_000).toISOString();
  const now = mainPassRate(projectId, from, to);
  const prev = mainPassRate(projectId, prevFrom, from);
  const nowMs = Date.parse(to);

  return {
    projectName: project.name,
    projectKey: project.key,
    weekLabel,
    period: { from, to },
    runsOnMain: { count: now.count, passRate: now.passRate, prevPassRate: prev.passRate },
    defects: {
      opened: query<Row>(`SELECT id, title, severity FROM defects WHERE project_id = ? AND first_seen_at BETWEEN ? AND ? ORDER BY first_seen_at`, [
        projectId,
        from,
        to,
      ]).map((row) => ({ id: String(row.id), title: String(row.title), severity: String(row.severity) })),
      closed: query<Row>(`SELECT id, title FROM defects WHERE project_id = ? AND status = 'fixed' AND last_seen_at BETWEEN ? AND ?`, [
        projectId,
        from,
        to,
      ]).map((row) => ({ id: String(row.id), title: String(row.title) })),
    },
    coverage: {
      totalCases: Number(queryOne<Row>(`SELECT COUNT(*) AS n FROM cases WHERE project_id = ? AND status <> 'deprecated'`, [projectId])?.n ?? 0),
      casesWithTests: casesWithTestsAt(projectId, to),
      casesWithTestsPrev: casesWithTestsAt(projectId, from),
      p1WithoutTests: casesWithoutTests(projectId, { priorities: ['P1'] }).length,
    },
    tasks: {
      created: Number(queryOne<Row>(`SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND created_at BETWEEN ? AND ?`, [projectId, from, to])?.n ?? 0),
      done: Number(queryOne<Row>(`SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND done_at BETWEEN ? AND ? AND state = 'done'`, [projectId, from, to])?.n ?? 0),
      open: Number(queryOne<Row>(`SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND state IN ${ACTIVE_TASK_STATES}`, [projectId])?.n ?? 0),
      oldest: query<Row>(
        `SELECT id, title, queued_at FROM tasks WHERE project_id = ? AND state = 'queued' ORDER BY queued_at LIMIT 5`,
        [projectId],
      ).map((row) => ({ id: String(row.id), title: String(row.title), ageDays: Math.max(0, Math.floor((nowMs - Date.parse(String(row.queued_at))) / 86_400_000)) })),
    },
    flaky: {
      count: Number(
        queryOne<Row>(`SELECT COUNT(*) AS n FROM cases WHERE project_id = ? AND json_extract(automation, '$.flakeScore') >= ?`, [
          projectId,
          project.settings.thresholds.flakeScore,
        ])?.n ?? 0,
      ),
      quarantined: Number(queryOne<Row>(`SELECT COUNT(*) AS n FROM tests WHERE project_id = ? AND state = 'quarantined'`, [projectId])?.n ?? 0),
      top: query<Row>(
        `SELECT id, title, json_extract(automation, '$.flakeScore') AS score FROM cases
         WHERE project_id = ? AND json_extract(automation, '$.flakeScore') > 0 ORDER BY score DESC LIMIT 5`,
        [projectId],
      ).map((row) => ({ caseId: String(row.id), title: String(row.title), flakeScore: Number(row.score) })),
    },
    changes: {
      requirements: Number(
        queryOne<Row>(
          `SELECT COUNT(*) AS n FROM blocks b JOIN sources s ON s.id = b.source_id
           WHERE s.project_id = ? AND s.kind <> 'figma' AND b.change_state IN ('changed','new') AND s.updated_at BETWEEN ? AND ?`,
          [projectId, from, to],
        )?.n ?? 0,
      ),
      designs: Number(
        queryOne<Row>(
          `SELECT COUNT(*) AS n FROM blocks b JOIN sources s ON s.id = b.source_id
           WHERE s.project_id = ? AND s.kind = 'figma' AND b.change_state IN ('changed','new') AND s.updated_at BETWEEN ? AND ?`,
          [projectId, from, to],
        )?.n ?? 0,
      ),
    },
    insights,
    dashboardUrl: dashboardUrl(projectId),
  };
}
