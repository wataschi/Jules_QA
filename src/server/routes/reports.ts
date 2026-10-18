/** Маршрути реєстру: зведення циклу для дашборда, тижневий звіт, стан інтеграцій і сповіщення. */
import type { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, type Row } from '../../registry/db.js';
import { requireProject } from '../../registry/projects-store.js';
import { acceptanceByModel, countTasks, staleTasks } from '../../registry/tasks-store.js';
import { casesWithoutTests, directPushes, latestCiRun, testsWithoutCaseCount } from '../../registry/code-tests-store.js';
import { recentNotifications } from '../../registry/notifications-store.js';
import { formatEvent, isTelegramConfigured, TelegramNotifier } from '../../notify/telegram.js';
import { requireRole } from '../auth.js';
import { integrationsConfigured, listHealth, runHealthChecks } from '../health.js';
import { publishWeekly, publishedWeekly, weeklyPreview } from '../weekly.js';
import { fail, requireProjectId } from './common.js';

function count(sql: string, params: unknown[]): number {
  return Number(queryOne<Row>(sql, params)?.n ?? 0);
}

/** Зведення циклу «QA направляє, агент робить» для дашборда. */
export function agenticSummary(projectId: string) {
  const project = requireProject(projectId);
  const main = latestCiRun(projectId, { branch: 'main' });
  const byLevel = Object.fromEntries(
    query<Row>(`SELECT level, COUNT(*) AS n FROM tests WHERE project_id = ? AND state <> 'removed' GROUP BY level`, [projectId]).map(
      (row) => [String(row.level), Number(row.n)],
    ),
  );
  const mutation = main?.sha
    ? queryOne<Row>(`SELECT AVG(mutation_score) AS score FROM code_coverage WHERE project_id = ? AND sha = ? AND mutation_score IS NOT NULL`, [
        projectId,
        main.sha,
      ])
    : undefined;
  const stale = staleTasks(projectId, project.settings.thresholds.staleTaskHours);
  return {
    tasks: {
      byState: countTasks(projectId),
      stale: stale.length,
      oldest: stale.slice(0, 5).map((task) => ({ id: task.id, title: task.title, ageHours: task.ageHours })),
      questions: count(`SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND kind = 'question' AND state NOT IN ('done','rejected')`, [projectId]),
      acceptance: acceptanceByModel(projectId),
    },
    traceability: {
      blocks: count(
        `SELECT COUNT(*) AS n FROM blocks b JOIN sources s ON s.id = b.source_id WHERE s.project_id = ? AND s.kind <> 'figma' AND s.included = 1 AND b.change_state <> 'removed'`,
        [projectId],
      ),
      blocksWithCases: count(
        `SELECT COUNT(DISTINCT b.id) AS n FROM blocks b JOIN sources s ON s.id = b.source_id JOIN coverage c ON c.block_id = b.id
         WHERE s.project_id = ? AND s.kind <> 'figma' AND b.change_state <> 'removed'`,
        [projectId],
      ),
      frames: count(
        `SELECT COUNT(*) AS n FROM blocks b JOIN sources s ON s.id = b.source_id WHERE s.project_id = ? AND s.kind = 'figma' AND b.change_state <> 'removed'`,
        [projectId],
      ),
      framesWithCases: count(
        `SELECT COUNT(DISTINCT b.id) AS n FROM blocks b JOIN sources s ON s.id = b.source_id JOIN coverage c ON c.block_id = b.id
         WHERE s.project_id = ? AND s.kind = 'figma' AND b.change_state <> 'removed'`,
        [projectId],
      ),
      approvedCases: count(`SELECT COUNT(*) AS n FROM cases WHERE project_id = ? AND status = 'approved'`, [projectId]),
      casesWithTests: count(
        `SELECT COUNT(DISTINCT tl.case_id) AS n FROM test_links tl JOIN tests t ON t.id = tl.test_id WHERE t.project_id = ? AND t.state <> 'removed'`,
        [projectId],
      ),
      p1WithoutTests: casesWithoutTests(projectId, { priorities: ['P1'] }).length,
      readingsPending: count(`SELECT COUNT(*) AS n FROM assets WHERE project_id = ? AND reading_state IN ('needed','proposed')`, [projectId]),
    },
    tests: {
      total: Object.values(byLevel).reduce((sum, value) => sum + Number(value), 0),
      byLevel,
      withoutCase: testsWithoutCaseCount(projectId),
      byAgent: count(`SELECT COUNT(*) AS n FROM tests WHERE project_id = ? AND author = 'agent' AND state <> 'removed'`, [projectId]),
      quarantined: count(`SELECT COUNT(*) AS n FROM tests WHERE project_id = ? AND state = 'quarantined'`, [projectId]),
    },
    main: main
      ? {
          ...main,
          failed: count(`SELECT COUNT(*) AS n FROM test_results WHERE run_id = ? AND status = 'failed'`, [main.id]),
          total: count(`SELECT COUNT(*) AS n FROM test_results WHERE run_id = ?`, [main.id]),
          mutationScore: mutation?.score === null || mutation?.score === undefined ? null : Math.round(Number(mutation.score)),
        }
      : null,
    directPushes: directPushes(projectId).length,
    health: listHealth(),
  };
}

export function registerReportsRoutes(router: Router): void {
  router.get('/dashboard/agentic', (req, res) => {
    try {
      res.json(agenticSummary(requireProjectId(req)));
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/reports/weekly', (req, res) => {
    try {
      const projectId = requireProjectId(req);
      const week = typeof req.query.week === 'string' && /^\d{4}-W\d{2}$/.test(req.query.week) ? req.query.week : undefined;
      const preview = weeklyPreview(projectId, week);
      res.json({ ...preview, published: publishedWeekly(projectId, preview.week) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/reports/weekly', async (req, res) => {
    try {
      requireRole(req, 'qa');
      const body = z
        .object({ projectId: z.string().min(1), week: z.string().regex(/^\d{4}-W\d{2}$/).optional(), insights: z.string().max(10_000).optional() })
        .parse(req.body);
      res.json(await publishWeekly(body.projectId, body));
    } catch (error) {
      fail(res, error, 502);
    }
  });

  router.get('/health', (_req, res) => {
    res.json({ configured: integrationsConfigured(), checks: listHealth() });
  });

  router.post('/health/check', async (req, res) => {
    try {
      requireRole(req, 'qa', 'dev');
      res.json({ configured: integrationsConfigured(), checks: await runHealthChecks() });
    } catch (error) {
      fail(res, error, 502);
    }
  });

  router.get('/notifications', (_req, res) => {
    res.json({ configured: isTelegramConfigured(), items: recentNotifications() });
  });

  router.post('/notifications/test', async (req, res) => {
    try {
      requireRole(req, 'admin');
      if (!isTelegramConfigured()) throw new Error('Telegram не налаштовано: потрібні TELEGRAM_BOT_TOKEN і TELEGRAM_CHAT_ID');
      const body = z.object({ chatId: z.string().optional() }).parse(req.body ?? {});
      await new TelegramNotifier({ token: process.env.TELEGRAM_BOT_TOKEN ?? '', chatId: body.chatId || process.env.TELEGRAM_CHAT_ID || '' }).send(
        formatEvent({ kind: 'source_up', source: 'Jules (перевірка зв’язку)', downMinutes: 0 }),
      );
      res.json({ ok: true });
    } catch (error) {
      fail(res, error, 502);
    }
  });
}
