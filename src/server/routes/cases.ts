/** Маршрути реєстру: кейси. */
import type { Router } from 'express';
import { z } from 'zod';
import { caseInputSchema, bulkRequestSchema, automationStatusSchema } from '../../registry/types.js';
import { requireProject } from '../../registry/projects-store.js';
import { caseHistory, createCase, deleteCase, getCase, getCaseDetail, listCases, setAutomation, updateCase, type CasePatch } from '../../registry/cases-store.js';
import { runBulk, undoBulk } from '../../registry/bulk.js';
import { requestAuthor } from '../auth.js';
import { fail, asBool, asInt, requireProjectId, filterFromQuery } from './common.js';

export function registerCasesRoutes(router: Router): void {
  router.get('/cases', (req, res) => {
    try {
      const projectId = requireProjectId(req);
      requireProject(projectId);
      res.json(
        listCases({
          projectId,
          filter: filterFromQuery(req),
          sort: typeof req.query.sort === 'string' ? req.query.sort : undefined,
          page: asInt(req.query.page, 1),
          limit: asInt(req.query.limit, 50),
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/cases/bulk', (req, res) => {
    try {
      const body = bulkRequestSchema.parse({ ...req.body, author: req.body?.author ?? requestAuthor(req) });
      res.json(runBulk(body));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/cases/bulk/undo', (req, res) => {
    try {
      const body = z.object({ batchId: z.string().min(1) }).parse(req.body);
      res.json(undoBulk(body.batchId));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/cases', (req, res) => {
    try {
      const body = z.object({ projectId: z.string().min(1) }).passthrough().parse(req.body);
      const input = caseInputSchema.parse(body);
      res.status(201).json(
        createCase(body.projectId, input, {
          author: requestAuthor(req),
          reason: typeof req.body?.reason === 'string' ? req.body.reason : undefined,
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/cases/:id', (req, res) => {
    const detail = getCaseDetail(req.params.id);
    if (!detail) {
      res.status(404).json({ error: `Кейс «${req.params.id}» не знайдено` });
      return;
    }
    res.json(detail);
  });

  router.patch('/cases/:id', (req, res) => {
    try {
      const patch = caseInputSchema.partial().parse(req.body) as CasePatch;
      const updated = updateCase(req.params.id, patch, {
        author: requestAuthor(req),
        reason: typeof req.body?.reason === 'string' ? req.body.reason : undefined,
      });
      res.json(updated);
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete('/cases/:id', (req, res) => {
    try {
      deleteCase(req.params.id, { hard: asBool(req.query.hard, false) }, { author: requestAuthor(req) });
      res.json({ deleted: true, hard: asBool(req.query.hard, false) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/cases/:id/history', (req, res) => {
    if (!getCase(req.params.id)) {
      res.status(404).json({ error: `Кейс «${req.params.id}» не знайдено` });
      return;
    }
    res.json(caseHistory(req.params.id));
  });

  router.post('/cases/:id/automation', (req, res) => {
    try {
      const body = z
        .object({
          status: automationStatusSchema,
          scenarioPath: z.string().optional(),
          quarantineReason: z.string().optional(),
        })
        .parse(req.body);
      res.json(setAutomation(req.params.id, body, { author: requestAuthor(req) }));
    } catch (error) {
      fail(res, error);
    }
  });
}
