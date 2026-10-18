/** Маршрути реєстру: входи проєкту (дерево Confluence, Figma), вкладення й прочитання картинок. */
import fs from 'node:fs';
import type { Router } from 'express';
import { z } from 'zod';
import { requireProject } from '../../registry/projects-store.js';
import { getBlock, listBlocks, requireSource, setBlockRoute, setSourceFlags, sourceTree } from '../../registry/sources-store.js';
import { assetFilePath, decideReading, listAssets, proposeReading, requireAsset } from '../../registry/assets-store.js';
import { completeTask, listTasks, requestChanges } from '../../registry/tasks-store.js';
import { readingStateSchema } from '../../registry/types.js';
import { requestAuthor, requireRole } from '../auth.js';
import { assignModulesFromTree, importFigma, loadConfluenceTree, syncConfluenceSource, syncFigmaSource, syncProjectInputs } from '../inputs.js';
import { requirementViews } from '../task-context.js';
import { asArray, fail, requireProjectId } from './common.js';

/** Задачі прочитання для вкладення — закриваються рішенням QA щодо опису. */
function readTasksFor(projectId: string, assetId: string) {
  return listTasks({ projectId, kinds: ['read_asset'], states: ['queued', 'claimed', 'review', 'needs_info'], limit: 200 }).items.filter(
    (task) => task.anchor.assetId === assetId,
  );
}

export function registerInputsRoutes(router: Router): void {
  router.get('/sources/tree', (req, res) => {
    try {
      res.json(sourceTree(requireProjectId(req)));
    } catch (error) {
      fail(res, error);
    }
  });

  router.patch('/sources/:id', (req, res) => {
    try {
      requireRole(req, 'qa');
      const body = z
        .object({ included: z.boolean().optional(), noAgents: z.boolean().optional(), sectionId: z.string().nullable().optional() })
        .parse(req.body);
      res.json(setSourceFlags(req.params.id, body));
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/sources/:id/view', (req, res) => {
    try {
      const source = requireSource(req.params.id);
      const views = requirementViews(
        listBlocks(source.id)
          .filter((block) => block.changeState !== 'removed')
          .map((block) => block.id),
        { forAgent: false },
      );
      res.json({ source, blocks: views });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/requirements', (req, res) => {
    try {
      res.json(requirementViews(asArray(req.query.blockIds), { forAgent: false }));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/inputs/confluence/tree', async (req, res) => {
    try {
      requireRole(req, 'qa');
      const body = z
        .object({ projectId: z.string().min(1), ref: z.string().min(1), maxPages: z.number().int().positive().max(2000).optional() })
        .parse(req.body);
      res.json(await loadConfluenceTree(body.projectId, body.ref, { maxPages: body.maxPages, author: requestAuthor(req) }));
    } catch (error) {
      fail(res, error, 502);
    }
  });

  router.post('/inputs/confluence/modules', (req, res) => {
    try {
      requireRole(req, 'qa');
      const body = z.object({ projectId: z.string().min(1), rootSourceId: z.string().min(1) }).parse(req.body);
      res.json(assignModulesFromTree(body.projectId, body.rootSourceId, requestAuthor(req)));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/inputs/figma', async (req, res) => {
    try {
      requireRole(req, 'qa');
      const body = z.object({ projectId: z.string().min(1), url: z.string().min(1) }).parse(req.body);
      res.status(201).json(await importFigma(body.projectId, body.url, { author: requestAuthor(req) }));
    } catch (error) {
      fail(res, error, 502);
    }
  });

  router.post('/inputs/sync', async (req, res) => {
    try {
      requireRole(req, 'qa');
      const body = z.object({ projectId: z.string().min(1), force: z.boolean().default(false) }).parse(req.body);
      requireProject(body.projectId);
      res.json(await syncProjectInputs(body.projectId, { force: body.force, author: requestAuthor(req) }));
    } catch (error) {
      fail(res, error, 502);
    }
  });

  router.post('/sources/:id/sync', async (req, res) => {
    try {
      requireRole(req, 'qa');
      const force = z.object({ force: z.boolean().default(true) }).parse(req.body ?? {}).force;
      const source = requireSource(req.params.id);
      const options = { force, author: requestAuthor(req) };
      res.json(source.kind === 'figma' ? await syncFigmaSource(source.id, options) : await syncConfluenceSource(source.id, options));
    } catch (error) {
      fail(res, error, 502);
    }
  });

  router.patch('/blocks/:id', (req, res) => {
    try {
      requireRole(req, 'qa', 'dev');
      const body = z.object({ route: z.string().max(500).nullable() }).parse(req.body);
      res.json(setBlockRoute(req.params.id, body.route));
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/blocks/:id', (req, res) => {
    const block = getBlock(req.params.id);
    if (!block) {
      res.status(404).json({ error: `Блок «${req.params.id}» не знайдено` });
      return;
    }
    res.json(requirementViews([block.id], { forAgent: false })[0]);
  });

  router.get('/assets', (req, res) => {
    try {
      const state = typeof req.query.readingState === 'string' ? readingStateSchema.parse(req.query.readingState) : undefined;
      res.json(listAssets(requireProjectId(req), { readingState: state }));
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/assets/:id/file', (req, res) => {
    try {
      const asset = requireAsset(req.params.id);
      const file = assetFilePath(asset);
      if (!file) {
        res.status(404).json({ error: 'Файлу вкладення немає' });
        return;
      }
      // Картинки зі сторінок — чужий вміст: без виконання скриптів і вгадування типу.
      res.setHeader('Content-Type', asset.mediaType ?? 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
      fs.createReadStream(file).pipe(res);
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/assets/:id/reading', (req, res) => {
    try {
      const body = z.object({ reading: z.string().min(1).max(20_000) }).parse(req.body);
      res.json(proposeReading(req.params.id, body.reading, requestAuthor(req)));
    } catch (error) {
      fail(res, error);
    }
  });

  /** Рішення QA щодо прочитання: погоджене — закриває задачу, відхилене — повертає її агентам. */
  router.post('/assets/:id/decide', (req, res) => {
    try {
      requireRole(req, 'qa');
      const body = z
        .object({ approve: z.boolean(), reading: z.string().min(1).max(20_000).optional(), note: z.string().max(5000).optional() })
        .parse(req.body);
      const reviewer = requestAuthor(req);
      const asset = decideReading(req.params.id, body.approve, reviewer, body.reading);
      for (const task of readTasksFor(asset.projectId, asset.id)) {
        if (body.approve) completeTask(task.id, reviewer, 'qa', 'Прочитання погоджено');
        else if (task.state === 'review') requestChanges(task.id, reviewer, body.note ?? 'Прочитання неточне — опишіть ще раз');
      }
      res.json(asset);
    } catch (error) {
      fail(res, error);
    }
  });
}
