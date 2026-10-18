/** Маршрути реєстру: задачі для агентів і питання до людей. */
import type { Request, Router } from 'express';
import { z } from 'zod';
import {
  answerTask,
  askQuestion,
  claimTask,
  commentTask,
  confirmTask,
  createTask,
  failTask,
  heartbeatTask,
  inbox,
  listEvents,
  listJobs,
  listTasks,
  rejectTask,
  retryTask,
  releaseTask,
  reportTask,
  requestChanges,
  requireTask,
  type ActorKind,
} from '../../registry/tasks-store.js';
import { taskInputSchema, taskKindSchema, taskReportSchema, taskStateSchema } from '../../registry/types.js';
import { requestAuthor, requireRole } from '../auth.js';
import { taskContext } from '../task-context.js';
import { applyTriage } from '../workflow.js';
import { asArray, asInt, fail, requireProjectId } from './common.js';

/** Хто діє: QA, розробник чи адмін (адмін у UI — це завжди погодження QA). */
export function actorKind(req: Request): ActorKind {
  const role = req.principal?.role ?? 'admin';
  return role === 'dev' ? 'dev' : role === 'ci' ? 'system' : 'qa';
}

const textBody = z.object({ text: z.string().min(1).max(20_000) });

export function registerTasksRoutes(router: Router): void {
  router.get('/tasks', (req, res) => {
    try {
      const login = requestAuthor(req);
      res.json(
        listTasks({
          projectId: requireProjectId(req),
          states: asArray(req.query.state).map((state) => taskStateSchema.parse(state)),
          kinds: asArray(req.query.kind).map((kind) => taskKindSchema.parse(kind)),
          sectionId: typeof req.query.sectionId === 'string' ? req.query.sectionId : undefined,
          owner: req.query.mine === '1' ? login : typeof req.query.owner === 'string' ? req.query.owner : undefined,
          q: typeof req.query.q === 'string' && req.query.q ? req.query.q : undefined,
          page: asInt(req.query.page, 1),
          limit: asInt(req.query.limit, 50),
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/tasks', (req, res) => {
    try {
      requireRole(req, 'qa', 'dev');
      const body = taskInputSchema.parse(req.body);
      const { task } = createTask({ ...body, author: requestAuthor(req), authorKind: actorKind(req) });
      res.status(201).json(task);
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/inbox', (req, res) => {
    try {
      const projectId = requireProjectId(req);
      const result = inbox(projectId, { login: requestAuthor(req), paths: asArray(req.query.paths), limit: asInt(req.query.limit, 20) });
      res.json({
        total: result.total,
        tasks: result.tasks.map((task) => ({
          id: task.id,
          kind: task.kind,
          title: task.title,
          state: task.state,
          module: task.sectionName,
          ageHours: task.ageHours,
          mine: task.mine,
          touched: task.touched,
          priority: task.priority,
        })),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/tasks/:id', (req, res) => {
    try {
      const task = requireTask(req.params.id);
      res.json({ task, events: listEvents(task.id), jobs: listJobs(task.id), context: taskContext(task, { forAgent: false }) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/tasks/:id/claim', (req, res) => {
    try {
      const body = z.object({ agent: z.string().max(100).optional(), model: z.string().max(100).optional() }).parse(req.body ?? {});
      res.json(claimTask(req.params.id, requestAuthor(req), body));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/tasks/:id/heartbeat', (req, res) => {
    try {
      res.json(heartbeatTask(req.params.id, requestAuthor(req)));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/tasks/:id/release', (req, res) => {
    try {
      const body = z.object({ reason: z.string().max(2000).optional() }).parse(req.body ?? {});
      res.json(releaseTask(req.params.id, requestAuthor(req), body.reason));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/tasks/:id/ask', (req, res) => {
    try {
      res.json(askQuestion(req.params.id, requestAuthor(req), textBody.parse(req.body).text));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/tasks/:id/answer', (req, res) => {
    try {
      res.json(answerTask(req.params.id, requestAuthor(req), actorKind(req), textBody.parse(req.body).text));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/tasks/:id/comment', (req, res) => {
    try {
      res.status(201).json(commentTask(req.params.id, requestAuthor(req), actorKind(req), textBody.parse(req.body).text));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/tasks/:id/report', (req, res) => {
    try {
      res.json(reportTask(req.params.id, requestAuthor(req), taskReportSchema.parse(req.body)));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/tasks/:id/fail', (req, res) => {
    try {
      const body = z.object({ reason: z.string().min(1).max(5000) }).parse(req.body);
      res.json(failTask(req.params.id, requestAuthor(req), body.reason));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/tasks/:id/confirm', (req, res) => {
    try {
      requireRole(req, 'qa');
      const reviewer = requestAuthor(req);
      const task = confirmTask(req.params.id, reviewer);
      // Розбір падіння набирає сили лише після підтвердження QA: дефект, карантин, задача на тест.
      const effects = task.kind === 'triage' && task.report?.triage ? applyTriage(task, { ...task.report.triage, note: task.report.summary }, reviewer) : undefined;
      res.json(effects ? { ...task, effects } : task);
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/tasks/:id/request-changes', (req, res) => {
    try {
      requireRole(req, 'qa');
      res.json(requestChanges(req.params.id, requestAuthor(req), textBody.parse(req.body).text));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/tasks/:id/retry', (req, res) => {
    try {
      requireRole(req, 'qa');
      const body = z.object({ note: z.string().max(5000).optional() }).parse(req.body ?? {});
      res.json(retryTask(req.params.id, requestAuthor(req), actorKind(req), body.note));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/tasks/:id/reject', (req, res) => {
    try {
      requireRole(req, 'qa');
      const body = z.object({ note: z.string().max(5000).optional() }).parse(req.body ?? {});
      res.json(rejectTask(req.params.id, requestAuthor(req), actorKind(req), body.note));
    } catch (error) {
      fail(res, error);
    }
  });
}
