/** Маршрути реєстру: прогони. */
import type { Router } from 'express';
import { z } from 'zod';
import { defectSeveritySchema, itemStatusSchema, runKindSchema, runStateSchema } from '../../registry/types.js';
import { attachAutoRun, createRun, listRunItems, listRuns, rerunFailed, runDetail, runEvents, setItemStatus, updateRun, type RunEvent } from '../../registry/runs-store.js';
import { requestAuthor } from '../auth.js';
import { startTestRun } from '../test-runner.js';
import { settleRun, syncAutoResults, watchAutoResults } from '../registry-bridge.js';
import { fail, asInt, requireProjectId } from './common.js';

export function registerRunsRoutes(router: Router): void {
  router.get('/runs', (req, res) => {
    try {
      res.json(
        listRuns({
          projectId: requireProjectId(req),
          kind: typeof req.query.kind === 'string' ? runKindSchema.parse(req.query.kind) : undefined,
          state: typeof req.query.state === 'string' ? runStateSchema.parse(req.query.state) : undefined,
          page: asInt(req.query.page, 1),
          limit: asInt(req.query.limit, 50),
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/runs', (req, res) => {
    try {
      const body = z
        .object({
          projectId: z.string().min(1),
          kind: runKindSchema.default('manual'),
          title: z.string().optional(),
          selectionId: z.string().optional(),
          caseIds: z.array(z.string()).optional(),
          env: z
            .object({
              baseUrl: z.string().optional(),
              mode: z.enum(['warm-up', 'regression']).optional(),
              label: z.string().optional(),
            })
            .optional(),
          note: z.string().optional(),
        })
        .refine((data) => Boolean(data.selectionId || (data.caseIds && data.caseIds.length > 0)), {
          message: 'Передайте selectionId або caseIds',
        })
        .parse(req.body);
      res.status(201).json(createRun({ ...body, executor: requestAuthor(req) }));
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/runs/:id', (req, res) => {
    const detail = runDetail(req.params.id);
    if (!detail) {
      res.status(404).json({ error: `Прогін «${req.params.id}» не знайдено` });
      return;
    }
    res.json(detail);
  });

  router.patch('/runs/:id', (req, res) => {
    try {
      const body = z
        .object({
          state: runStateSchema.optional(),
          title: z.string().min(1).optional(),
          note: z.string().optional(),
        })
        .parse(req.body);
      const run = updateRun(req.params.id, body);
      if (body.state === 'completed') settleRun(run.id);
      res.json(run);
    } catch (error) {
      fail(res, error);
    }
  });

  router.put('/runs/:id/items/:caseId', (req, res) => {
    try {
      const body = z
        .object({
          status: itemStatusSchema,
          comment: z.string().optional(),
          evidence: z.array(z.string()).optional(),
          durationMs: z.number().int().nonnegative().optional(),
          defect: z
            .object({
              title: z.string().min(1),
              severity: defectSeveritySchema.optional(),
              details: z.string().optional(),
            })
            .optional(),
        })
        .parse(req.body);
      res.json(
        setItemStatus(req.params.id, req.params.caseId, { ...body, updatedBy: requestAuthor(req) }),
      );
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/runs/:id/rerun-failed', (req, res) => {
    try {
      res.status(201).json(rerunFailed(req.params.id, requestAuthor(req)));
    } catch (error) {
      fail(res, error);
    }
  });

  /**
   * Ставить у чергу прогони рушія для автоматизованих кейсів.
   * `startTestRun` — єдиний виклик у бік старого світу тест-раннера.
   */
  router.post('/runs/:id/auto', async (req, res) => {
    try {
      const detail = runDetail(req.params.id);
      if (!detail) {
        res.status(404).json({ error: `Прогін «${req.params.id}» не знайдено` });
        return;
      }
      const only = new Set(z.object({ caseIds: z.array(z.string()).optional() }).parse(req.body ?? {}).caseIds ?? []);
      const queued: Array<{ caseId: string; autoRunId: string; scenarioPath: string }> = [];
      const skipped: Array<{ caseId: string; reason: string }> = [];

      for (const item of detail.items) {
        if (only.size > 0 && !only.has(item.caseId)) continue;
        const automation = item.case.automation;
        if (automation.status !== 'automated') {
          skipped.push({ caseId: item.caseId, reason: 'кейс не автоматизований' });
          continue;
        }
        if (!automation.scenarioPath) {
          skipped.push({ caseId: item.caseId, reason: 'не заданий scenarioPath' });
          continue;
        }
        try {
          const engineRun = await startTestRun(
            {
              qaScenarioPath: automation.scenarioPath,
              ...(detail.env.baseUrl ? { qaTargetUrl: detail.env.baseUrl } : {}),
              ...(detail.env.mode ? { qaMode: detail.env.mode } : {}),
            },
            // Ціль закріплюємо лише тоді, коли її задали для цього прогону:
            // дефолт проєкту не має відбирати у сценарію його власну адресу.
            { pinTargetUrl: Boolean(detail.env.baseUrlPinned && detail.env.baseUrl) },
          );
          attachAutoRun(detail.id, item.caseId, engineRun.id);
          queued.push({ caseId: item.caseId, autoRunId: engineRun.id, scenarioPath: automation.scenarioPath });
        } catch (error) {
          skipped.push({
            caseId: item.caseId,
            reason: error instanceof Error ? error.message : 'не вдалося запустити',
          });
        }
      }

      // Мостик донесе результати рушія в елементи прогону й історію кейсів.
      if (queued.length > 0) watchAutoResults(detail.id);
      res.json({ queued, skipped, total: detail.items.length });
    } catch (error) {
      fail(res, error, 502);
    }
  });

  /** Ручна синхронізація результатів рушія — напр. після перезапуску сервера. */
  router.post('/runs/:id/sync-auto', async (req, res) => {
    try {
      const detail = runDetail(req.params.id);
      if (!detail) {
        res.status(404).json({ error: `Прогін «${req.params.id}» не знайдено` });
        return;
      }
      const outcome = await syncAutoResults(detail.id);
      if (outcome.pending === 0) settleRun(detail.id);
      else watchAutoResults(detail.id);
      res.json(outcome);
    } catch (error) {
      fail(res, error, 502);
    }
  });

  router.get('/runs/:id/stream', (req, res) => {
    const runId = req.params.id;
    if (!runDetail(runId)) {
      res.status(404).json({ error: `Прогін «${runId}» не знайдено` });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let eventId = asInt(req.get('last-event-id') ?? req.query.lastEventId, 0);
    const send = (event: string, data: unknown): void => {
      eventId += 1;
      res.write(`id: ${eventId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('snapshot', { runId, items: listRunItems(runId) });

    const onEvent = (event: RunEvent): void => {
      if (event.runId !== runId) return;
      send(event.type, event.payload);
    };
    runEvents.on('event', onEvent);

    // Heartbeat кожні 15 с — інакше проксі рубає простій.
    const heartbeat = setInterval(() => {
      res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
    }, 15_000);

    const close = (): void => {
      clearInterval(heartbeat);
      runEvents.off('event', onEvent);
    };
    req.on('close', close);
    res.on('close', close);
  });
}
