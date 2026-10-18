/** Маршрути реєстру: черга апрувів. */
import type { Router } from 'express';
import { z } from 'zod';
import { proposalKindSchema, proposalStateSchema, skillNameSchema } from '../../registry/types.js';
import { requireProject } from '../../registry/projects-store.js';
import { approveProposals, createProposal, deleteProposal, getProposal, listProposals, patchProposal, rejectProposals } from '../../registry/proposals-store.js';
import { requestAuthor, requireRole } from '../auth.js';
import { afterProposalsApproved, afterProposalsRejected } from '../workflow.js';
import { fail, asInt, requireProjectId, withBlockQuote } from './common.js';

export function registerProposalsRoutes(router: Router): void {
  router.get('/proposals', (req, res) => {
    try {
      const page = listProposals({
        projectId: requireProjectId(req),
        state: typeof req.query.state === 'string' ? proposalStateSchema.parse(req.query.state) : undefined,
        kind: typeof req.query.kind === 'string' ? proposalKindSchema.parse(req.query.kind) : undefined,
        sourceId: typeof req.query.sourceId === 'string' ? req.query.sourceId : undefined,
        blockId: typeof req.query.blockId === 'string' ? req.query.blockId : undefined,
        page: asInt(req.query.page, 1),
        limit: asInt(req.query.limit, 50),
      });
      res.json({ ...page, items: page.items.map(withBlockQuote) });
    } catch (error) {
      fail(res, error);
    }
  });

  /**
   * Розширення контракту: ручне створення пропозиції. Потрібне UI (інженер
   * сам ставить правку в чергу) і тестам; скіли користуються тим самим шляхом.
   */
  router.post('/proposals', (req, res) => {
    try {
      const body = z
        .object({
          projectId: z.string().min(1),
          kind: proposalKindSchema,
          title: z.string().min(1),
          payload: z.unknown(),
          rationale: z.string().optional(),
          diff: z.record(z.string(), z.object({ before: z.unknown(), after: z.unknown() })).optional(),
          origin: z
            .object({
              skill: skillNameSchema.optional(),
              skillRunId: z.string().optional(),
              blockId: z.string().optional(),
              sourceId: z.string().optional(),
              runId: z.string().optional(),
              caseId: z.string().optional(),
            })
            .optional(),
          coverageKind: z.enum(['quote', 'derived']).optional(),
          note: z.string().optional(),
        })
        .parse(req.body);
      requireProject(body.projectId);
      res.status(201).json(createProposal({ ...body, payload: body.payload ?? null }));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/proposals/approve', (req, res) => {
    try {
      requireRole(req, 'qa');
      const body = z
        .object({ ids: z.array(z.string().min(1)).min(1) })
        .parse(req.body);
      // Рецензент — завжди той, хто погоджує: підставити чужий логін не можна.
      const reviewer = requestAuthor(req);
      const result = approveProposals(body.ids, reviewer);
      const tasks = afterProposalsApproved(body.ids, result, reviewer);
      res.json({ ...result, tasks });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/proposals/reject', (req, res) => {
    try {
      requireRole(req, 'qa');
      const body = z
        .object({
          ids: z.array(z.string().min(1)).min(1),
          note: z.string().optional(),
        })
        .parse(req.body);
      const reviewer = requestAuthor(req);
      const result = rejectProposals(body.ids, body.note, reviewer);
      const rejected = result.rejected.map((id) => getProposal(id)).filter((item): item is NonNullable<typeof item> => Boolean(item));
      const tasks = afterProposalsRejected(rejected, reviewer);
      res.json({ ...result, tasks });
    } catch (error) {
      fail(res, error);
    }
  });

  router.patch('/proposals/:id', (req, res) => {
    try {
      requireRole(req, 'qa');
      const body = z
        .object({
          payload: z.unknown().optional(),
          title: z.string().min(1).optional(),
          rationale: z.string().optional(),
          note: z.string().optional(),
          diff: z.record(z.string(), z.object({ before: z.unknown(), after: z.unknown() })).optional(),
          coverageKind: z.enum(['quote', 'derived']).optional(),
        })
        .parse(req.body);
      res.json(patchProposal(req.params.id, body));
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete('/proposals/:id', (req, res) => {
    try {
      requireRole(req, 'qa');
      if (!getProposal(req.params.id)) {
        res.status(404).json({ error: `Пропозицію «${req.params.id}» не знайдено` });
        return;
      }
      deleteProposal(req.params.id);
      res.json({ deleted: true });
    } catch (error) {
      fail(res, error);
    }
  });
}
