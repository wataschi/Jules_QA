import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/server/index.js';
import { resetEnvCache } from '../../src/config/env.js';
import {
  applyWorkspaceEnv,
  clearWorkspaceEnv,
  createTempWorkspace,
  type TempWorkspace,
  writeScenario,
} from '../helpers/temp-workspace.js';

describe('REST API', () => {
  let ws: TempWorkspace;
  const app = createApp();
  const originalFetch = global.fetch;

  beforeEach(async () => {
    ws = await createTempWorkspace();
    applyWorkspaceEnv(ws);
    resetEnvCache();
    process.env.QA_TARGET_URL = 'https://example.com';
    process.env.QA_SCENARIO_PATH = 'scenarios/api-test.yaml';
    process.env.QA_MODE = 'warm-up';

    await writeScenario(ws, 'api-test.yaml', {
      name: 'api-test',
      goal: 'API test scenario',
      steps: ['Navigate'],
      success_criteria: ['Loaded'],
    });
    await writeScenario(ws, 'suite-step-a.yaml', {
      name: 'suite-step-a',
      goal: 'Step A',
      steps: ['A'],
      success_criteria: ['A ok'],
    });
    await writeScenario(ws, 'suite-step-b.yaml', {
      name: 'suite-step-b',
      goal: 'Step B',
      steps: ['B'],
      success_criteria: ['B ok'],
    });
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    clearWorkspaceEnv();
    resetEnvCache();
    await ws.cleanup();
  });

  it('GET /api/health returns ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.time).toBeTruthy();
  });

  it('GET/PUT /api/settings round-trip', async () => {
    const put = await request(app)
      .put('/api/settings')
      .send({
        qaTargetUrl: 'https://example.com',
        qaMode: 'regression',
        qaScenarioPath: 'scenarios/api-test.yaml',
        debugCache: false,
      });
    expect(put.status).toBe(200);
    expect(put.body.qaMode).toBe('regression');

    const get = await request(app).get('/api/settings');
    expect(get.body.qaMode).toBe('regression');
  });

  it('PUT /api/settings rejects invalid URL', async () => {
    const res = await request(app)
      .put('/api/settings')
      .send({
        qaTargetUrl: 'not-url',
        qaMode: 'warm-up',
        qaScenarioPath: 'scenarios/api-test.yaml',
      });
    expect(res.status).toBe(400);
  });

  it('GET /api/scenarios lists scenarios', async () => {
    const res = await request(app).get('/api/scenarios');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(3);
  });

  it('GET /api/scenarios/template returns template', async () => {
    const res = await request(app).get('/api/scenarios/template');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('new-scenario');
    expect(res.body.goal).toBeTruthy();
  });

  it('POST/PUT/DELETE /api/scenarios/detail/:filename', async () => {
    const create = await request(app)
      .post('/api/scenarios')
      .send({
        name: 'created-via-api',
        goal: 'Created',
        tags: [],
        hints: [],
        steps: [],
        success_criteria: [],
      });
    expect(create.status).toBe(201);
    expect(create.body.path).toContain('created-via-api');

    const filename = create.body.path.replace('scenarios/', '');
    const update = await request(app)
      .put(`/api/scenarios/detail/${filename}`)
      .send({
        name: 'created-via-api',
        goal: 'Updated goal',
        tags: [],
        hints: [],
        steps: [],
        success_criteria: [],
      });
    expect(update.status).toBe(200);

    const detail = await request(app).get(`/api/scenarios/detail/${filename}`);
    expect(detail.status).toBe(200);
    expect(detail.body.goal).toBe('Updated goal');

    const del = await request(app).delete(`/api/scenarios/detail/${filename}`);
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);
  });

  it('POST /api/scenarios rejects invalid body', async () => {
    const res = await request(app).post('/api/scenarios').send({ goal: 'missing name' });
    expect(res.status).toBe(400);
  });

  it('GET /api/scenarios/detail/:filename returns 404 for missing', async () => {
    const res = await request(app).get('/api/scenarios/detail/missing.yaml');
    expect(res.status).toBe(404);
  });

  it('CRUD /api/suites', async () => {
    const create = await request(app)
      .post('/api/suites')
      .send({
        name: 'API Suite',
        description: 'Test suite',
        scenarioPaths: ['scenarios/suite-step-a.yaml'],
        stopOnFailure: true,
      });
    expect(create.status).toBe(201);
    const id = create.body.id;

    const get = await request(app).get(`/api/suites/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.name).toBe('API Suite');

    const update = await request(app)
      .put(`/api/suites/${id}`)
      .send({
        id,
        name: 'API Suite Updated',
        description: '',
        scenarioPaths: ['scenarios/suite-step-a.yaml', 'scenarios/suite-step-b.yaml'],
        stopOnFailure: false,
      });
    expect(update.status).toBe(200);
    expect(update.body.stopOnFailure).toBe(false);

    const list = await request(app).get('/api/suites');
    expect(list.body.some((s: { id: string }) => s.id === id)).toBe(true);

    const del = await request(app).delete(`/api/suites/${id}`);
    expect(del.status).toBe(200);
  });

  it('GET /api/suites/template returns template', async () => {
    const res = await request(app).get('/api/suites/template');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('new-suite');
  });

  it('GET /api/suites/:id returns 404 for missing', async () => {
    const res = await request(app).get('/api/suites/missing-id');
    expect(res.status).toBe(404);
  });

  it('POST /api/runs starts single run with mock runner', async () => {
    const res = await request(app)
      .post('/api/runs')
      .send({
        qaTargetUrl: 'https://example.com',
        qaMode: 'warm-up',
        qaScenarioPath: 'scenarios/api-test.yaml',
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.status).toBe('queued');

    await new Promise((r) => setTimeout(r, 500));
    const detail = await request(app).get(`/api/runs/${res.body.id}`);
    expect(['passed', 'running', 'queued']).toContain(detail.body.status);
  });

  it('POST /api/suites/:id/run starts suite run', async () => {
    const suite = await request(app)
      .post('/api/suites')
      .send({
        name: 'Run Suite',
        description: '',
        scenarioPaths: ['scenarios/suite-step-a.yaml', 'scenarios/suite-step-b.yaml'],
        stopOnFailure: false,
      });
    const res = await request(app)
      .post(`/api/suites/${suite.body.id}/run`)
      .send({ qaTargetUrl: 'https://example.com', qaMode: 'warm-up' });
    expect(res.status).toBe(201);
    expect(res.body.runType).toBe('suite');
    expect(res.body.childRunIds).toHaveLength(2);
    expect(res.body.totalSteps).toBe(2);

    const detail = await request(app).get(`/api/runs/${res.body.id}`);
    expect(detail.body.childRunIds).toHaveLength(2);

    const allRuns = await request(app).get('/api/runs');
    const childRuns = allRuns.body.filter((r: { parentRunId?: string }) => r.parentRunId === res.body.id);
    expect(childRuns).toHaveLength(2);
    expect(childRuns.every((r: { status: string }) => r.status === 'queued' || r.status === 'running' || r.status === 'passed')).toBe(true);
  });

  it('GET /api/runs lists runs', async () => {
    await request(app).post('/api/runs').send({
      qaTargetUrl: 'https://example.com',
      qaScenarioPath: 'scenarios/api-test.yaml',
    });
    const res = await request(app).get('/api/runs');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('GET /api/runs/:id returns 404 for missing', async () => {
    const res = await request(app).get('/api/runs/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  it('POST /api/runs/:id/cancel returns cancelled flag', async () => {
    const res = await request(app).post('/api/runs').send({
      qaTargetUrl: 'https://example.com',
      qaScenarioPath: 'scenarios/api-test.yaml',
    });
    const cancel = await request(app).post(`/api/runs/${res.body.id}/cancel`);
    expect(cancel.status).toBe(200);
    expect(cancel.body.cancelled).toBe(true);
  });

  it('GET /api/runs/:id/stream returns SSE headers', async () => {
    const run = await request(app).post('/api/runs').send({
      qaTargetUrl: 'https://example.com',
      qaScenarioPath: 'scenarios/api-test.yaml',
    });

    const res = await request(app)
      .get(`/api/runs/${run.body.id}/stream`)
      .buffer(true)
      .parse((res, cb) => {
        res.setEncoding('utf8');
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => cb(null, data));
      });

    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(String(res.body)).toContain('event:');
  });

  it('GET /api/llm/check with mock fetch', async () => {
    await request(app)
      .put('/api/settings')
      .send({
        qaTargetUrl: 'https://example.com',
        qaMode: 'warm-up',
        qaScenarioPath: 'scenarios/api-test.yaml',
        debugCache: false,
        llmBaseUrl: 'http://mock-llm/v1',
      });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'model-a' }] }),
    }));

    const res = await request(app).get('/api/llm/check');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.models).toContain('model-a');
  });

  it('GET /api/llm/check returns 400 when URL not configured', async () => {
    await request(app)
      .put('/api/settings')
      .send({
        qaTargetUrl: 'https://example.com',
        qaMode: 'warm-up',
        qaScenarioPath: 'scenarios/api-test.yaml',
        debugCache: false,
      });
    delete process.env.MIDSCENE_MODEL_BASE_URL;

    const res = await request(app).get('/api/llm/check');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('GET / serves SPA or build hint', async () => {
    const res = await request(app).get('/');
    expect([200, 404]).toContain(res.status);
  });
});
