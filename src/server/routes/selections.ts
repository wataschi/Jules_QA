/** Маршрути реєстру: вибірки. */
import type { Router } from 'express';
import { z } from 'zod';
import { caseFilterSchema, selectionInputSchema } from '../../registry/types.js';
import { createSelection, deleteSelection, getSelection, listSelections, resolveSelection, updateSelection } from '../../registry/selections-store.js';
import { fail, requireProjectId } from './common.js';

export function registerSelectionsRoutes(router: Router): void {
  router.get('/selections', (req, res) => {
    try {
      res.json(listSelections(requireProjectId(req)));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/selections', (req, res) => {
    try {
      const body = selectionInputSchema.parse(req.body);
      res.status(201).json(createSelection(body));
    } catch (error) {
      fail(res, error);
    }
  });

  router.patch('/selections/:id', (req, res) => {
    try {
      const body = z
        .object({
          name: z.string().min(1).optional(),
          description: z.string().optional(),
          mode: z.enum(['static', 'filter']).optional(),
          caseIds: z.array(z.string()).optional(),
          filter: caseFilterSchema.nullable().optional(),
          stopOnFailure: z.boolean().optional(),
        })
        .parse(req.body);
      res.json(updateSelection(req.params.id, body));
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete('/selections/:id', (req, res) => {
    try {
      deleteSelection(req.params.id);
      res.json({ deleted: true });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/selections/:id/resolve', (req, res) => {
    try {
      if (!getSelection(req.params.id)) {
        res.status(404).json({ error: `Вибірку «${req.params.id}» не знайдено` });
        return;
      }
      res.json(resolveSelection(req.params.id));
    } catch (error) {
      fail(res, error);
    }
  });
}
