import { readFileSync } from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Application } from 'express';
import { createApp } from '../../src/server/index.js';
import { createTempRegistry, type TempRegistry } from '../unit/registry/temp-db.js';
import { completeTask } from '../../src/registry/tasks-store.js';
import { assignModulesFromTree, importFigma, loadConfluenceTree, syncConfluenceSource } from '../../src/server/inputs.js';
import { listAssets } from '../../src/registry/assets-store.js';
import { listBlockLinks, liveBlocks } from '../../src/registry/sources-store.js';
import { createTask, listTasks } from '../../src/registry/tasks-store.js';
import { requestReading } from '../../src/server/workflow.js';
import { requirementViews, taskContext } from '../../src/server/task-context.js';

const BASE = '/api/registry';
const WIKI = 'https://wiki.corp.local';
const FIXTURES = path.resolve(import.meta.dirname, '../fixtures');
const PAGE_HTML = readFileSync(path.join(FIXTURES, 'confluence/dc-8.5-assets.storage.html'), 'utf8');
const FIGMA_FILE = JSON.parse(readFileSync(path.join(FIXTURES, 'figma/login-file.json'), 'utf8'));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7c6a0e80000000049454e44ae426082', 'hex');

const DRAWIO = `<mxfile><diagram name="Погодження">${Buffer.from(
  deflateRawSync(
    Buffer.from(
      encodeURIComponent(
        '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
          '<mxCell id="a" value="Чернетка" vertex="1" parent="1"/><mxCell id="b" value="Погоджено" vertex="1" parent="1"/>' +
          '<mxCell id="e" value="QA погодив" edge="1" source="a" target="b" parent="1"/></root></mxGraphModel>',
      ),
    ),
  ),
).toString('base64')}</diagram></mxfile>`;

interface PageDef {
  id: string;
  title: string;
  ancestors: string[];
  version: number;
  html: string;
}

/** Фальшивий Confluence 8.5 (REST v1 без /wiki) і Figma API за одним fetch. */
function fakeNetwork(pages: PageDef[], figma: { version: string; frameNode?: string } = { version: '1' }) {
  const calls: string[] = [];
  const pageJson = (page: PageDef) => ({
    id: page.id,
    type: 'page',
    title: page.title,
    version: { number: page.version },
    ancestors: page.ancestors.map((id) => ({ id })),
    space: { key: 'PRJ' },
    body: { storage: { value: page.html } },
    _links: { webui: `/pages/viewpage.action?pageId=${page.id}` },
  });
  const reply = (body: unknown, status = 200, type = 'application/json') =>
    new Response(typeof body === 'string' || body instanceof Uint8Array ? (body as ConstructorParameters<typeof Response>[0]) : JSON.stringify(body), {
      status,
      headers: { 'content-type': type },
    });

  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push(url.pathname + url.search);
    if (url.host === 'wiki.corp.local') {
      const search = url.pathname === '/rest/api/content/search';
      if (search) {
        const root = /ancestor=(\d+)/.exec(decodeURIComponent(url.search))?.[1];
        const results = pages.filter((page) => root && page.ancestors.includes(root)).map(pageJson);
        return reply({ results, start: 0, limit: 50, size: results.length, _links: {} });
      }
      const pageMatch = /^\/rest\/api\/content\/(\d+)$/.exec(url.pathname);
      if (pageMatch) {
        const page = pages.find((item) => item.id === pageMatch[1]);
        return page ? reply(pageJson(page)) : reply({ message: 'not found' }, 404);
      }
      const download = /^\/download\/attachments\/(\d+)\/(.+)$/.exec(url.pathname);
      if (download) {
        const name = decodeURIComponent(download[2]);
        if (name.endsWith('.png')) return reply(new Uint8Array(PNG), 200, 'image/png');
        if (name === 'approval-flow') return reply(DRAWIO, 200, 'application/vnd.jgraph.mxfile');
        return reply({ message: 'no attachment' }, 404);
      }
      return reply({ message: 'unexpected' }, 404);
    }
    if (url.host === 'api.figma.com') {
      if (url.pathname.startsWith('/v1/images/')) {
        const ids = (url.searchParams.get('ids') ?? '').split(',');
        return reply({ err: null, images: Object.fromEntries(ids.map((id) => [id, `https://s3.figma.test/${id}.png`])) });
      }
      if (url.pathname.startsWith('/v1/files/')) {
        const file = structuredClone(FIGMA_FILE);
        file.version = figma.version;
        if (figma.frameNode) file.document.children[0].children[0].id = figma.frameNode;
        return reply(file);
      }
    }
    if (url.host === 's3.figma.test') return reply(new Uint8Array(PNG), 200, 'image/png');
    return reply({ message: `unexpected ${url.href}` }, 500);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('входи: дерево Confluence 8.5, вкладення, схеми, Figma', () => {
  let temp: TempRegistry;
  let app: Application;
  let projectId: string;

  const pages: PageDef[] = [
    { id: '100', title: 'Проєкт Кібер', ancestors: [], version: 3, html: '<h1>Огляд</h1><p>Вступ до проєкту.</p>' },
    { id: '101', title: 'Акти', ancestors: ['100'], version: 7, html: PAGE_HTML },
    { id: '102', title: 'Оплати', ancestors: ['100'], version: 2, html: '<h2>Оплата</h2><p>Сума списується після підтвердження.</p>' },
    { id: '103', title: 'Деталі актів', ancestors: ['100', '101'], version: 1, html: '<h2>Поля</h2><p>Дата акта обовʼязкова.</p>' },
  ];

  beforeEach(async () => {
    temp = createTempRegistry();
    delete process.env.JULES_API_TOKEN;
    process.env.CONFLUENCE_BASE_URL = WIKI;
    process.env.CONFLUENCE_TOKEN = 'pat-secret';
    process.env.FIGMA_TOKEN = 'figd-secret';
    app = createApp();
    projectId = (await request(app).post(`${BASE}/projects`).send({ key: 'CYBER', name: 'Кібер' })).body.id;
  });

  afterEach(() => {
    delete process.env.CONFLUENCE_BASE_URL;
    delete process.env.CONFLUENCE_TOKEN;
    delete process.env.FIGMA_TOKEN;
    temp.cleanup();
  });

  it('будує дерево сторінок із батьками й не тягне тіла', async () => {
    const { fetchImpl, calls } = fakeNetwork(pages);
    const tree = await loadConfluenceTree(projectId, `${WIKI}/pages/viewpage.action?pageId=100`, { fetch: fetchImpl });
    expect(tree.sources).toHaveLength(4);
    const byTitle = Object.fromEntries(tree.sources.map((source) => [source.title, source]));
    expect(byTitle['Акти'].parentId).toBe(byTitle['Проєкт Кібер'].id);
    expect(byTitle['Деталі актів'].parentId).toBe(byTitle['Акти'].id);
    expect(calls.some((call) => call.includes('expand=body.storage'))).toBe(false);

    const httpTree = await request(app).get(`${BASE}/sources/tree?projectId=${projectId}`);
    expect(httpTree.body).toHaveLength(1);
    expect(httpTree.body[0].children.map((child: { title: string }) => child.title).sort()).toEqual(['Акти', 'Оплати']);
  });

  it('синхронізує сторінку: блоки, картинки на прочитання, текст draw.io, PlantUML, Figma, Jira', async () => {
    const { fetchImpl } = fakeNetwork(pages);
    const tree = await loadConfluenceTree(projectId, '100', { fetch: fetchImpl });
    const acts = tree.sources.find((source) => source.title === 'Акти')!;
    const result = await syncConfluenceSource(acts.id, { fetch: fetchImpl });
    expect(result.unchanged).toBe(false);
    expect(result.added).toBeGreaterThan(0);

    const assets = listAssets(projectId);
    const image = assets.find((asset) => asset.name === 'payment-form.png')!;
    expect(image.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(image.readingState).toBe('needed');
    const drawio = assets.find((asset) => asset.name === 'approval-flow')!;
    expect(drawio.extractedText).toContain('Чернетка → Погоджено (QA погодив)');
    expect(drawio.readingState).toBe('none');
    expect(assets.find((asset) => asset.diagramType === 'plantuml')?.extractedText).toMatch(/PlantUML/);
    expect(assets.find((asset) => asset.diagramType === 'other')?.error).toMatch(/не віддає даних/);

    expect(result.readTasks.length).toBeGreaterThan(0);
    expect(listTasks({ projectId, kinds: ['read_asset'] }).total).toBe(result.readTasks.length);

    const blocks = liveBlocks(acts.id);
    expect(blocks.some((block) => (block.meta.jiraKeys ?? []).length > 0)).toBe(true);
    expect(listBlockLinks(blocks.map((block) => block.id)).some((link) => link.fileKey === 'AbC123xYz' && link.nodeId === '12:345')).toBe(true);

    const again = await syncConfluenceSource(acts.id, { fetch: fetchImpl });
    expect(again.unchanged).toBe(true);
  });

  it('картинка з тим самим вмістом не просить нового прочитання після погодження', async () => {
    const { fetchImpl } = fakeNetwork(pages);
    const tree = await loadConfluenceTree(projectId, '100', { fetch: fetchImpl });
    const acts = tree.sources.find((source) => source.title === 'Акти')!;
    await syncConfluenceSource(acts.id, { fetch: fetchImpl });
    const image = listAssets(projectId).find((asset) => asset.name === 'payment-form.png')!;

    await request(app).post(`${BASE}/assets/${image.id}/reading`).send({ reading: 'Форма оплати: поле суми, кнопка «Сплатити»' });
    const decided = await request(app).post(`${BASE}/assets/${image.id}/decide`).send({ approve: true });
    expect(decided.body.readingState).toBe('approved');

    const changedPages = pages.map((page) => (page.id === '101' ? { ...page, version: 8 } : page));
    const second = fakeNetwork(changedPages);
    const result = await syncConfluenceSource(acts.id, { fetch: second.fetchImpl });
    const after = listAssets(projectId).find((asset) => asset.name === 'payment-form.png')!;
    expect(after.readingState).toBe('approved');
    expect(result.readTasks).toHaveLength(0);

    const file = await request(app).get(`${BASE}/assets/${image.id}/file`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['content-security-policy']).toContain('sandbox');
  });

  it('модулі з дерева: секції першого рівня, гілка сторінок і задачі плану', async () => {
    const { fetchImpl } = fakeNetwork(pages);
    const tree = await loadConfluenceTree(projectId, '100', { fetch: fetchImpl });
    const root = tree.sources.find((source) => source.title === 'Проєкт Кібер')!;
    const { sections } = assignModulesFromTree(projectId, root.id, 'qa@corp');
    expect(sections.map((section) => section.name).sort()).toEqual(['Акти', 'Оплати']);
    expect(sections.every((section) => section.planTask)).toBe(true);

    const details = (await request(app).get(`${BASE}/sources/tree?projectId=${projectId}`)).body[0].children
      .find((child: { title: string }) => child.title === 'Акти').children[0];
    expect(details.sectionId).toBe(sections.find((section) => section.name === 'Акти')!.id);

    const repeat = assignModulesFromTree(projectId, root.id, 'qa@corp');
    expect(repeat.sections.every((section) => !section.created && section.planTask === null)).toBe(true);
  });

  it('закритий план модуля не перезапускається повторним призначенням модулів', async () => {
    const { fetchImpl } = fakeNetwork(pages);
    const tree = await loadConfluenceTree(projectId, '100', { fetch: fetchImpl });
    const root = tree.sources.find((source) => source.title === 'Проєкт Кібер')!;
    const { sections } = assignModulesFromTree(projectId, root.id, 'qa@corp');
    for (const section of sections) completeTask(section.planTask!, 'qa@corp', 'qa', 'план погоджено');
    const repeat = assignModulesFromTree(projectId, root.id, 'qa@corp');
    expect(repeat.sections.map((section) => section.planTask)).toEqual([null, null]);
  });

  it('сторінка «не віддавати агентам» приходить в агента без вмісту', async () => {
    const { fetchImpl } = fakeNetwork(pages);
    const tree = await loadConfluenceTree(projectId, '100', { fetch: fetchImpl });
    const payments = tree.sources.find((source) => source.title === 'Оплати')!;
    await syncConfluenceSource(payments.id, { fetch: fetchImpl });
    await request(app).patch(`${BASE}/sources/${payments.id}`).send({ noAgents: true });
    const blockId = liveBlocks(payments.id)[0].id;

    const res = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'qa_get_requirement', arguments: { blockId } } });
    const text = res.body.result.content[0].text as string;
    expect(text).toContain('не віддавати агентам');
    expect(text).not.toContain('Сума списується');

    const human = await request(app).get(`${BASE}/blocks/${blockId}`);
    expect(human.body.text).toContain('Сума списується');
  });

  it('Figma: кадри стають блоками зі знімками, а посилання сторінки знаходить свій кадр', async () => {
    const net = fakeNetwork(pages, { version: '42', frameNode: '12:345' });
    const tree = await loadConfluenceTree(projectId, '100', { fetch: net.fetchImpl });
    const acts = tree.sources.find((source) => source.title === 'Акти')!;
    await syncConfluenceSource(acts.id, { fetch: net.fetchImpl });

    const figma = await importFigma(projectId, 'https://www.figma.com/design/AbC123xYz/Payments', { fetch: net.fetchImpl });
    expect(figma.added).toBeGreaterThan(0);
    const frames = listAssets(projectId).filter((asset) => asset.kind === 'frame');
    expect(frames.length).toBe(figma.added);
    expect(frames.every((frame) => frame.sha256)).toBe(true);

    const links = listBlockLinks(liveBlocks(acts.id).map((block) => block.id)).filter((link) => link.fileKey === 'AbC123xYz');
    expect(links.some((link) => link.toBlockId)).toBe(true);

    const view = await request(app).get(`${BASE}/sources/${acts.id}/view`);
    expect(view.body.blocks.some((block: { screens: string[] }) => block.screens.length > 0)).toBe(true);

    const same = await importFigma(projectId, 'https://www.figma.com/design/AbC123xYz/Payments', { fetch: net.fetchImpl });
    expect(same.changed + same.added + same.removed).toBe(0);
  });

  it('вкладення з помилкою завантаження перезавантажується, навіть якщо версія сторінки та сама', async () => {
    const { fetchImpl } = fakeNetwork(pages);
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('payment-form.png')) return new Response('timeout', { status: 503 });
      return fetchImpl(input, init);
    }) as typeof fetch;
    const tree = await loadConfluenceTree(projectId, '100', { fetch: fetchImpl });
    const acts = tree.sources.find((source) => source.title === 'Акти')!;
    const first = await syncConfluenceSource(acts.id, { fetch: flaky });
    expect(first.assetErrors.map((item) => item.name)).toContain('payment-form.png');
    expect(listAssets(projectId).find((asset) => asset.name === 'payment-form.png')!.error).toBeDefined();

    const retry = await syncConfluenceSource(acts.id, { fetch: fetchImpl });
    const image = listAssets(projectId).find((asset) => asset.name === 'payment-form.png')!;
    expect(image.error).toBeUndefined();
    expect(image.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(image.readingState).toBe('needed');
    expect(retry.readTasks).toHaveLength(1);
    expect(retry.changed + retry.added + retry.removed).toBe(0);
  });

  it('тимчасова помилка завантаження не скидає погодженого прочитання і не просить нового', async () => {
    const { fetchImpl } = fakeNetwork(pages);
    const tree = await loadConfluenceTree(projectId, '100', { fetch: fetchImpl });
    const acts = tree.sources.find((source) => source.title === 'Акти')!;
    await syncConfluenceSource(acts.id, { fetch: fetchImpl });
    const image = listAssets(projectId).find((asset) => asset.name === 'payment-form.png')!;
    await request(app).post(`${BASE}/assets/${image.id}/reading`).send({ reading: 'Форма оплати' });
    await request(app).post(`${BASE}/assets/${image.id}/decide`).send({ approve: true });

    const bumped = fakeNetwork(pages.map((page) => (page.id === '101' ? { ...page, version: 8 } : page)));
    const flaky = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).includes('payment-form.png') ? new Response('timeout', { status: 503 }) : bumped.fetchImpl(input, init)) as typeof fetch;
    await syncConfluenceSource(acts.id, { fetch: flaky });
    expect(listAssets(projectId).find((asset) => asset.name === 'payment-form.png')).toMatchObject({ readingState: 'approved', reading: 'Форма оплати' });
    const again = await syncConfluenceSource(acts.id, { fetch: bumped.fetchImpl });
    expect(again.readTasks).toHaveLength(0);
    expect(listAssets(projectId).find((asset) => asset.name === 'payment-form.png')).toMatchObject({ readingState: 'approved' });
  });

  it('гілка «не віддавати агентам»: без задач прочитання, назви й адреси приховані від агента', async () => {
    const { fetchImpl } = fakeNetwork(pages);
    const tree = await loadConfluenceTree(projectId, '100', { fetch: fetchImpl });
    const root = tree.sources.find((source) => source.title === 'Проєкт Кібер')!;
    const acts = tree.sources.find((source) => source.title === 'Акти')!;
    await request(app).patch(`${BASE}/sources/${root.id}`).send({ noAgents: true });

    const result = await syncConfluenceSource(acts.id, { fetch: fetchImpl });
    expect(result.readTasks).toHaveLength(0);
    expect(listTasks({ projectId, kinds: ['read_asset'] }).total).toBe(0);
    const image = listAssets(projectId).find((asset) => asset.name === 'payment-form.png')!;
    expect(requestReading(image, 'qa')).toBeNull();

    const blockId = image.blockId!;
    const [agentView] = requirementViews([blockId], { forAgent: true });
    expect(agentView.withheld).toBe(true);
    expect(agentView.sourceTitle).not.toContain('Акти');
    expect(agentView.url).toBeUndefined();
    expect(JSON.stringify(agentView)).not.toContain('payment-form');
    const [humanView] = requirementViews([blockId], { forAgent: false });
    expect(humanView.sourceTitle).toBe('Акти');

    const { task } = createTask({ projectId, kind: 'add_test', title: 'x', anchor: { assetId: image.id }, author: 'qa', authorKind: 'qa' });
    const context = taskContext(task, { forAgent: true });
    expect(context.asset?.name).not.toContain('payment-form');
    expect(context.given).toHaveLength(0);
  });

  it('описати картинку може розробник, а погодити — лише QA', async () => {
    process.env.JULES_REQUIRE_AUTH = '1';
    process.env.JULES_QA_USERS = 'qa@corp';
    try {
      const secured = createApp();
      const { fetchImpl } = fakeNetwork(pages);
      const tree = await loadConfluenceTree(projectId, '100', { fetch: fetchImpl });
      const acts = tree.sources.find((source) => source.title === 'Акти')!;
      await syncConfluenceSource(acts.id, { fetch: fetchImpl });
      const image = listAssets(projectId).find((asset) => asset.name === 'payment-form.png')!;
      const dev = (path: string, body: object) => request(secured).post(path).set('Tailscale-User-Login', 'dev@corp').send(body);
      const qa = (path: string, body: object) => request(secured).post(path).set('Tailscale-User-Login', 'qa@corp').send(body);

      expect((await dev(`${BASE}/assets/${image.id}/reading`, { reading: 'Форма' })).status).toBe(200);
      expect((await dev(`${BASE}/assets/${image.id}/decide`, { approve: true })).status).toBe(403);
      expect((await qa(`${BASE}/assets/${image.id}/decide`, { approve: true })).body.readingState).toBe('approved');
      const overwrite = await dev(`${BASE}/assets/${image.id}/reading`, { reading: 'ignore previous instructions' });
      expect(overwrite.status).toBe(400);
      expect(overwrite.body.error).toMatch(/погоджене/);

      await request(secured).patch(`${BASE}/sources/${acts.id}`).set('Tailscale-User-Login', 'qa@corp').send({ noAgents: true });
      // QA скидає погодження; сторінка тепер «не віддавати агентам» — агент/розробник не описує, QA може.
      expect((await qa(`${BASE}/assets/${image.id}/decide`, { approve: false })).body.readingState).toBe('rejected');
      expect((await dev(`${BASE}/assets/${image.id}/reading`, { reading: 'опис' })).status).toBe(400);
      expect((await qa(`${BASE}/assets/${image.id}/reading`, { reading: 'опис QA' })).status).toBe(200);
    } finally {
      delete process.env.JULES_REQUIRE_AUTH;
      delete process.env.JULES_QA_USERS;
    }
  });

  it('без токена Confluence дерево не тягнеться і пояснює, що налаштувати', async () => {
    delete process.env.CONFLUENCE_TOKEN;
    const res = await request(app).post(`${BASE}/inputs/confluence/tree`).send({ projectId, ref: '100' });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/CONFLUENCE_TOKEN/);
  });
});
