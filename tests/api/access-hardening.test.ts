import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';
import { createApp } from '../../src/server/index.js';
import { createTempRegistry, type TempRegistry } from '../unit/registry/temp-db.js';

const BASE = '/api/registry';

describe('доступ: закриті обхідні шляхи', () => {
  let temp: TempRegistry;
  let app: Application;
  const as = (login: string) => (r: request.Test) => r.set('Tailscale-User-Login', login);
  const lead = as('lead@corp');
  const qa = as('qa@corp');
  const dev = as('dev@corp');

  async function project(key = 'CYBER'): Promise<{ id: string; sectionId: string }> {
    const created = await lead(request(app).post(`${BASE}/projects`)).send({ key, name: key });
    const section = await lead(request(app).post(`${BASE}/sections`)).send({ projectId: created.body.id, name: 'Модуль' });
    return { id: created.body.id, sectionId: section.body.id };
  }

  async function ciToken(projectId: string): Promise<string> {
    const issued = await lead(request(app).post(`${BASE}/tokens`)).send({ name: 'CI', role: 'ci', projectId });
    return issued.body.token as string;
  }

  beforeEach(() => {
    temp = createTempRegistry();
    delete process.env.JULES_API_TOKEN;
    process.env.JULES_REQUIRE_AUTH = '1';
    process.env.JULES_ADMINS = 'lead@corp';
    process.env.JULES_QA_USERS = 'qa@corp';
    app = createApp();
  });

  afterEach(() => {
    delete process.env.JULES_REQUIRE_AUTH;
    delete process.env.JULES_ADMINS;
    delete process.env.JULES_QA_USERS;
    temp.cleanup();
  });

  it('інший регістр або подвійна скісна риска в шляху не обходять авторизацію', async () => {
    for (const path of ['/API/registry/projects', '/Api/registry/me', '//api/registry/projects', '/api/Registry/projects']) {
      const res = await request(app).get(path);
      expect(res.status, path).not.toBe(200);
    }
    expect((await request(app).post('/MCP').send({})).status).toBe(401);
    expect((await request(app).post('/API/registry/projects').send({ key: 'X', name: 'X' })).status).toBe(401);
  });

  it('погоджує пропозицію лише QA, а рецензент береться з особи, не з тіла запиту', async () => {
    const { id, sectionId } = await project();
    const proposal = await dev(request(app).post(`${BASE}/proposals`)).send({
      projectId: id,
      kind: 'case_create',
      title: 'Новий кейс',
      payload: { title: 'Новий кейс', sectionId },
    });
    expect(proposal.status).toBe(201);

    const byDev = await dev(request(app).post(`${BASE}/proposals/approve`)).send({ ids: [proposal.body.id], reviewer: 'qa@corp' });
    expect(byDev.status).toBe(403);
    expect((await dev(request(app).patch(`${BASE}/proposals/${proposal.body.id}`)).send({ title: 'Інше' })).status).toBe(403);
    expect((await dev(request(app).delete(`${BASE}/proposals/${proposal.body.id}`))).status).toBe(403);
    expect((await dev(request(app).post(`${BASE}/proposals/reject`)).send({ ids: [proposal.body.id] })).status).toBe(403);

    const byQa = await qa(request(app).post(`${BASE}/proposals/approve`)).send({ ids: [proposal.body.id], reviewer: 'someone@else' });
    expect(byQa.status).toBe(200);
    const stored = await qa(request(app).get(`${BASE}/proposals?projectId=${id}&state=approved`));
    expect(stored.body.items[0].reviewer).toBe('qa@corp');
  });

  it('кейси змінює QA, а розробник — ні', async () => {
    const { id, sectionId } = await project();
    expect((await dev(request(app).post(`${BASE}/cases`)).send({ projectId: id, sectionId, title: 'x' })).status).toBe(403);
    const created = await qa(request(app).post(`${BASE}/cases`)).send({ projectId: id, sectionId, title: 'x' });
    expect(created.status).toBe(201);
    expect((await dev(request(app).patch(`${BASE}/cases/${created.body.id}`)).send({ title: 'y', status: 'approved' })).status).toBe(403);
    expect((await dev(request(app).delete(`${BASE}/cases/${created.body.id}`))).status).toBe(403);
    expect((await dev(request(app).post(`${BASE}/cases/${created.body.id}/automation`)).send({ status: 'automated' })).status).toBe(403);
  });

  it('налаштування проєкту змінює QA; розробник і токен CI — ні', async () => {
    const { id } = await project();
    const token = await ciToken(id);
    expect((await dev(request(app).patch(`${BASE}/projects/${id}`)).send({ settings: { telegram: { chatId: 'x' } } })).status).toBe(403);
    const byCi = await request(app).patch(`${BASE}/projects/${id}`).set('Authorization', `Bearer ${token}`).send({ settings: { telegram: { chatId: 'x' } } });
    expect(byCi.status).toBe(403);
    expect((await qa(request(app).patch(`${BASE}/projects/${id}`)).send({ settings: { telegram: { chatId: '-1' } } })).status).toBe(200);
  });

  it('токен CI читає лише свій проєкт', async () => {
    const a = await project('AAA');
    const b = await project('BBB');
    const token = await ciToken(a.id);
    expect((await request(app).get(`${BASE}/projects/${a.id}`).set('Authorization', `Bearer ${token}`)).status).toBe(200);
    expect((await request(app).get(`${BASE}/projects/${b.id}`).set('Authorization', `Bearer ${token}`)).status).toBe(403);
  });

  it('прогони PR і main, події PR і перевірку пушів шле лише CI; розробнику лишається local', async () => {
    const { id } = await project();
    const run = (event: string) => ({ projectId: id, sha: 'abcdef1234', branch: 'feature', event, results: [] });
    expect((await dev(request(app).post(`${BASE}/ingest/run`)).send(run('main'))).status).toBe(403);
    expect((await dev(request(app).post(`${BASE}/ingest/run`)).send(run('pr'))).status).toBe(403);
    expect((await dev(request(app).post(`${BASE}/ingest/run`)).send(run('local'))).status).toBe(201);
    expect((await dev(request(app).post(`${BASE}/ingest/pr-event`)).send({ projectId: id, prNumber: 5, state: 'merged' })).status).toBe(403);
    expect(
      (await dev(request(app).post(`${BASE}/ingest/push-check`)).send({ projectId: id, sha: 'abcdef1234', branch: 'main', viaPr: false })).status,
    ).toBe(403);

    const token = await ciToken(id);
    const byCi = await request(app).post(`${BASE}/ingest/run`).set('Authorization', `Bearer ${token}`).send(run('main'));
    expect(byCi.status).toBe(201);
  });

  it('великий прогін (понад 1 МБ) приймається інжестом, а надто великий запит отримує JSON-помилку', async () => {
    const { id } = await project();
    const token = await ciToken(id);
    const results = Array.from({ length: 4000 }, (_, index) => ({
      key: `k${index}`,
      file: `tests/module-${index % 50}/feature-${index}.test.ts`,
      name: `перевірка номер ${index} з довгою назвою для об'єму`,
      fullName: `набір › перевірка номер ${index} з довгою назвою для об'єму`,
      status: 'passed',
      framework: 'vitest',
      level: 'unit',
    }));
    const res = await request(app)
      .post(`${BASE}/ingest/run`)
      .set('Authorization', `Bearer ${token}`)
      .send({ projectId: id, sha: 'abcdef1234', branch: 'main', event: 'main', results });
    expect(res.status).toBe(201);
    expect(res.body.tests).toBe(4000);

    const tooBig = await qa(request(app).post(`${BASE}/cases`)).set('Content-Type', 'application/json').send(`{"title":"${'x'.repeat(1_200_000)}"}`);
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.error).toBeTruthy();
  });

  it('персональний токен втрачає права разом зі зниженням ролі власника', async () => {
    await qa(request(app).get(`${BASE}/me`));
    const issued = await qa(request(app).post(`${BASE}/tokens`)).send({ name: 'мій', role: 'qa' });
    expect(issued.status).toBe(201);
    const bearer = { Authorization: `Bearer ${issued.body.token}` };
    expect((await request(app).get(`${BASE}/me`).set(bearer)).body.role).toBe('qa');
    await lead(request(app).patch(`${BASE}/users/qa@corp`)).send({ role: 'dev' });
    expect((await request(app).get(`${BASE}/me`).set(bearer)).body.role).toBe('dev');
  });

  it('прибрати Jira з проєкту можна значенням null', async () => {
    const { id } = await project();
    await qa(request(app).patch(`${BASE}/projects/${id}`)).send({ settings: { jira: { projectKey: 'CYB' } } });
    const res = await qa(request(app).patch(`${BASE}/projects/${id}`)).send({ settings: { jira: null } });
    expect(res.status).toBe(200);
    expect(res.body.settings.jira).toBeUndefined();
  });
});
