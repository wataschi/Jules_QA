import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';
import { createApp } from '../../src/server/index.js';
import { createTempRegistry, type TempRegistry } from '../unit/registry/temp-db.js';

const BASE = '/api/registry';

describe('доступ: Tailscale, ролі й токени', () => {
  let temp: TempRegistry;
  let app: Application;

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
    delete process.env.JULES_TRUST_TAILSCALE;
    temp.cleanup();
  });

  it('без облікових даних при JULES_REQUIRE_AUTH=1 відповідає 401', async () => {
    expect((await request(app).get(`${BASE}/projects`)).status).toBe(401);
  });

  it('людина з Tailscale через loopback проходить і отримує роль зі списків .env', async () => {
    const lead = await request(app).get(`${BASE}/me`).set('Tailscale-User-Login', 'lead@corp');
    expect(lead.status).toBe(200);
    expect(lead.body).toMatchObject({ login: 'lead@corp', role: 'admin', kind: 'person' });

    const qa = await request(app).get(`${BASE}/me`).set('Tailscale-User-Login', 'qa@corp');
    expect(qa.body.role).toBe('qa');

    const dev = await request(app).get(`${BASE}/me`).set('Tailscale-User-Login', 'dev@corp');
    expect(dev.body.role).toBe('dev');
  });

  it('автором змін стає логін Tailscale, а не підставлений X-Jules-User', async () => {
    const res = await request(app)
      .get(`${BASE}/me`)
      .set('Tailscale-User-Login', 'dev@corp')
      .set('X-Jules-User', 'someone-else');
    expect(res.body.author).toBe('dev@corp');
  });

  it('заголовок Tailscale ігнорується, якщо довіру вимкнено', async () => {
    process.env.JULES_TRUST_TAILSCALE = '0';
    const res = await request(app).get(`${BASE}/me`).set('Tailscale-User-Login', 'lead@corp');
    expect(res.status).toBe(401);
  });

  it('адмін змінює роль, а розробник — ні', async () => {
    await request(app).get(`${BASE}/me`).set('Tailscale-User-Login', 'dev@corp');
    const denied = await request(app)
      .patch(`${BASE}/users/dev@corp`)
      .set('Tailscale-User-Login', 'dev@corp')
      .send({ role: 'admin' });
    expect(denied.status).toBe(403);

    const ok = await request(app)
      .patch(`${BASE}/users/dev@corp`)
      .set('Tailscale-User-Login', 'lead@corp')
      .send({ role: 'qa' });
    expect(ok.status).toBe(200);
    expect(ok.body.role).toBe('qa');
  });

  it('токен CI бачить лише інжест і статус свого проєкту', async () => {
    const asLead = (r: request.Test) => r.set('Tailscale-User-Login', 'lead@corp');
    const project = await asLead(request(app).post(`${BASE}/projects`)).send({ key: 'CYBER', name: 'Кібер' });
    expect(project.status).toBe(201);

    const issued = await asLead(request(app).post(`${BASE}/tokens`)).send({
      name: 'CI cyber',
      role: 'ci',
      projectId: project.body.id,
    });
    expect(issued.status).toBe(201);
    expect(issued.body.token).toMatch(/^jqa_/);
    const token = issued.body.token as string;

    const own = await request(app).get(`${BASE}/projects/${project.body.id}`).set('Authorization', `Bearer ${token}`);
    expect(own.status).toBe(200);

    const forbidden = await request(app).get(`${BASE}/cases?projectId=${project.body.id}`).set('Authorization', `Bearer ${token}`);
    expect(forbidden.status).toBe(403);

    const list = await asLead(request(app).get(`${BASE}/tokens`));
    expect(list.body).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(token);

    const revoked = await asLead(request(app).delete(`${BASE}/tokens/${issued.body.record.id}`));
    expect(revoked.status).toBe(200);
    const after = await request(app).get(`${BASE}/projects/${project.body.id}`).set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(401);
  });

  it('розробник не може видати токен CI — 403', async () => {
    const res = await request(app)
      .post(`${BASE}/tokens`)
      .set('Tailscale-User-Login', 'dev@corp')
      .send({ name: 'хитрий', role: 'ci', projectId: 'x' });
    expect(res.status).toBe(403);
  });

  it('MCP-шлях захищений так само, як API', async () => {
    expect((await request(app).post('/mcp').send({})).status).toBe(401);
  });

  it('збірка CLI і health доступні без авторизації', async () => {
    expect((await request(app).get('/api/health')).status).toBe(200);
    expect([200, 404]).toContain((await request(app).get('/cli/jules-qa.mjs')).status);
  });
});

describe('налаштування проєкту зливаються, а не затираються', () => {
  let temp: TempRegistry;
  let app: Application;

  beforeEach(() => {
    temp = createTempRegistry();
    delete process.env.JULES_API_TOKEN;
    app = createApp();
  });

  afterEach(() => temp.cleanup());

  it('часткове оновлення settings не скидає решту полів до значень за замовчуванням', async () => {
    const project = (await request(app).post(`${BASE}/projects`).send({ key: 'CYBER', name: 'Кібер' })).body;
    await request(app)
      .patch(`${BASE}/projects/${project.id}`)
      .send({ settings: { confluenceRoots: ['229300000'], thresholds: { staleTaskHours: 12, leaseMinutes: 45, mutationP1: 70, flakeScore: 0.2 } } });

    const res = await request(app).patch(`${BASE}/projects/${project.id}`).send({ settings: { jira: { projectKey: 'CYB' } } });
    expect(res.status).toBe(200);
    expect(res.body.settings.confluenceRoots).toEqual(['229300000']);
    expect(res.body.settings.thresholds.staleTaskHours).toBe(12);
    expect(res.body.settings.jira).toMatchObject({ projectKey: 'CYB', issueType: 'Task' });
  });

  it('оновлення одного порога не скидає інші пороги', async () => {
    const project = (await request(app).post(`${BASE}/projects`).send({ key: 'CYBER', name: 'Кібер' })).body;
    await request(app).patch(`${BASE}/projects/${project.id}`).send({ settings: { thresholds: { leaseMinutes: 45 } } });
    const res = await request(app).patch(`${BASE}/projects/${project.id}`).send({ settings: { thresholds: { staleTaskHours: 12 } } });
    expect(res.body.settings.thresholds).toMatchObject({ leaseMinutes: 45, staleTaskHours: 12, mutationP1: 60 });
  });
});
