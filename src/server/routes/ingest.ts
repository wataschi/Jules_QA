/** Маршрути реєстру: результати CI репо продукту, статус для репо й PR, тести в коді. */
import type { Request, Router } from 'express';
import { z } from 'zod';
import { requireProject, updateProject } from '../../registry/projects-store.js';
import {
  acknowledgePush,
  directPushes,
  getTest,
  ingestRun,
  listTests,
  markAgentTests,
  recordPushCheck,
  setTestState,
  upsertPullRequest,
} from '../../registry/code-tests-store.js';
import { applyPrEvent } from '../../registry/tasks-store.js';
import { createCase } from '../../registry/cases-store.js';
import { createProposal } from '../../registry/proposals-store.js';
import { getSection, getSectionByCode } from '../../registry/sections-store.js';
import { query, fromJson, type Row } from '../../registry/db.js';
import { casePrioritySchema, caseKindSchema, testLevelSchema, type TaskReport } from '../../registry/types.js';
import { enqueueNotification } from '../../registry/notifications-store.js';
import { renderStatusMarkdown } from '../../reporting/status-md.js';
import { renderPrComment } from '../../reporting/pr-comment.js';
import { HttpError, requestAuthor, requireRole } from '../auth.js';
import { afterIngest } from '../workflow.js';
import { buildPrCommentData, buildStatusData } from '../status-data.js';
import { asBool, asInt, fail } from './common.js';

/** Проєкт запиту: токен CI прив'язаний до свого проєкту, і чужий указати не можна. */
function projectFor(req: Request, explicit?: unknown): string {
  const fromToken = req.principal?.role === 'ci' ? req.principal.projectId : undefined;
  const asked = typeof explicit === 'string' && explicit ? explicit : undefined;
  if (fromToken && asked && asked !== fromToken) throw new HttpError(403, 'Токен CI прив’язаний до іншого проєкту');
  const projectId = fromToken ?? asked;
  if (!projectId) throw new Error('Параметр projectId обовʼязковий');
  requireProject(projectId);
  return projectId;
}

const resultSchema = z.object({
  key: z.string().min(1),
  file: z.string().min(1),
  name: z.string(),
  fullName: z.string(),
  status: z.enum(['passed', 'failed', 'skipped']),
  durationMs: z.number().nonnegative().optional(),
  error: z.string().max(20_000).optional(),
  retries: z.number().int().nonnegative().optional(),
  framework: z.enum(['junit', 'playwright', 'vitest', 'jest', 'pytest', 'unknown']).default('unknown'),
  caseIds: z.array(z.string()).default([]),
  level: testLevelSchema.default('unit'),
});

const ingestRunSchema = z.object({
  projectId: z.string().optional(),
  repo: z.string().optional(),
  sha: z.string().min(7).max(64),
  branch: z.string().min(1),
  prNumber: z.number().int().positive().optional(),
  event: z.enum(['pr', 'main', 'local']),
  source: z.enum(['ci', 'local']).default('ci'),
  runUrl: z.string().url().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  manifest: z.object({ version: z.literal(1), tests: z.array(z.record(z.string(), z.unknown())) }).passthrough().optional(),
  results: z.array(resultSchema).max(50_000),
  coverage: z
    .array(z.object({ path: z.string(), linesFound: z.number(), linesHit: z.number(), branchesFound: z.number().optional(), branchesHit: z.number().optional() }))
    .optional(),
  mutation: z
    .array(
      z.object({
        path: z.string(),
        killed: z.number(),
        survived: z.number(),
        noCoverage: z.number(),
        timeout: z.number(),
        total: z.number(),
        score: z.number().nullable(),
      }),
    )
    .optional(),
  assertionChanges: z
    .array(z.object({ file: z.string(), line: z.number(), before: z.string(), after: z.string().optional(), kind: z.enum(['removed', 'modified']) }))
    .optional(),
  codeowners: z.string().max(200_000).optional(),
});

/** Тести, про які агент звітував у задачі цього PR, — авторство агента. */
function markTestsFromReports(projectId: string, prNumber: number): void {
  const rows = query<Row>(`SELECT report FROM tasks WHERE project_id = ? AND pr_number = ? AND report IS NOT NULL`, [projectId, prNumber]);
  const tests = rows.flatMap((row) => fromJson<TaskReport | null>(row.report, null)?.tests ?? []);
  if (tests.length) markAgentTests(projectId, tests);
}

export function registerIngestRoutes(router: Router): void {
  router.post('/ingest/run', (req, res) => {
    try {
      const body = ingestRunSchema.parse(req.body);
      // Прогони PR і main міняють стан кейсів і задач — їх шле лише CI. Розробнику лишається local.
      if (body.event !== 'local') requireRole(req, 'ci');
      const projectId = projectFor(req, body.projectId);
      const project = requireProject(projectId);
      if (body.repo && !project.repo) updateProject(projectId, { repo: body.repo });
      if (body.codeowners !== undefined && body.event === 'main' && body.codeowners !== project.settings.codeowners) {
        updateProject(projectId, { settings: { ...project.settings, codeowners: body.codeowners } });
      }
      const outcome = ingestRun({
        ...body,
        projectId,
        manifest: body.manifest as never,
        author: requestAuthor(req),
      });
      if (body.prNumber) markTestsFromReports(projectId, body.prNumber);
      const tasks = afterIngest(projectId, body.event, body.sha, outcome, body.runUrl);
      res.status(201).json({ runId: outcome.runId, tests: outcome.tests, failed: outcome.failed, unknownCases: outcome.unknownCases, tasks });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/ingest/pr-event', (req, res) => {
    try {
      requireRole(req, 'ci');
      const body = z
        .object({
          projectId: z.string().optional(),
          prNumber: z.number().int().positive(),
          state: z.enum(['opened', 'merged', 'closed']),
          sha: z.string().optional(),
          headBranch: z.string().optional(),
          title: z.string().max(500).optional(),
          url: z.string().optional(),
        })
        .parse(req.body);
      const projectId = projectFor(req, body.projectId);
      upsertPullRequest(projectId, body.prNumber, body);
      const tasksUpdated = applyPrEvent(projectId, body.prNumber, body.state);
      res.json({ ok: true, tasksUpdated });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/ingest/push-check', (req, res) => {
    try {
      requireRole(req, 'ci');
      const body = z
        .object({
          projectId: z.string().optional(),
          sha: z.string().min(7),
          branch: z.string().min(1),
          viaPr: z.boolean(),
          prNumbers: z.array(z.number().int().positive()).default([]),
          author: z.string().max(200).optional(),
        })
        .parse(req.body);
      const projectId = projectFor(req, body.projectId);
      const flagged = recordPushCheck(projectId, body);
      if (flagged) {
        enqueueNotification({ kind: 'direct_push', project: requireProject(projectId).name, sha: body.sha, author: body.author }, projectId);
      }
      res.json({ ok: true, flagged });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/status.md', (req, res) => {
    try {
      const projectId = projectFor(req, req.query.projectId);
      const branch = typeof req.query.branch === 'string' && req.query.branch ? req.query.branch : 'main';
      res.type('text/markdown; charset=utf-8').send(renderStatusMarkdown(buildStatusData(projectId, branch)));
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/status', (req, res) => {
    try {
      const projectId = projectFor(req, req.query.projectId);
      res.json(buildStatusData(projectId, typeof req.query.branch === 'string' && req.query.branch ? req.query.branch : 'main'));
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/pr-comment.md', (req, res) => {
    try {
      const projectId = projectFor(req, req.query.projectId);
      const prNumber = asInt(req.query.prNumber, 0);
      if (prNumber <= 0) throw new Error('Параметр prNumber обовʼязковий');
      const sha = typeof req.query.sha === 'string' && req.query.sha ? req.query.sha : undefined;
      res.type('text/markdown; charset=utf-8').send(renderPrComment(buildPrCommentData(projectId, prNumber, sha)));
    } catch (error) {
      fail(res, error);
    }
  });

  /**
   * Резервування ID для тесту, який агент додав без задачі: кейс одразу
   * існує чернеткою (ID стабільний), а його затвердження чекає QA.
   */
  router.post('/cases/reserve', (req, res) => {
    try {
      const body = z
        .object({
          projectId: z.string().optional(),
          section: z.string().min(1),
          title: z.string().min(1).max(300),
          kind: caseKindSchema.optional(),
          priority: casePrioritySchema.optional(),
          checks: z.array(z.string().min(1)).max(50).optional(),
          preconditions: z.string().max(5000).optional(),
        })
        .parse(req.body);
      const projectId = projectFor(req, body.projectId);
      const section = getSectionByCode(projectId, body.section.toUpperCase()) ?? getSection(body.section);
      if (!section || section.projectId !== projectId) throw new Error(`Модуль «${body.section}» не знайдено`);
      const author = requestAuthor(req);
      const created = createCase(
        projectId,
        {
          sectionId: section.id,
          title: body.title,
          kind: body.kind,
          priority: body.priority,
          checks: body.checks ?? [],
          preconditions: body.preconditions ?? '',
          status: 'draft',
          automation: { status: 'candidate' },
        } as never,
        { author, reason: 'ID зарезервовано агентом для нового тесту' },
      );
      const proposal = createProposal({
        projectId,
        kind: 'case_update',
        title: `Кейс від агента: ${body.title}`,
        rationale: 'Агент додав тест без задачі й зарезервував для нього кейс. Погодьте, якщо перевірка потрібна.',
        payload: { caseId: created.id, changes: { status: 'approved' } },
        origin: { caseId: created.id, reserved: true },
      });
      res.status(201).json({ caseId: created.id, proposalId: proposal.id });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/tests', (req, res) => {
    try {
      const projectId = projectFor(req, req.query.projectId);
      res.json(
        listTests({
          projectId,
          caseId: typeof req.query.caseId === 'string' ? req.query.caseId : undefined,
          file: typeof req.query.file === 'string' ? req.query.file : undefined,
          level: typeof req.query.level === 'string' ? testLevelSchema.parse(req.query.level) : undefined,
          withoutCase: asBool(req.query.withoutCase, false),
          onMain: asBool(req.query.onMain, false),
          status: typeof req.query.status === 'string' ? z.enum(['passed', 'failed', 'skipped']).parse(req.query.status) : undefined,
          q: typeof req.query.q === 'string' && req.query.q ? req.query.q : undefined,
          page: asInt(req.query.page, 1),
          limit: asInt(req.query.limit, 100),
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/tests/:id', (req, res) => {
    const test = getTest(req.params.id);
    if (!test) {
      res.status(404).json({ error: `Тест «${req.params.id}» не знайдено` });
      return;
    }
    res.json(test);
  });

  router.patch('/tests/:id', (req, res) => {
    try {
      requireRole(req, 'qa');
      const body = z.object({ state: z.enum(['active', 'quarantined']) }).parse(req.body);
      res.json(setTestState(req.params.id, body.state));
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/push-checks', (req, res) => {
    try {
      const projectId = projectFor(req, req.query.projectId);
      res.json(directPushes(projectId, { includeAcknowledged: asBool(req.query.all, false) }));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/push-checks/:id/ack', (req, res) => {
    try {
      requireRole(req, 'qa', 'dev');
      const projectId = projectFor(req, req.body?.projectId);
      acknowledgePush(projectId, req.params.id, requestAuthor(req));
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });
}
