/** Маршрути реєстру: дефекти. */
import type { Router } from 'express';
import { z } from 'zod';
import { defectSeveritySchema, defectStatusSchema } from '../../registry/types.js';
import { requireProject } from '../../registry/projects-store.js';
import { getDefect, listDefects, updateDefect, upsertDefect } from '../../registry/defects-store.js';
import { fail, asInt, requireProjectId } from './common.js';

export function registerDefectsRoutes(router: Router): void {
  router.get('/defects', (req, res) => {
    try {
      res.json(
        listDefects({
          projectId: requireProjectId(req),
          status: typeof req.query.status === 'string' ? defectStatusSchema.parse(req.query.status) : undefined,
          caseId: typeof req.query.caseId === 'string' ? req.query.caseId : undefined,
          page: asInt(req.query.page, 1),
          limit: asInt(req.query.limit, 50),
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/defects', (req, res) => {
    try {
      const body = z
        .object({
          projectId: z.string().min(1),
          title: z.string().min(1),
          details: z.string().optional(),
          severity: defectSeveritySchema.optional(),
          status: defectStatusSchema.optional(),
          caseId: z.string().optional(),
          runItemId: z.string().optional(),
        })
        .parse(req.body);
      requireProject(body.projectId);
      res.status(201).json(upsertDefect(body));
    } catch (error) {
      fail(res, error);
    }
  });

  router.patch('/defects/:id', (req, res) => {
    try {
      if (!getDefect(req.params.id)) {
        res.status(404).json({ error: `Дефект «${req.params.id}» не знайдено` });
        return;
      }
      const body = z
        .object({
          title: z.string().min(1).optional(),
          details: z.string().optional(),
          severity: defectSeveritySchema.optional(),
          status: defectStatusSchema.optional(),
          externalKey: z.string().optional(),
          externalUrl: z.string().optional(),
        })
        .parse(req.body);
      res.json(updateDefect(req.params.id, body));
    } catch (error) {
      fail(res, error);
    }
  });
}
