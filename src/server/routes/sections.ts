/** Маршрути реєстру: секції. */
import type { Router } from 'express';
import { z } from 'zod';
import { requireProject } from '../../registry/projects-store.js';
import { createSection, deleteSection, sectionTree, updateSection } from '../../registry/sections-store.js';
import { fail, requireProjectId } from './common.js';

export function registerSectionsRoutes(router: Router): void {
  router.get('/sections', (req, res) => {
    try {
      const projectId = requireProjectId(req);
      requireProject(projectId);
      res.json(sectionTree(projectId));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/sections', (req, res) => {
    try {
      const body = z
        .object({
          projectId: z.string().min(1),
          name: z.string().min(1),
          parentId: z.string().nullable().optional(),
          code: z.string().optional(),
          position: z.number().int().nonnegative().optional(),
          testrailSectionId: z.number().int().positive().optional(),
        })
        .parse(req.body);
      res.status(201).json(createSection(body));
    } catch (error) {
      fail(res, error);
    }
  });

  router.patch('/sections/:id', (req, res) => {
    try {
      const body = z
        .object({
          name: z.string().min(1).optional(),
          parentId: z.string().nullable().optional(),
          position: z.number().int().nonnegative().optional(),
          testrailSectionId: z.number().int().positive().optional(),
          paths: z.array(z.string().min(1)).optional(),
          owners: z.array(z.string().min(1)).optional(),
        })
        .parse(req.body);
      res.json(updateSection(req.params.id, body));
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete('/sections/:id', (req, res) => {
    try {
      const moveCasesTo = typeof req.query.moveCasesTo === 'string' ? req.query.moveCasesTo : undefined;
      deleteSection(req.params.id, { moveCasesTo });
      res.json({ deleted: true });
    } catch (error) {
      fail(res, error, 409);
    }
  });
}
