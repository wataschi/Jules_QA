import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';
import { createApp } from '../../src/server/index.js';
import { createTempRegistry, type TempRegistry } from '../unit/registry/temp-db.js';

const BASE = '/api/registry';

/** Виклик MCP-інструмента через Streamable HTTP (режим без сесій, JSON-відповідь). */
async function mcpCall(app: Application, name: string, args: Record<string, unknown>, login = 'dev@corp') {
  const res = await request(app)
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json')
    .set('X-Jules-User', login)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  expect(res.status).toBe(200);
  const result = res.body.result as { content: Array<{ type: string; text?: string }>; isError?: boolean };
  const text = result.content.find((item) => item.type === 'text')?.text ?? '';
  if (result.isError) return { error: text };
  return { value: JSON.parse(text), content: result.content };
}

function result(name: string, caseIds: string[], status: 'passed' | 'failed' | 'skipped', extra: Record<string, unknown> = {}) {
  return {
    key: `${name}`.padEnd(16, '0').slice(0, 16),
    file: 'tests/acts.test.ts',
    name,
    fullName: `Акти > ${name}`,
    status,
    framework: 'vitest',
    caseIds,
    level: 'unit',
    ...extra,
  };
}

describe('цикл «QA направляє, агент робить» через API і MCP', () => {
  let temp: TempRegistry;
  let app: Application;
  let projectId: string;
  let sectionId: string;
  let caseId: string;

  beforeEach(async () => {
    temp = createTempRegistry();
    delete process.env.JULES_API_TOKEN;
    app = createApp();
    projectId = (await request(app).post(`${BASE}/projects`).send({ key: 'CYBER', name: 'Кібер' })).body.id;
    sectionId = (await request(app).post(`${BASE}/sections`).send({ projectId, name: 'Акти', code: 'AKT' })).body.id;
    await request(app).patch(`${BASE}/sections/${sectionId}`).send({ paths: ['src/acts/**', 'tests/acts*'], owners: ['dev@corp'] });
    caseId = (
      await request(app)
        .post(`${BASE}/cases`)
        .send({ projectId, sectionId, title: 'Акт без суми не зберігається', status: 'approved', priority: 'P1', checks: ['Поле суми підсвічене'] })
    ).body.id;
  });

  afterEach(() => temp.cleanup());

  it('проводить запит QA від задачі до злиття PR і статусу кейса', async () => {
    const created = await request(app)
      .post(`${BASE}/tasks`)
      .send({ projectId, kind: 'add_test', title: 'Акт без суми не має зберігатися', anchor: { caseId } });
    expect(created.status).toBe(201);
    const taskId = created.body.id as string;
    expect(created.body.sectionId).toBe(sectionId);
    expect(created.body.owners).toEqual(['dev@corp']);

    const inbox = await mcpCall(app, 'qa_inbox', { paths: ['src/acts/form.ts'] });
    expect(inbox.value.tasks[0]).toMatchObject({ id: taskId, mine: true, touched: true });

    const claimed = await mcpCall(app, 'qa_claim', { taskId, agent: 'claude-code', model: 'model-x' });
    expect(claimed.value.task.state).toBe('claimed');
    expect(claimed.value.context.case.id).toBe(caseId);
    expect(claimed.value.context.notice).toMatch(/не інструкції/);

    const noPr = await mcpCall(app, 'qa_report', { taskId, summary: 'готово' });
    expect(noPr.error).toMatch(/PR/);

    const reported = await mcpCall(app, 'qa_report', {
      taskId,
      summary: 'Тест на акт без суми',
      checks: ['Форма не зберігається', 'Поле суми підсвічене червоним'],
      tests: [{ file: 'tests/acts.test.ts', name: `${caseId} акт без суми`, caseIds: [caseId] }],
      prUrl: 'https://github.com/acme/app/pull/12',
      branch: 'qa/req-1',
    });
    expect(reported.value.task.state).toBe('review');

    const ingest = await request(app)
      .post(`${BASE}/ingest/run`)
      .send({
        projectId,
        sha: 'abc1234def',
        branch: 'qa/req-1',
        prNumber: 12,
        event: 'pr',
        results: [result(`${caseId} акт без суми`, [caseId], 'passed'), result('без кейса', [], 'passed')],
        assertionChanges: [{ file: 'tests/old.test.ts', line: 10, before: 'expect(sum).toBe(0)', kind: 'removed' }],
      });
    expect(ingest.status).toBe(201);
    expect(ingest.body).toMatchObject({ tests: 2, failed: 0, unknownCases: [] });

    const comment = await request(app).get(`${BASE}/pr-comment.md?projectId=${projectId}&prNumber=12`);
    expect(comment.status).toBe(200);
    expect(comment.text.split('\n')[0]).toBe('<!-- jules-qa -->');
    expect(comment.text).toContain(caseId);
    expect(comment.text).toContain('qa:assertion-change');

    const tests = await request(app).get(`${BASE}/tests?projectId=${projectId}&caseId=${caseId}`);
    expect(tests.body.items[0]).toMatchObject({ author: 'agent', caseIds: [caseId] });

    expect((await request(app).post(`${BASE}/tasks/${taskId}/confirm`)).body.state).toBe('review');
    const merged = await request(app).post(`${BASE}/ingest/pr-event`).send({ projectId, prNumber: 12, state: 'merged' });
    expect(merged.body.tasksUpdated).toBe(1);

    const main = await request(app)
      .post(`${BASE}/ingest/run`)
      .send({ projectId, sha: 'fff0000aaa', branch: 'main', event: 'main', results: [result(`${caseId} акт без суми`, [caseId], 'passed')] });
    expect(main.status).toBe(201);

    const detail = await request(app).get(`${BASE}/tasks/${taskId}`);
    expect(detail.body.task.state).toBe('done');
    const caseDetail = await request(app).get(`${BASE}/cases/${caseId}`);
    expect(caseDetail.body.automation.status).toBe('automated');

    const status = await request(app).get(`${BASE}/status.md?projectId=${projectId}`);
    expect(status.text).toContain('# Стан тестування · main @ fff0000');
    expect(status.text).toContain('Акти');
  });

  it('червоне на main дає задачу розбору, а розбір «баг продукту» — дефект', async () => {
    const main = await request(app)
      .post(`${BASE}/ingest/run`)
      .send({
        projectId,
        sha: '1234567aaa',
        branch: 'main',
        event: 'main',
        results: [result(`${caseId} падає`, [caseId], 'failed', { error: 'expected 400, got 200' })],
      });
    expect(main.body.tasks).toHaveLength(1);
    const triageId = main.body.tasks[0] as string;

    const again = await request(app)
      .post(`${BASE}/ingest/run`)
      .send({ projectId, sha: '1234567bbb', branch: 'main', event: 'main', results: [result(`${caseId} падає`, [caseId], 'failed')] });
    expect(again.body.tasks).toHaveLength(0);

    const status = await request(app).get(`${BASE}/status.md?projectId=${projectId}`);
    expect(status.text).toContain('Впали');

    await mcpCall(app, 'qa_claim', { taskId: triageId });
    const withoutClass = await mcpCall(app, 'qa_report', { taskId: triageId, summary: 'бекенд пропускає порожню суму' });
    expect(withoutClass.error).toMatch(/classification/);
    const reported = await mcpCall(app, 'qa_report', {
      taskId: triageId,
      summary: 'Бекенд пропускає порожню суму',
      triage: { classification: 'product_bug', severity: 'high' },
    });
    expect(reported.value.effects.defectId).toBeTruthy();
    const defects = await request(app).get(`${BASE}/defects?projectId=${projectId}`);
    expect(defects.body.items[0]).toMatchObject({ caseId, severity: 'high' });
  });

  it('план модуля: агент пропонує кейси, погодження створює задачі на тести й закриває план', async () => {
    const plan = await request(app)
      .post(`${BASE}/tasks`)
      .send({ projectId, kind: 'plan_module', title: 'Спланувати модуль Акти', anchor: { sectionId } });
    const planId = plan.body.id as string;
    await mcpCall(app, 'qa_claim', { taskId: planId });
    const proposed = await mcpCall(app, 'qa_propose_plan', {
      taskId: planId,
      summary: 'Інвентар: форма акта, API /acts',
      cases: [
        { title: 'Акт із сумою 0 — форма не зберігається', checks: ['Під полем суми текст «Сума має бути більшою за 0»'], priority: 'P1', kind: 'negative' },
        { title: 'Акт чужого контрагента недоступний за прямим URL', checks: ['Відповідь 403'], kind: 'security' },
        { title: 'Перевірка функціоналу', checks: ['працює нормально'] },
      ],
    });
    expect(proposed.value.proposals).toBe(2);
    expect(proposed.value.task.state).toBe('review');

    const pending = await request(app).get(`${BASE}/proposals?projectId=${projectId}&state=pending`);
    const ids = pending.body.items.map((item: { id: string }) => item.id);
    const approved = await request(app).post(`${BASE}/proposals/approve`).send({ ids });
    expect(approved.body.created).toHaveLength(2);
    expect(approved.body.tasks).toHaveLength(2);

    const planTask = await request(app).get(`${BASE}/tasks/${planId}`);
    expect(planTask.body.task.state).toBe('done');
    const addTests = await request(app).get(`${BASE}/tasks?projectId=${projectId}&kind=add_test`);
    expect(addTests.body.total).toBe(2);
  });

  it('резерв ID дає чернетку, а відхилення QA — застарілий кейс', async () => {
    const reserved = await request(app).post(`${BASE}/cases/reserve`).send({ projectId, section: 'AKT', title: 'Акт без дати' });
    expect(reserved.status).toBe(201);
    expect(reserved.body.caseId).toMatch(/^CYBER-AKT-\d{3}$/);
    const draft = await request(app).get(`${BASE}/cases/${reserved.body.caseId}`);
    expect(draft.body.status).toBe('draft');

    await request(app).post(`${BASE}/proposals/reject`).send({ ids: [reserved.body.proposalId], note: 'не потрібно' });
    const after = await request(app).get(`${BASE}/cases/${reserved.body.caseId}`);
    expect(after.body.status).toBe('deprecated');
  });

  it('пуш у main повз PR позначається, а через PR — ні', async () => {
    const direct = await request(app).post(`${BASE}/ingest/push-check`).send({ projectId, sha: 'aaaaaaa1', branch: 'main', viaPr: false, author: 'dev' });
    expect(direct.body.flagged).toBe(true);
    const viaPr = await request(app).post(`${BASE}/ingest/push-check`).send({ projectId, sha: 'aaaaaaa2', branch: 'main', viaPr: true, prNumbers: [3] });
    expect(viaPr.body.flagged).toBe(false);
    const list = await request(app).get(`${BASE}/push-checks?projectId=${projectId}`);
    expect(list.body.map((item: { sha: string }) => item.sha)).toEqual(['aaaaaaa1']);
    const status = await request(app).get(`${BASE}/status.md?projectId=${projectId}`);
    expect(status.text).toContain('aaaaaaa');
  });

  it('зведення для дашборда рахує задачі, трасування й тести', async () => {
    await request(app).post(`${BASE}/tasks`).send({ projectId, kind: 'add_test', title: 'x', anchor: { caseId } });
    const summary = await request(app).get(`${BASE}/dashboard/agentic?projectId=${projectId}`);
    expect(summary.status).toBe(200);
    expect(summary.body.tasks.byState.queued).toBe(1);
    expect(summary.body.traceability.p1WithoutTests).toBe(1);
  });

  it('MCP перелічує всі інструменти з розділу 5 плану', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const names = (res.body.result.tools as Array<{ name: string }>).map((tool) => tool.name);
    for (const name of ['qa_inbox', 'qa_claim', 'qa_release', 'qa_get_case', 'qa_get_requirement', 'qa_get_screen', 'qa_propose_plan', 'qa_post_reading', 'qa_reserve_case', 'qa_ask', 'qa_report']) {
      expect(names).toContain(name);
    }
  });
});
