import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { loadSettings, saveSettings } from './settings-store.js';
import { getRun, listRuns } from './runs-store.js';
import { cancelRun, isRunActive, isRunOrChildActive, resumeRun, startSuiteRun, startTestRun } from './test-runner.js';
import {
  deleteScenario,
  emptyScenarioTemplate,
  getScenarioByPath,
  listScenarioDetails,
  saveScenario,
} from './scenarios-store.js';
import {
  deleteSuite,
  emptySuiteTemplate,
  getSuite,
  listSuites,
  saveSuite,
} from './suites-store.js';
import { scenarioYamlSchema } from '../planning/types.js';
import { startRunRequestSchema, suiteDefinitionSchema, uiSettingsSchema } from './types.js';
import { enhanceScenario, generateScenarioFromDescription, suggestTestIdeas } from './ai-assistant.js';
import { z } from 'zod';
import { getMidsceneRunRoot } from './data-paths.js';

dotenv.config();

export function createApp(): express.Application {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  app.get('/api/settings', async (_req, res) => {
    res.json(await loadSettings());
  });

  app.put('/api/settings', async (req, res) => {
    try {
      const settings = await saveSettings(uiSettingsSchema.parse(req.body));
      res.json(settings);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid settings' });
    }
  });

  app.get('/api/scenarios', async (_req, res) => {
    res.json(await listScenarioDetails());
  });

  app.get('/api/scenarios/template', (_req, res) => {
    res.json(emptyScenarioTemplate());
  });

  app.get('/api/scenarios/detail/:filename', async (req, res) => {
    try {
      const scenario = await getScenarioByPath(`scenarios/${req.params.filename}`);
      res.json(scenario);
    } catch (error) {
      res.status(404).json({ error: error instanceof Error ? error.message : 'Not found' });
    }
  });

  app.post('/api/scenarios', async (req, res) => {
    try {
      const data = scenarioYamlSchema.parse(req.body);
      const saved = await saveScenario(data);
      res.status(201).json(saved);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid scenario' });
    }
  });

  app.put('/api/scenarios/detail/:filename', async (req, res) => {
    try {
      const existingPath = `scenarios/${req.params.filename}`;
      const data = scenarioYamlSchema.parse(req.body);
      const saved = await saveScenario(data, existingPath);
      res.json(saved);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid scenario' });
    }
  });

  app.delete('/api/scenarios/detail/:filename', async (req, res) => {
    try {
      await deleteScenario(`scenarios/${req.params.filename}`);
      res.json({ deleted: true });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Delete failed' });
    }
  });

  app.get('/api/suites', async (_req, res) => {
    res.json(await listSuites());
  });

  app.get('/api/suites/template', (_req, res) => {
    res.json(emptySuiteTemplate());
  });

  app.get('/api/suites/:id', async (req, res) => {
    const suite = await getSuite(req.params.id);
    if (!suite) {
      res.status(404).json({ error: 'Suite not found' });
      return;
    }
    res.json(suite);
  });

  app.post('/api/suites', async (req, res) => {
    try {
      const data = suiteDefinitionSchema.omit({ id: true, createdAt: true, updatedAt: true }).parse(req.body);
      const saved = await saveSuite(data);
      res.status(201).json(saved);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid suite' });
    }
  });

  app.put('/api/suites/:id', async (req, res) => {
    try {
      const data = suiteDefinitionSchema.omit({ createdAt: true, updatedAt: true }).parse({
        ...req.body,
        id: req.params.id,
      });
      const saved = await saveSuite(data);
      res.json(saved);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid suite' });
    }
  });

  app.delete('/api/suites/:id', async (req, res) => {
    try {
      await deleteSuite(req.params.id);
      res.json({ deleted: true });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Delete failed' });
    }
  });

  app.post('/api/suites/:id/run', async (req, res) => {
    try {
      const body = req.body ?? {};
      const run = await startSuiteRun(req.params.id, {
        qaTargetUrl: body.qaTargetUrl,
        qaMode: body.qaMode,
        debugCache: body.debugCache,
      });
      res.status(201).json(run);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to start suite' });
    }
  });

  app.get('/api/llm/check', async (_req, res) => {
    const settings = await loadSettings();
    const baseUrl = settings.llmBaseUrl ?? process.env.MIDSCENE_MODEL_BASE_URL;
    if (!baseUrl) {
      res.status(400).json({ ok: false, error: 'LLM URL not configured' });
      return;
    }
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
        headers: { Authorization: `Bearer ${process.env.MIDSCENE_MODEL_API_KEY ?? 'lm-studio'}` },
        signal: AbortSignal.timeout(15_000),
      });
      const data = await response.json();
      res.json({ ok: response.ok, models: (data as { data?: Array<{ id: string }> }).data?.map((m) => m.id) ?? [] });
    } catch (error) {
      res.status(502).json({ ok: false, error: error instanceof Error ? error.message : 'Connection failed' });
    }
  });

  app.get('/api/stats', async (_req, res) => {
    const [runs, scenarios, suites] = await Promise.all([
      listRuns(200),
      listScenarioDetails(),
      listSuites(),
    ]);
    const topLevel = runs.filter((r) => r.runType !== 'suite-step');
    const passed = topLevel.filter((r) => r.status === 'passed').length;
    const failed = topLevel.filter((r) => r.status === 'failed').length;
    const running = topLevel.filter((r) => r.status === 'running' || r.status === 'queued' || r.status === 'paused').length;
    const finished = passed + failed;
    const last7d = topLevel.filter((r) => {
      const t = new Date(r.startedAt).getTime();
      return Date.now() - t < 7 * 24 * 60 * 60 * 1000;
    });

    res.json({
      totalRuns: topLevel.length,
      passed,
      failed,
      running,
      passRate: finished > 0 ? Math.round((passed / finished) * 100) : null,
      scenariosCount: scenarios.length,
      suitesCount: suites.length,
      last7dRuns: last7d.length,
      last7dPassed: last7d.filter((r) => r.status === 'passed').length,
      recentRuns: topLevel.slice(0, 8).map(({ logs, ...meta }) => ({
        ...meta,
        logCount: logs.length,
      })),
    });
  });

  app.post('/api/ai/generate-scenario', async (req, res) => {
    try {
      const body = z
        .object({
          description: z.string().min(10),
          targetUrl: z.string().url().optional(),
          testType: z.enum(['smoke', 'regression', 'accessibility', 'security', 'e2e']).optional(),
        })
        .parse(req.body);
      const scenario = await generateScenarioFromDescription(body);
      res.json(scenario);
    } catch (error) {
      res.status(error instanceof z.ZodError ? 400 : 502).json({
        error: error instanceof Error ? error.message : 'Generation failed',
      });
    }
  });

  app.post('/api/ai/enhance-scenario', async (req, res) => {
    try {
      const body = z
        .object({
          scenario: scenarioYamlSchema.partial(),
          focus: z.enum(['hints', 'steps', 'criteria', 'all']).optional(),
        })
        .parse(req.body);
      const enhanced = await enhanceScenario({ scenario: body.scenario, focus: body.focus });
      res.json(enhanced);
    } catch (error) {
      res.status(error instanceof z.ZodError ? 400 : 502).json({
        error: error instanceof Error ? error.message : 'Enhance failed',
      });
    }
  });

  app.post('/api/ai/suggest-ideas', async (req, res) => {
    try {
      const body = z
        .object({
          targetUrl: z.string().url(),
          context: z.string().optional(),
        })
        .parse(req.body);
      const ideas = await suggestTestIdeas(body.targetUrl, body.context);
      res.json({ ideas });
    } catch (error) {
      res.status(error instanceof z.ZodError ? 400 : 502).json({
        error: error instanceof Error ? error.message : 'Suggest failed',
      });
    }
  });

  app.get('/api/runs', async (_req, res) => {
    const runs = await listRuns();
    const enriched = await Promise.all(
      runs.map(async ({ logs, ...meta }) => ({
        ...meta,
        logCount: logs.length,
        active: await isRunOrChildActive(meta.id),
      })),
    );
    res.json(enriched);
  });

  app.get('/api/runs/:id', async (req, res) => {
    const run = await getRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    res.json({ ...run, active: isRunActive(run.id) });
  });

  app.post('/api/runs', async (req, res) => {
    try {
      const body = req.body?.overrides ?? req.body ?? {};
      if (body.suiteId) {
        const run = await startSuiteRun(body.suiteId, body);
        res.status(201).json(run);
        return;
      }
      const parsed = startRunRequestSchema.parse(body);
      const run = await startTestRun(parsed);
      res.status(201).json(run);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to start run' });
    }
  });

  app.post('/api/runs/:id/cancel', (req, res) => {
    const ok = cancelRun(req.params.id);
    res.json({ cancelled: ok });
  });

  app.post('/api/runs/:id/resume', async (req, res) => {
    try {
      const ok = await resumeRun(req.params.id);
      if (!ok) {
        res.status(404).json({ error: 'Run not found or not paused' });
        return;
      }
      res.json({ resumed: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Resume failed' });
    }
  });

  app.get('/api/runs/:id/stream', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let lastIndex = 0;
    const interval = setInterval(async () => {
      const run = await getRun(req.params.id);
      if (!run) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: 'not found' })}\n\n`);
        clearInterval(interval);
        res.end();
        return;
      }

      if (run.logs.length > lastIndex) {
        const chunk = run.logs.slice(lastIndex);
        lastIndex = run.logs.length;
        res.write(`event: log\ndata: ${JSON.stringify(chunk)}\n\n`);
      }

      if (run.status !== 'running' && run.status !== 'queued' && run.status !== 'paused') {
        res.write(`event: done\ndata: ${JSON.stringify({ status: run.status, exitCode: run.exitCode })}\n\n`);
        clearInterval(interval);
        res.end();
      }
    }, 1000);

    req.on('close', () => clearInterval(interval));
  });

  const midsceneRoot = getMidsceneRunRoot();
  app.use('/reports/midscene', express.static(path.join(midsceneRoot, 'report')));
  app.use('/reports/plans', express.static(path.join(midsceneRoot, 'plans')));
  app.use('/reports/aggregate', express.static(path.join(midsceneRoot, 'aggregate')));
  app.use('/reports/playwright', express.static(path.join(process.cwd(), 'playwright-report')));
  app.use('/reports/videos', express.static(path.join(process.cwd(), 'test-results')));

  const webDist = path.join(process.cwd(), 'web', 'dist');
  app.use(express.static(webDist));

  app.get(/^(?!\/api|\/reports).*/, (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'), (err) => {
      if (err) res.status(404).send('UI not built. Run: npm run ui:build');
    });
  });

  return app;
}
