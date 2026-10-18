/** Маршрути реєстру: джерела вимог і покриття. */
import type { Router } from 'express';
import { z } from 'zod';
import { requireProject } from '../../registry/projects-store.js';
import { casesForBlocks, createSource, deleteSource, getSource, listBlocks, listSources, refreshSource, requireSource, upsertSourceStub, type RawBlockInput } from '../../registry/sources-store.js';
import { confluenceNotConfigured, syncConfluenceSource, syncFigmaSource } from '../inputs.js';
import { requestAuthor } from '../auth.js';
import { coverageMatrix, linkCoverage, unlinkCoverage } from '../../registry/coverage-store.js';
import { createProposal } from '../../registry/proposals-store.js';
import { ConfluenceModule, loadModule, INTEGRATIONS, fail, requireProjectId } from './common.js';

export function registerSourcesRoutes(router: Router): void {
  router.get('/sources', (req, res) => {
    try {
      const projectId = requireProjectId(req);
      res.json(
        listSources(projectId).map((source) => ({
          ...source,
          // Псевдонім і лічильник змінених блоків для інтерфейсу.
          gapCount: source.gaps,
          changed: listBlocks(source.id).filter((block) => block.changeState === 'changed').length,
        })),
      );
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/sources/import', async (req, res) => {
    try {
      const body = z
        .object({
          projectId: z.string().min(1),
          kind: z.enum(['confluence', 'file', 'paste']),
          url: z.string().optional(),
          externalId: z.string().optional(),
          text: z.string().optional(),
          html: z.string().optional(),
          title: z.string().optional(),
          /** Явний формат вмісту; без нього визначаємо самі (вставити можуть і HTML, і markdown). */
          format: z.enum(['html', 'text', 'markdown']).optional(),
        })
        .parse(req.body);
      requireProject(body.projectId);

      const confluence = await loadModule<ConfluenceModule>(INTEGRATIONS.confluence, 'src/integrations/confluence.ts');

      if (body.kind === 'confluence' && !body.html && !body.text) {
        if (!confluence.isConfluenceConfigured()) {
          res.status(400).json({ error: confluenceNotConfigured() });
          return;
        }
        const page = await confluence.fetchConfluencePage({ url: body.url, pageId: body.externalId });
        const stub = upsertSourceStub({
          projectId: body.projectId,
          kind: 'confluence',
          title: body.title ?? page.title,
          url: page.url,
          externalId: page.externalId,
        });
        await syncConfluenceSource(stub.id, { force: true, author: requestAuthor(req) });
        res.status(201).json({ source: requireSource(stub.id), blocks: listBlocks(stub.id), sourceId: stub.id });
        return;
      }

      const content = body.html ?? body.text ?? '';
      if (!content.trim()) {
        res.status(400).json({ error: 'Потрібен text або html' });
        return;
      }
      // Вставлений вміст буває будь-який: HTML зі Confluence, markdown або простий текст.
      const looksLikeHtml = /<(h[1-6]|p|div|table|ul|ol|section)\b/i.test(content);
      const format = body.format ?? (body.html || looksLikeHtml ? 'html' : 'markdown');
      const blocks = confluence.splitIntoBlocks(content, { format });
      const created = createSource({
        projectId: body.projectId,
        kind: body.kind,
        title: body.title ?? 'Без назви',
        url: body.url,
        blocks,
      });
      res.status(201).json({ ...created, sourceId: created.source.id });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/sources/:id', (req, res) => {
    const source = getSource(req.params.id);
    if (!source) {
      res.status(404).json({ error: `Джерело «${req.params.id}» не знайдено` });
      return;
    }
    res.json({ ...source, blocks: listBlocks(source.id) });
  });

  router.post('/sources/:id/refresh', async (req, res) => {
    try {
      const source = requireSource(req.params.id);
      const confluence = await loadModule<ConfluenceModule>(INTEGRATIONS.confluence, 'src/integrations/confluence.ts');

      let blocks: RawBlockInput[];
      const body = z
        .object({ text: z.string().optional(), html: z.string().optional() })
        .parse(req.body ?? {});

      if (source.kind === 'confluence' || source.kind === 'figma') {
        const synced =
          source.kind === 'figma'
            ? await syncFigmaSource(source.id, { force: true, author: requestAuthor(req) })
            : await syncConfluenceSource(source.id, { force: true, author: requestAuthor(req) });
        res.json(synced);
        return;
      }
      {
        const content = body.html ?? body.text ?? '';
        if (!content.trim()) {
          res.status(400).json({ error: 'Для джерела цього типу передайте text або html' });
          return;
        }
        blocks = confluence.splitIntoBlocks(content, { format: body.html ? 'html' : 'markdown' });
      }

      const result = refreshSource(source.id, blocks);
      const touched = casesForBlocks([...result.changed, ...result.removed]);
      const proposals = touched.map((link) =>
        createProposal({
          projectId: source.projectId,
          kind: 'case_update',
          title: `Вимога змінилась — перевірте кейс ${link.caseId}`,
          rationale: 'Текст блоку вимоги змінився після переімпорту джерела',
          payload: { caseId: link.caseId, changes: {} },
          origin: { sourceId: source.id, blockId: link.blockId, caseId: link.caseId },
        }),
      );

      res.json({
        changed: result.changed.length,
        added: result.added.length,
        removed: result.removed.length,
        same: result.same.length,
        proposals,
      });
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete('/sources/:id', (req, res) => {
    try {
      deleteSource(req.params.id);
      res.json({ deleted: true, note: 'Звʼязки покриття лишилися як orphan' });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/coverage', (req, res) => {
    try {
      const projectId = requireProjectId(req);
      const sourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId : undefined;
      res.json(coverageMatrix(projectId, sourceId));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/coverage', (req, res) => {
    try {
      const body = z
        .object({
          blockId: z.string().min(1),
          caseId: z.string().min(1),
          kind: z.enum(['quote', 'derived']).default('quote'),
          confirmed: z.boolean().default(false),
          note: z.string().default(''),
        })
        .parse(req.body);
      res.status(201).json(linkCoverage(body));
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete('/coverage/:id', (req, res) => {
    const removed = unlinkCoverage(req.params.id);
    if (!removed) {
      res.status(404).json({ error: `Звʼязок «${req.params.id}» не знайдено` });
      return;
    }
    res.json({ deleted: true });
  });
}
