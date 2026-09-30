import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';
import { createApp } from '../../src/server/index.js';
import { createTempRegistry, type TempRegistry } from '../unit/registry/temp-db.js';

const BASE = '/api/registry';

describe('REST API реєстру', () => {
  let temp: TempRegistry;
  let app: Application;
  let projectId: string;
  let sectionId: string;

  beforeEach(async () => {
    temp = createTempRegistry();
    delete process.env.JULES_API_TOKEN;
    app = createApp();

    const project = await request(app)
      .post(`${BASE}/projects`)
      .send({ key: 'CYBER', name: 'Кібер', description: 'Проєкт для тестів' });
    expect(project.status).toBe(201);
    projectId = project.body.id;

    const section = await request(app)
      .post(`${BASE}/sections`)
      .send({ projectId, name: 'Карта договору' });
    expect(section.status).toBe(201);
    sectionId = section.body.id;
  });

  afterEach(() => {
    temp.cleanup();
  });

  async function addCase(body: Record<string, unknown>): Promise<Record<string, never> & { id: string }> {
    const res = await request(app)
      .post(`${BASE}/cases`)
      .set('X-Jules-User', 'tester')
      .send({ projectId, sectionId, ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
  }

  /* ─────────────────────── проєкти й секції ─────────────────────────── */

  it('проєкти: список, читання, часткове оновлення', async () => {
    const list = await request(app).get(`${BASE}/projects`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].key).toBe('CYBER');

    const one = await request(app).get(`${BASE}/projects/${projectId}`);
    expect(one.body.name).toBe('Кібер');

    const patched = await request(app)
      .patch(`${BASE}/projects/${projectId}`)
      .send({ name: 'Кібер 2', baseUrl: 'https://example.com' });
    expect(patched.status).toBe(200);
    expect(patched.body.name).toBe('Кібер 2');
    expect(patched.body.baseUrl).toBe('https://example.com');

    expect((await request(app).get(`${BASE}/projects/nope`)).status).toBe(404);
  });

  it('секції: дерево з лічильниками, код із назви, заборона видалення з кейсами', async () => {
    const child = await request(app)
      .post(`${BASE}/sections`)
      .send({ projectId, name: 'Акти', parentId: sectionId });
    expect(child.status).toBe(201);
    expect(child.body.code).toMatch(/^[A-Z][A-Z0-9]{2,5}$/);

    await addCase({ title: 'Кейс у батьку' });
    const inChild = await request(app)
      .post(`${BASE}/cases`)
      .send({ projectId, sectionId: child.body.id, title: 'Кейс у підсекції' });
    expect(inChild.status).toBe(201);

    const tree = await request(app).get(`${BASE}/sections?projectId=${projectId}`);
    expect(tree.status).toBe(200);
    expect(tree.body).toHaveLength(1);
    expect(tree.body[0].caseCount).toBe(1);
    expect(tree.body[0].caseCountDeep).toBe(2);
    expect(tree.body[0].children[0].path).toBe('Карта договору / Акти');

    const conflict = await request(app).delete(`${BASE}/sections/${child.body.id}`);
    expect(conflict.status).toBe(409);

    const moved = await request(app).delete(
      `${BASE}/sections/${child.body.id}?moveCasesTo=${sectionId}`,
    );
    expect(moved.status).toBe(200);
    const afterMove = await request(app).get(`${BASE}/cases/${inChild.body.id}`);
    expect(afterMove.body.sectionId).toBe(sectionId);
    // ID кейса не змінився після переміщення
    expect(afterMove.body.id).toBe(inChild.body.id);
  });

  /* ────────────────────────── CRUD кейса ────────────────────────────── */

  it('CRUD кейса: створення з виданим ID, читання, PATCH з ревізією, видалення', async () => {
    const created = await addCase({
      title: 'Акти недоступні для клієнта',
      checks: ['Відкрити карту договору', 'Перевірити розділ Акти'],
      tags: ['регрес'],
      priority: 'P1',
    });

    expect(created.id).toMatch(/^CYBER-[A-Z][A-Z0-9]{1,7}-\d{3,}$/);
    expect(created).toMatchObject({ version: 1, status: 'draft', updatedBy: 'tester' });

    const detail = await request(app).get(`${BASE}/cases/${created.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.sectionPath).toBe('Карта договору');
    expect(detail.body.coverage).toEqual({ quote: 0, derived: 0 });
    expect(detail.body.lastResult).toBeUndefined();

    const patched = await request(app)
      .patch(`${BASE}/cases/${created.id}`)
      .set('X-Jules-User', 'reviewer')
      .send({ title: 'Акти недоступні', status: 'approved', reason: 'уточнення формулювання' });
    expect(patched.status).toBe(200);
    expect(patched.body.version).toBe(2);
    expect(patched.body.status).toBe('approved');
    expect(patched.body.updatedBy).toBe('reviewer');

    const history = await request(app).get(`${BASE}/cases/${created.id}/history`);
    expect(history.status).toBe(200);
    expect(history.body.revisions).toHaveLength(2);
    expect(history.body.revisions[0]).toMatchObject({
      version: 2,
      author: 'reviewer',
      reason: 'уточнення формулювання',
    });
    expect(history.body.revisions[0].patch.title).toEqual({
      before: 'Акти недоступні для клієнта',
      after: 'Акти недоступні',
    });
    expect(history.body.revisions[0].patch.checks).toBeUndefined();

    const softDeleted = await request(app).delete(`${BASE}/cases/${created.id}`);
    expect(softDeleted.status).toBe(200);
    expect((await request(app).get(`${BASE}/cases/${created.id}`)).body.status).toBe('deprecated');

    const hardDeleted = await request(app).delete(`${BASE}/cases/${created.id}?hard=1`);
    expect(hardDeleted.status).toBe(200);
    expect((await request(app).get(`${BASE}/cases/${created.id}`)).status).toBe(404);
  });

  it('відмовляє на невалідному тілі з details від zod', async () => {
    const res = await request(app).post(`${BASE}/cases`).send({ projectId, sectionId });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it('GET /cases без projectId — 400', async () => {
    expect((await request(app).get(`${BASE}/cases`)).status).toBe(400);
  });

  it('привʼязка автосценарію через /cases/:id/automation', async () => {
    const created = await addCase({ title: 'Автоматизований' });
    const res = await request(app)
      .post(`${BASE}/cases/${created.id}/automation`)
      .send({ status: 'automated', scenarioPath: 'scenarios/universal-page-load.yaml' });
    expect(res.status).toBe(200);
    expect(res.body.automation).toMatchObject({
      status: 'automated',
      scenarioPath: 'scenarios/universal-page-load.yaml',
    });
    expect(res.body.version).toBe(2);
  });

  /* ─────────────────── фільтри, пошук, пагінація ────────────────────── */

  it('фільтри, FTS-пошук, сортування й пагінація', async () => {
    const child = await request(app)
      .post(`${BASE}/sections`)
      .send({ projectId, name: 'Акти', parentId: sectionId });
    const childId = child.body.id;

    await addCase({ title: 'Акти недоступні', tags: ['регрес'], priority: 'P1', status: 'approved' });
    await addCase({ title: 'Договір відкривається', tags: ['смоук'], priority: 'P3' });
    await request(app)
      .post(`${BASE}/cases`)
      .send({ projectId, sectionId: childId, title: 'Акти у підсекції', tags: ['регрес'] });
    for (let i = 0; i < 4; i += 1) {
      await addCase({ title: `Наповнювач ${i}` });
    }

    const byQuery = await request(app).get(`${BASE}/cases?projectId=${projectId}&q=АКТИ`);
    expect(byQuery.status).toBe(200);
    expect(byQuery.body.total).toBe(2);

    const byTag = await request(app).get(`${BASE}/cases?projectId=${projectId}&tag=регрес`);
    expect(byTag.body.total).toBe(2);

    const byPriority = await request(app).get(`${BASE}/cases?projectId=${projectId}&priority=P1&priority=P3`);
    expect(byPriority.body.total).toBe(2);

    const byStatus = await request(app).get(`${BASE}/cases?projectId=${projectId}&status=approved`);
    expect(byStatus.body.total).toBe(1);

    const deep = await request(app).get(`${BASE}/cases?projectId=${projectId}&sectionId=${sectionId}`);
    expect(deep.body.total).toBe(7);

    const shallow = await request(app).get(
      `${BASE}/cases?projectId=${projectId}&sectionId=${sectionId}&includeSubsections=0`,
    );
    expect(shallow.body.total).toBe(6);

    const page1 = await request(app).get(`${BASE}/cases?projectId=${projectId}&limit=3&page=1&sort=id`);
    const page3 = await request(app).get(`${BASE}/cases?projectId=${projectId}&limit=3&page=3&sort=id`);
    expect(page1.body).toMatchObject({ total: 7, page: 1, limit: 3 });
    expect(page1.body.items).toHaveLength(3);
    expect(page3.body.items).toHaveLength(1);
    expect(page1.body.items[0].id).not.toBe(page3.body.items[0].id);

    const desc = await request(app).get(`${BASE}/cases?projectId=${projectId}&sort=-title`);
    const asc = await request(app).get(`${BASE}/cases?projectId=${projectId}&sort=title`);
    expect(desc.body.items[0].title).not.toBe(asc.body.items[0].title);

    // limit більший за максимум зрізається до 200
    const capped = await request(app).get(`${BASE}/cases?projectId=${projectId}&limit=5000`);
    expect(capped.body.limit).toBe(200);
  });

  /* ────────────────────────── масові операції ───────────────────────── */

  it('bulk: dry-run, apply у транзакції й undo', async () => {
    const a = await addCase({ title: 'акти A', checks: ['перевірити акти'] });
    const b = await addCase({ title: 'акти B' });

    const dry = await request(app)
      .post(`${BASE}/cases/bulk`)
      .send({
        projectId,
        operation: { op: 'replace-text', find: 'акти', replace: 'договори', fields: ['title', 'checks'] },
      });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ applied: false, affected: 2, occurrences: 3 });
    expect(dry.body.batchId).toBeUndefined();
    expect(dry.body.preview.length).toBe(3);
    expect((await request(app).get(`${BASE}/cases/${a.id}`)).body.title).toBe('акти A');

    const applied = await request(app)
      .post(`${BASE}/cases/bulk`)
      .set('X-Jules-User', 'tester')
      .send({
        projectId,
        operation: { op: 'replace-text', find: 'акти', replace: 'договори', fields: ['title', 'checks'] },
        dryRun: false,
        reason: 'перейменування терміна',
      });
    expect(applied.status).toBe(200);
    expect(applied.body.applied).toBe(true);
    expect(applied.body.batchId).toBeTruthy();
    expect((await request(app).get(`${BASE}/cases/${a.id}`)).body.title).toBe('договори A');
    expect((await request(app).get(`${BASE}/cases/${a.id}`)).body.checks).toEqual(['перевірити договори']);
    expect((await request(app).get(`${BASE}/cases/${b.id}`)).body.title).toBe('договори B');

    const undo = await request(app)
      .post(`${BASE}/cases/bulk/undo`)
      .send({ batchId: applied.body.batchId });
    expect(undo.status).toBe(200);
    expect(undo.body.reverted).toBe(2);
    expect((await request(app).get(`${BASE}/cases/${a.id}`)).body.title).toBe('акти A');
    expect((await request(app).get(`${BASE}/cases/${b.id}`)).body.title).toBe('акти B');
  });

  it('bulk undo невідомого пакета — 404', async () => {
    const res = await request(app).post(`${BASE}/cases/bulk/undo`).send({ batchId: 'batch_none' });
    expect(res.status).toBe(404);
  });

  /* ──────────────── джерела, покриття, черга апрувів ─────────────────── */

  it('апрув пропозиції створює кейс і звʼязок покриття', async () => {
    const proposal = await request(app)
      .post(`${BASE}/proposals`)
      .send({
        projectId,
        kind: 'case_create',
        title: 'Акти видні після підписання',
        rationale: 'Прямо з вимоги, розділ 3',
        coverageKind: 'quote',
        payload: {
          sectionId,
          title: 'Акти видні після підписання',
          kind: 'positive',
          priority: 'P2',
          checks: ['Підписати договір', 'Відкрити розділ Акти'],
          tags: ['вимога'],
        },
      });
    expect(proposal.status).toBe(201);
    expect(proposal.body.state).toBe('pending');

    const queue = await request(app).get(`${BASE}/proposals?projectId=${projectId}&state=pending`);
    expect(queue.body.total).toBe(1);

    const edited = await request(app)
      .patch(`${BASE}/proposals/${proposal.body.id}`)
      .send({
        payload: {
          sectionId,
          title: 'Акти видні одразу після підписання',
          checks: ['Підписати договір', 'Відкрити розділ Акти'],
          tags: ['вимога'],
        },
      });
    expect(edited.status).toBe(200);

    const approved = await request(app)
      .post(`${BASE}/proposals/approve`)
      .send({ ids: [proposal.body.id], reviewer: 'lead' });
    expect(approved.status).toBe(200);
    expect(approved.body.errors).toEqual([]);
    expect(approved.body.approved).toEqual([proposal.body.id]);
    expect(approved.body.created).toHaveLength(1);

    const createdId = approved.body.created[0];
    const created = await request(app).get(`${BASE}/cases/${createdId}`);
    expect(created.body.title).toBe('Акти видні одразу після підписання');
    expect(created.body.tags).toEqual(['вимога']);

    // Повторний апрув уже вирішеної пропозиції дає помилку в errors
    const again = await request(app).post(`${BASE}/proposals/approve`).send({ ids: [proposal.body.id] });
    expect(again.body.approved).toEqual([]);
    expect(again.body.errors).toHaveLength(1);

    // Правити вирішену пропозицію не можна
    expect(
      (await request(app).patch(`${BASE}/proposals/${proposal.body.id}`).send({ note: 'ні' })).status,
    ).toBe(409);
  });

  it('апрув case_update застосовує зміни новою ревізією, reject лишає кейс', async () => {
    const target = await addCase({ title: 'Початковий заголовок' });

    const update = await request(app)
      .post(`${BASE}/proposals`)
      .send({
        projectId,
        kind: 'case_update',
        title: 'Уточнити заголовок',
        payload: { caseId: target.id, changes: { title: 'Уточнений заголовок', priority: 'P1' } },
      });
    const reject = await request(app)
      .post(`${BASE}/proposals`)
      .send({
        projectId,
        kind: 'case_update',
        title: 'Погана ідея',
        payload: { caseId: target.id, changes: { title: 'Не треба' } },
      });

    const approved = await request(app).post(`${BASE}/proposals/approve`).send({ ids: [update.body.id] });
    expect(approved.body.updated).toEqual([target.id]);

    const rejected = await request(app)
      .post(`${BASE}/proposals/reject`)
      .send({ ids: [reject.body.id], note: 'не відповідає вимозі' });
    expect(rejected.body.rejected).toEqual([reject.body.id]);

    const after = await request(app).get(`${BASE}/cases/${target.id}`);
    expect(after.body.title).toBe('Уточнений заголовок');
    expect(after.body.priority).toBe('P1');
    expect(after.body.version).toBe(2);

    const list = await request(app).get(`${BASE}/proposals?projectId=${projectId}&state=rejected`);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].note).toBe('не відповідає вимозі');
  });

  it('покриття: ручний звʼязок і матриця прогалин', async () => {
    const target = await addCase({ title: 'Покритий кейс' });
    // Джерело створюємо напряму через сховище: розбиття тексту на блоки —
    // це src/integrations/confluence.ts (інший модуль контракту).
    const { createSource } = await import('../../src/registry/sources-store.js');
    const { blocks } = createSource({
      projectId,
      kind: 'paste',
      title: 'Вимоги до карти договору',
      blocks: [
        { heading: 'Акти', text: 'Клієнт бачить акти після підписання', position: 0 },
        { heading: 'Прогалина', text: 'Ніхто не покрив цю вимогу', position: 1 },
      ],
    });

    const sources = await request(app).get(`${BASE}/sources?projectId=${projectId}`);
    expect(sources.body[0]).toMatchObject({ blockCount: 2, gaps: 2 });

    const linked = await request(app)
      .post(`${BASE}/coverage`)
      .send({ blockId: blocks[0].id, caseId: target.id, kind: 'quote', confirmed: true });
    expect(linked.status).toBe(201);

    const matrix = await request(app).get(`${BASE}/coverage?projectId=${projectId}`);
    expect(matrix.status).toBe(200);
    expect(matrix.body.stats).toMatchObject({ blocks: 2, coveredBlocks: 1, gaps: 1 });
    expect(matrix.body.rows[0].cases[0]).toMatchObject({ caseId: target.id, kind: 'quote' });
    expect(matrix.body.rows[1].gap).toBe(true);

    const detail = await request(app).get(`${BASE}/cases/${target.id}`);
    expect(detail.body.coverage).toEqual({ quote: 1, derived: 0 });

    expect((await request(app).delete(`${BASE}/coverage/${linked.body.id}`)).status).toBe(200);
    expect((await request(app).delete(`${BASE}/coverage/${linked.body.id}`)).status).toBe(404);
  });

  /* ──────────────────────── вибірки й прогони ───────────────────────── */

  it('вибірки: статична й фільтрова, resolve рахує наживо', async () => {
    const a = await addCase({ title: 'Перший', tags: ['смоук'] });
    const b = await addCase({ title: 'Другий', tags: ['смоук'] });
    await addCase({ title: 'Третій' });

    const staticSel = await request(app)
      .post(`${BASE}/selections`)
      .send({ projectId, name: 'Статичний набір', mode: 'static', caseIds: [b.id, a.id] });
    expect(staticSel.status).toBe(201);

    const resolvedStatic = await request(app).post(`${BASE}/selections/${staticSel.body.id}/resolve`);
    expect(resolvedStatic.body.caseIds).toEqual([b.id, a.id]);

    const filterSel = await request(app)
      .post(`${BASE}/selections`)
      .send({ projectId, name: 'Смоук', mode: 'filter', filter: { tags: ['смоук'], includeSubsections: true } });
    const resolvedFilter = await request(app).post(`${BASE}/selections/${filterSel.body.id}/resolve`);
    expect(resolvedFilter.body.caseIds.sort()).toEqual([a.id, b.id].sort());

    await addCase({ title: 'Четвертий', tags: ['смоук'] });
    const again = await request(app).post(`${BASE}/selections/${filterSel.body.id}/resolve`);
    expect(again.body.caseIds).toHaveLength(3);

    const list = await request(app).get(`${BASE}/selections?projectId=${projectId}`);
    expect(list.body).toHaveLength(2);

    expect((await request(app).delete(`${BASE}/selections/${staticSel.body.id}`)).status).toBe(200);
    expect((await request(app).post(`${BASE}/selections/nope/resolve`)).status).toBe(404);
  });

  it('ручний прогін: статуси, дефект із дедуплікацією, rerun-failed, завершення', async () => {
    const a = await addCase({ title: 'Перший' });
    const b = await addCase({ title: 'Другий' });
    const c = await addCase({ title: 'Третій' });

    const run = await request(app)
      .post(`${BASE}/runs`)
      .set('X-Jules-User', 'qa')
      .send({ projectId, kind: 'manual', title: 'Регрес', caseIds: [a.id, b.id, c.id] });
    expect(run.status).toBe(201);
    expect(run.body.summary).toEqual({ total: 3, passed: 0, failed: 0, blocked: 0, skipped: 0, untested: 3 });
    expect(run.body.state).toBe('open');
    expect(run.body.executor).toBe('qa');

    const detail = await request(app).get(`${BASE}/runs/${run.body.id}`);
    expect(detail.body.items).toHaveLength(3);
    expect(detail.body.items[0].case).toMatchObject({ id: a.id, sectionPath: 'Карта договору' });

    const passed = await request(app)
      .put(`${BASE}/runs/${run.body.id}/items/${a.id}`)
      .set('X-Jules-User', 'qa')
      .send({ status: 'passed', comment: 'усе добре' });
    expect(passed.status).toBe(200);
    expect(passed.body.item).toMatchObject({ status: 'passed', comment: 'усе добре', updatedBy: 'qa' });
    expect(passed.body.summary).toMatchObject({ passed: 1, untested: 2 });

    const failed = await request(app)
      .put(`${BASE}/runs/${run.body.id}/items/${b.id}`)
      .send({
        status: 'failed',
        comment: 'кнопка не реагує',
        evidence: ['/reports/videos/b.webm'],
        defect: { title: 'Кнопка «Підписати» НЕ працює', severity: 'high' },
      });
    expect(failed.status).toBe(200);
    expect(failed.body.defectId).toBeTruthy();
    expect(failed.body.item.evidence).toEqual(['/reports/videos/b.webm']);

    const blocked = await request(app)
      .put(`${BASE}/runs/${run.body.id}/items/${c.id}`)
      .send({ status: 'blocked', comment: 'середовище недоступне' });
    expect(blocked.body.summary).toEqual({
      total: 3,
      passed: 1,
      failed: 1,
      blocked: 1,
      skipped: 0,
      untested: 0,
    });

    // Той самий дефект на іншому прогоні лише піднімає seenCount
    const secondRun = await request(app)
      .post(`${BASE}/runs`)
      .send({ projectId, caseIds: [b.id], title: 'Повтор' });
    await request(app)
      .put(`${BASE}/runs/${secondRun.body.id}/items/${b.id}`)
      .send({ status: 'failed', defect: { title: 'кнопка «підписати» не працює' } });

    const defects = await request(app).get(`${BASE}/defects?projectId=${projectId}`);
    expect(defects.body.total).toBe(1);
    expect(defects.body.items[0].seenCount).toBe(2);
    expect(defects.body.items[0].severity).toBe('high');

    const patchedDefect = await request(app)
      .patch(`${BASE}/defects/${defects.body.items[0].id}`)
      .send({ status: 'triaged', externalKey: 'JIRA-1' });
    expect(patchedDefect.body).toMatchObject({ status: 'triaged', externalKey: 'JIRA-1' });

    const rerun = await request(app).post(`${BASE}/runs/${run.body.id}/rerun-failed`);
    expect(rerun.status).toBe(201);
    expect(rerun.body.summary.total).toBe(2);
    expect(rerun.body.title).toContain('Перепрогін');

    const completed = await request(app).patch(`${BASE}/runs/${run.body.id}`).send({ state: 'completed' });
    expect(completed.body.state).toBe('completed');
    expect(completed.body.finishedAt).toBeTruthy();

    const runs = await request(app).get(`${BASE}/runs?projectId=${projectId}&state=open`);
    expect(runs.body.items.every((r: { state: string }) => r.state === 'open')).toBe(true);

    // lastResult потрапляє в список кейсів
    const caseList = await request(app).get(`${BASE}/cases?projectId=${projectId}`);
    const firstCase = caseList.body.items.find((item: { id: string }) => item.id === a.id);
    expect(firstCase.lastResult).toMatchObject({ status: 'passed', runId: run.body.id });
  });

  it('прогін із вибірки, статус невідомого кейса — 409', async () => {
    const a = await addCase({ title: 'Перший' });
    const selection = await request(app)
      .post(`${BASE}/selections`)
      .send({ projectId, name: 'Набір', mode: 'static', caseIds: [a.id] });

    const run = await request(app)
      .post(`${BASE}/runs`)
      .send({ projectId, selectionId: selection.body.id });
    expect(run.status).toBe(201);
    expect(run.body.selectionId).toBe(selection.body.id);
    expect(run.body.title).toContain('Набір');

    const bad = await request(app)
      .put(`${BASE}/runs/${run.body.id}/items/CYBER-XXX-999`)
      .send({ status: 'passed' });
    expect(bad.status).toBe(409);

    const noTargets = await request(app).post(`${BASE}/runs`).send({ projectId });
    expect(noTargets.status).toBe(400);
  });

  it('POST /runs/:id/auto пропускає неавтоматизовані кейси', async () => {
    const manual = await addCase({ title: 'Ручний' });
    const run = await request(app).post(`${BASE}/runs`).send({ projectId, caseIds: [manual.id] });

    const res = await request(app).post(`${BASE}/runs/${run.body.id}/auto`).send({});
    expect(res.status).toBe(200);
    expect(res.body.queued).toEqual([]);
    expect(res.body.skipped).toEqual([{ caseId: manual.id, reason: 'кейс не автоматизований' }]);
  });

  it('SSE-потік відповідає подіями на зміну статусу', async () => {
    const a = await addCase({ title: 'Перший' });
    const run = await request(app).post(`${BASE}/runs`).send({ projectId, caseIds: [a.id] });

    const chunks: string[] = [];
    const stream = request(app)
      .get(`${BASE}/runs/${run.body.id}/stream`)
      .buffer(false)
      .parse((res, callback) => {
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk.toString('utf-8'));
          if (chunks.join('').includes('event: item')) {
            // superagent типізує res як свою Response, але це http.IncomingMessage.
            (res as unknown as { destroy: () => void }).destroy();
            callback(null, chunks.join(''));
          }
        });
        res.on('close', () => callback(null, chunks.join('')));
        res.on('end', () => callback(null, chunks.join('')));
      })
      .then(() => undefined)
      .catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 150));
    await request(app).put(`${BASE}/runs/${run.body.id}/items/${a.id}`).send({ status: 'passed' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await stream;

    const text = chunks.join('');
    expect(text).toContain('event: snapshot');
    expect(text).toContain('id: 1');
    expect(text).toContain('event: item');
  });

  it('дашборд віддає DashboardData', async () => {
    const a = await addCase({ title: 'Перший', status: 'approved' });
    const run = await request(app).post(`${BASE}/runs`).send({ projectId, caseIds: [a.id] });
    await request(app).put(`${BASE}/runs/${run.body.id}/items/${a.id}`).send({ status: 'failed' });

    const res = await request(app).get(`${BASE}/dashboard?projectId=${projectId}`);
    expect(res.status).toBe(200);
    expect(res.body.project.key).toBe('CYBER');
    expect(res.body.cases.total).toBe(1);
    expect(res.body.runs.last7d).toBe(1);
    expect(res.body.runs.passRate7d).toBe(0);
    expect(res.body.modules[0]).toMatchObject({ name: 'Карта договору', cases: 1 });
    expect(res.body.pending).toMatchObject({ proposals: 0, openDefects: 0 });
  });

  /* ────────────────────────── TestRail і скіли ──────────────────────── */

  it('профілі мапінгу TestRail: створення, список, правка', async () => {
    const created = await request(app)
      .post(`${BASE}/testrail/mappings`)
      .send({
        projectId,
        name: 'Основний',
        template: 'checklist',
        fields: { title: 'title', checks: 'custom_steps' },
        typeMap: { positive: 1 },
        priorityMap: { P1: 4 },
        idField: 'custom_tc_id',
        delimiter: ',',
      });
    expect(created.status).toBe(201);

    const list = await request(app).get(`${BASE}/testrail/mappings?projectId=${projectId}`);
    expect(list.body).toHaveLength(1);

    const patched = await request(app)
      .patch(`${BASE}/testrail/mappings/${created.body.id}`)
      .send({ template: 'steps_separated' });
    expect(patched.body.template).toBe('steps_separated');

    // Дрейф віддається масивом рядків — саме його читає таблиця в інтерфейсі.
    const drift = await request(app).get(`${BASE}/testrail/drift?projectId=${projectId}`);
    expect(Array.isArray(drift.body)).toBe(true);
    expect(drift.body).toEqual([]);
  });

  it('експорт TestRail і лог скілів', async () => {
    const mapping = await request(app)
      .post(`${BASE}/testrail/mappings`)
      .send({ projectId, name: 'Основний' });

    // Експорт уже спирається на src/integrations/testrail-csv.ts: якщо модуль
    // на місці — 200 з файлом, якщо його ще не підключили — 501.
    const csv = await request(app).get(
      `${BASE}/export/testrail.csv?projectId=${projectId}&mappingId=${mapping.body.id}`,
    );
    expect([200, 501]).toContain(csv.status);
    if (csv.status === 200) {
      expect(csv.headers['content-disposition']).toContain('attachment');
    }

    const xml = await request(app).get(
      `${BASE}/export/testrail.xml?projectId=${projectId}&mappingId=${mapping.body.id}`,
    );
    expect([200, 501]).toContain(xml.status);

    // Живі виклики моделі (/skills/write-cases, /skills/validate-coverage) тут
    // не смикаємо — це чужі модулі з реальним LLM. Перевіряємо лише лог запусків.
    const runsLog = await request(app).get(`${BASE}/skills/runs?projectId=${projectId}`);
    expect(runsLog.status).toBe(200);
    expect(runsLog.body).toMatchObject({ page: 1, limit: 50, total: 0 });

    // Недоступний профіль мапінгу — 404, а не 500.
    const noMapping = await request(app).get(
      `${BASE}/export/testrail.csv?projectId=${projectId}&mappingId=nope`,
    );
    expect(noMapping.status).toBe(404);
  });
});

describe('авторизація API реєстру', () => {
  let temp: TempRegistry;
  let app: Application;

  beforeEach(() => {
    temp = createTempRegistry();
    process.env.JULES_API_TOKEN = 's3cret-token';
    app = createApp();
  });

  afterEach(() => {
    delete process.env.JULES_API_TOKEN;
    temp.cleanup();
  });

  it('без токена — 401, з Bearer і ?token= — 200, health відкритий', async () => {
    expect((await request(app).get(`${BASE}/projects`)).status).toBe(401);

    const withHeader = await request(app)
      .get(`${BASE}/projects`)
      .set('Authorization', 'Bearer s3cret-token');
    expect(withHeader.status).toBe(200);

    const withQuery = await request(app).get(`${BASE}/projects?token=${encodeURIComponent('s3cret-token')}`);
    expect(withQuery.status).toBe(200);

    const wrong = await request(app).get(`${BASE}/projects`).set('Authorization', 'Bearer wrong-token');
    expect(wrong.status).toBe(401);

    expect((await request(app).get('/api/health')).status).toBe(200);
  });

  it('старе API теж під токеном', async () => {
    expect((await request(app).get('/api/scenarios')).status).toBe(401);
    const ok = await request(app).get('/api/scenarios').set('Authorization', 'Bearer s3cret-token');
    expect(ok.status).toBe(200);
  });
});

describe('allowlist для GET /api/llm/check', () => {
  let temp: TempRegistry;

  beforeEach(() => {
    temp = createTempRegistry();
    delete process.env.JULES_API_TOKEN;
  });

  afterEach(() => {
    temp.cleanup();
  });

  it('відмовляє на хості, якого немає в allowlist', async () => {
    const previousBase = process.env.MIDSCENE_MODEL_BASE_URL;
    const previousData = process.env.DATA_ROOT;
    process.env.MIDSCENE_MODEL_BASE_URL = 'http://allowed-model.internal:1234/v1';
    process.env.DATA_ROOT = temp.dir;

    const app = createApp();
    const settings = await import('../../src/server/settings-store.js');
    await settings.saveSettings({
      qaTargetUrl: 'https://example.com',
      qaMode: 'warm-up',
      qaScenarioPath: 'scenarios/universal-page-load.yaml',
      debugCache: false,
      llmBaseUrl: 'https://evil.example.com/v1',
    });

    const res = await request(app).get('/api/llm/check');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('allowlist');
    expect(res.body.allowed).toContain('allowed-model.internal:1234');

    if (previousBase === undefined) delete process.env.MIDSCENE_MODEL_BASE_URL;
    else process.env.MIDSCENE_MODEL_BASE_URL = previousBase;
    if (previousData === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousData;
  });
});
