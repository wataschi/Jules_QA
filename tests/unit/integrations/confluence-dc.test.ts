import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __setSleepForTests,
  confluenceFlavor,
  downloadAttachment,
  downloadUrl,
  fetchConfluencePage,
  fetchPageTree,
  isConfluenceConfigured,
  listAttachments,
  parseConfluencePageId,
  parseConfluenceRef,
  readConfluenceConfig,
  resolveConfluenceRef,
} from '../../../src/integrations/confluence.js';
import { ConfluenceError, resetSecrets } from '../../../src/integrations/errors.js';

const ENV_KEYS = [
  'CONFLUENCE_BASE_URL',
  'CONFLUENCE_TOKEN',
  'CONFLUENCE_EMAIL',
  'CONFLUENCE_API_TOKEN',
  'CONFLUENCE_USER',
  'CONFLUENCE_PASSWORD',
  'CONFLUENCE_FLAVOR',
  'CONFLUENCE_TIMEOUT',
] as const;

const PAT = 'pat-NjQ5MDEyMzQ1Njc4OkS3cr3tV4lu3';
const BASE = 'https://corp.local/confluence';

const original: Record<string, string | undefined> = {};
let fetchMock: ReturnType<typeof vi.fn>;
let sleeps: number[];

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

function call(index: number): { url: string; init: RequestInit; headers: Record<string, string> } {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
  return { url, init, headers: (init.headers ?? {}) as Record<string, string> };
}

beforeEach(() => {
  resetSecrets();
  for (const key of ENV_KEYS) {
    original[key] = process.env[key];
    delete process.env[key];
  }
  process.env.CONFLUENCE_BASE_URL = `${BASE}/`;
  process.env.CONFLUENCE_TOKEN = PAT;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  sleeps = [];
  __setSleepForTests(async (ms) => {
    sleeps.push(ms);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  __setSleepForTests();
  resetSecrets();
  for (const key of ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

/* ─────────────────────────────── конфіг ──────────────────────────────── */

describe('конфіг Confluence', () => {
  it('визначає варіант за хостом, а CONFLUENCE_FLAVOR має перевагу', () => {
    expect(confluenceFlavor('https://acme.atlassian.net/wiki')).toBe('cloud');
    expect(confluenceFlavor('https://wiki.corp.local')).toBe('server');
    expect(confluenceFlavor('https://corp.local/confluence')).toBe('server');
    process.env.CONFLUENCE_FLAVOR = 'cloud';
    expect(confluenceFlavor('https://wiki.corp.local')).toBe('cloud');
    process.env.CONFLUENCE_FLAVOR = 'server';
    expect(confluenceFlavor('https://acme.atlassian.net')).toBe('server');
  });

  it('readConfluenceConfig для DC: база з контекстним шляхом, PAT, без секретів у полях', () => {
    process.env.CONFLUENCE_TIMEOUT = '5000';
    const config = readConfluenceConfig();
    expect(config).toEqual({
      baseUrl: BASE,
      apiBase: BASE,
      flavor: 'server',
      auth: 'bearer',
      timeoutMs: 5000,
    });
    expect(JSON.stringify(config)).not.toContain(PAT);
  });

  it('readConfluenceConfig для Cloud прибирає /wiki з бази й додає його до apiBase', () => {
    delete process.env.CONFLUENCE_TOKEN;
    process.env.CONFLUENCE_BASE_URL = 'https://acme.atlassian.net/wiki/';
    process.env.CONFLUENCE_EMAIL = 'qa@acme.com';
    process.env.CONFLUENCE_API_TOKEN = 'cloud-api-token-123456';
    const config = readConfluenceConfig();
    expect(config).toMatchObject({
      baseUrl: 'https://acme.atlassian.net',
      apiBase: 'https://acme.atlassian.net/wiki',
      flavor: 'cloud',
      auth: 'basic-email',
      username: 'qa@acme.com',
    });
    expect(JSON.stringify(config)).not.toContain('cloud-api-token-123456');
  });

  it('isConfluenceConfigured приймає PAT або логін із паролем', () => {
    expect(isConfluenceConfigured()).toBe(true);
    delete process.env.CONFLUENCE_TOKEN;
    expect(isConfluenceConfigured()).toBe(false);
    process.env.CONFLUENCE_USER = 'svc-jules';
    expect(isConfluenceConfigured()).toBe(false);
    process.env.CONFLUENCE_PASSWORD = 'secret-password-1';
    expect(isConfluenceConfigured()).toBe(true);
    expect(readConfluenceConfig()).toMatchObject({ auth: 'basic-password', username: 'svc-jules' });
  });

  it('без способу входу — помилка з переліком змінних', () => {
    delete process.env.CONFLUENCE_TOKEN;
    expect(() => readConfluenceConfig()).toThrow(/CONFLUENCE_TOKEN/);
  });
});

/* ───────────────────────── розпізнавання посилань ────────────────────── */

describe('parseConfluenceRef', () => {
  it('сторінка за ID, viewpage.action і /spaces/KEY/pages/', () => {
    expect(parseConfluenceRef(' 229376001 ')).toEqual({ kind: 'page', pageId: '229376001' });
    expect(parseConfluenceRef(`${BASE}/pages/viewpage.action?pageId=229376001`)).toEqual({
      kind: 'page',
      pageId: '229376001',
    });
    expect(parseConfluenceRef(`${BASE}/spaces/PAY/pages/229376001/Платіжні+доручення`)).toEqual({
      kind: 'page',
      pageId: '229376001',
    });
    expect(parseConfluenceRef('https://acme.atlassian.net/wiki/spaces/QA/pages/123/Акти#Поля')).toEqual({
      kind: 'page',
      pageId: '123',
    });
  });

  it('/display/SPACE/Назва → пошук за назвою з декодуванням + і %XX', () => {
    expect(
      parseConfluenceRef(`${BASE}/display/PAY/%D0%9F%D0%BB%D0%B0%D1%82%D1%96%D0%B6%D0%BD%D1%96+%D0%B4%D0%BE%D1%80%D1%83%D1%87%D0%B5%D0%BD%D0%BD%D1%8F`),
    ).toEqual({ kind: 'title', spaceKey: 'PAY', title: 'Платіжні доручення' });
    expect(parseConfluenceRef(`${BASE}/display/PAY/C%2B%2B+API`)).toEqual({
      kind: 'title',
      spaceKey: 'PAY',
      title: 'C++ API',
    });
    expect(parseConfluenceRef(`${BASE}/pages/viewpage.action?spaceKey=PAY&title=Ліміти+платежів`)).toEqual({
      kind: 'title',
      spaceKey: 'PAY',
      title: 'Ліміти платежів',
    });
  });

  it('простір: /display/SPACE, /spaces/KEY, /spaces/KEY/overview', () => {
    expect(parseConfluenceRef(`${BASE}/display/PAY`)).toEqual({ kind: 'space', spaceKey: 'PAY' });
    expect(parseConfluenceRef(`${BASE}/display/PAY/`)).toEqual({ kind: 'space', spaceKey: 'PAY' });
    expect(parseConfluenceRef('https://wiki.corp.local/spaces/PAY')).toEqual({ kind: 'space', spaceKey: 'PAY' });
    expect(parseConfluenceRef('https://acme.atlassian.net/wiki/spaces/QA/overview?homepageId=1')).toEqual({
      kind: 'space',
      spaceKey: 'QA',
    });
  });

  it('коротке посилання /x/…', () => {
    expect(parseConfluenceRef(`${BASE}/x/AbCd`)).toEqual({ kind: 'tiny', url: `${BASE}/x/AbCd` });
  });

  it('null для нерозпізнаного', () => {
    expect(parseConfluenceRef('')).toBeNull();
    expect(parseConfluenceRef('просто текст')).toBeNull();
    expect(parseConfluenceRef('https://corp.local/jira/browse/PAY-1')).toBeNull();
  });

  it('parseConfluencePageId лишився для сумісності', () => {
    expect(parseConfluencePageId(`${BASE}/pages/viewpage.action?pageId=77`)).toBe('77');
    expect(parseConfluencePageId(`${BASE}/display/PAY/Назва`)).toBeNull();
  });
});

/* ──────────────────────────── сторінка на DC ─────────────────────────── */

const dcPage = {
  id: '229376001',
  type: 'page',
  title: 'Платіжні доручення',
  space: { id: 98305, key: 'PAY', name: 'Платежі' },
  version: { number: 12 },
  ancestors: [{ id: '229300001', title: 'Платежі' }, { id: '229300500', title: 'Модулі' }],
  body: { storage: { value: '<h1>Доручення</h1><p>Сума більше нуля.</p>', representation: 'storage' } },
  _links: {
    webui: '/display/PAY/Platizhni',
    base: 'https://corp.local/confluence',
    context: '/confluence',
  },
};

describe('fetchConfluencePage на Server/Data Center', () => {
  it('тягне сторінку за PAT: Bearer і REST v1 без /wiki', async () => {
    fetchMock.mockResolvedValueOnce(json(200, dcPage));

    const page = await fetchConfluencePage(`${BASE}/pages/viewpage.action?pageId=229376001`);

    expect(page).toEqual({
      externalId: '229376001',
      title: 'Платіжні доручення',
      version: '12',
      html: '<h1>Доручення</h1><p>Сума більше нуля.</p>',
      url: 'https://corp.local/confluence/display/PAY/Platizhni',
      spaceKey: 'PAY',
      parentId: '229300500',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, headers } = call(0);
    expect(url).toBe(`${BASE}/rest/api/content/229376001?expand=body.storage,version,ancestors,space`);
    expect(url).not.toContain('/wiki');
    expect(headers.Authorization).toBe(`Bearer ${PAT}`);
  });

  it('приймає й старий формат {pageId}', async () => {
    fetchMock.mockResolvedValueOnce(json(200, dcPage));
    const page = await fetchConfluencePage({ pageId: '229376001' });
    expect(page.externalId).toBe('229376001');
  });

  it('/display/SPACE/Назва → пошук за простором і назвою, потім сторінка', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { results: [{ id: '229376001', title: 'Платіжні доручення' }], size: 1 }))
      .mockResolvedValueOnce(json(200, dcPage));

    const page = await fetchConfluencePage({ url: `${BASE}/display/PAY/Платіжні+доручення` });

    expect(page.externalId).toBe('229376001');
    const search = new URL(call(0).url);
    expect(`${search.origin}${search.pathname}`).toBe(`${BASE}/rest/api/content`);
    expect(search.searchParams.get('spaceKey')).toBe('PAY');
    expect(search.searchParams.get('title')).toBe('Платіжні доручення');
    expect(search.searchParams.get('type')).toBe('page');
    expect(call(1).url).toBe(`${BASE}/rest/api/content/229376001?expand=body.storage,version,ancestors,space`);
  });

  it('пошук за назвою без результатів — «сторінку не знайдено»', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { results: [], size: 0 }));
    const error = (await fetchConfluencePage(`${BASE}/display/PAY/Немає`).catch((e: unknown) => e)) as ConfluenceError;
    expect(error).toBeInstanceOf(ConfluenceError);
    expect(error.status).toBe(404);
    expect(error.message).toMatch(/Сторінку «Немає» у просторі PAY не знайдено/);
  });

  it('коротке /x/… розв’язується через Location без автоматичного редиректу', async () => {
    fetchMock
      .mockResolvedValueOnce(redirect('/confluence/pages/viewpage.action?pageId=229376001'))
      .mockResolvedValueOnce(json(200, dcPage));

    const page = await fetchConfluencePage(`${BASE}/x/AbCd`);

    expect(page.externalId).toBe('229376001');
    expect(call(0).url).toBe(`${BASE}/x/AbCd`);
    expect(call(0).init.redirect).toBe('manual');
    expect(call(0).headers.Authorization).toBe(`Bearer ${PAT}`);
  });

  it('коротке посилання через ланцюжок редиректів до /display/ і пошуку', async () => {
    fetchMock
      .mockResolvedValueOnce(redirect(`${BASE}/x/Second`))
      .mockResolvedValueOnce(redirect(`/confluence/display/PAY/${encodeURIComponent('Ліміти')}`, 301))
      .mockResolvedValueOnce(json(200, { results: [{ id: '5' }] }));

    expect(await resolveConfluenceRef(`${BASE}/x/First`)).toEqual({ kind: 'page', pageId: '5' });
    expect(new URL(call(2).url).searchParams.get('title')).toBe('Ліміти');
  });

  it('понад 3 редиректи — помилка', async () => {
    fetchMock.mockImplementation(async () => redirect(`${BASE}/x/Loop`));
    await expect(resolveConfluenceRef(`${BASE}/x/Loop`)).rejects.toThrow(/забагато перенаправлень/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('посилання на простір у fetchConfluencePage — помилка без запиту', async () => {
    await expect(fetchConfluencePage(`${BASE}/display/PAY`)).rejects.toThrow(/веде на простір PAY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('401 — зрозуміла помилка без токена в тексті', async () => {
    fetchMock.mockResolvedValueOnce(json(401, `Bad token ${PAT}; Authorization: Bearer ${PAT}`));

    const error = (await fetchConfluencePage('229376001').catch((e: unknown) => e)) as ConfluenceError;

    expect(error).toBeInstanceOf(ConfluenceError);
    expect(error.status).toBe(401);
    expect(error.message).toContain('CONFLUENCE_TOKEN');
    expect(error.message).not.toContain(PAT);
    expect(error.message).not.toContain('NjQ5MDEy');
  });

  it('відповідь не-JSON (сторінка входу SSO) — зрозуміла помилка', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>Log in</html>', { status: 200 }));
    await expect(fetchConfluencePage('1')).rejects.toThrow(/не є JSON/);
  });

  it('мережева помилка на DC підказує перевірити VPN', async () => {
    fetchMock.mockRejectedValueOnce(
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' } }),
    );
    await expect(fetchConfluencePage('1')).rejects.toThrow(/VPN/);
  });

  it('помилка сертифіката підказує NODE_EXTRA_CA_CERTS', async () => {
    fetchMock.mockRejectedValueOnce(
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } }),
    );
    await expect(fetchConfluencePage('1')).rejects.toThrow(/NODE_EXTRA_CA_CERTS/);
  });
});

/* ─────────────────────────────── 429 ─────────────────────────────────── */

describe('повтор на 429', () => {
  it('чекає Retry-After і повторює запит', async () => {
    fetchMock
      .mockResolvedValueOnce(json(429, 'rate limited', { 'retry-after': '2' }))
      .mockResolvedValueOnce(json(429, 'rate limited'))
      .mockResolvedValueOnce(json(200, dcPage));

    const page = await fetchConfluencePage('229376001');

    expect(page.title).toBe('Платіжні доручення');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // 2 с з Retry-After, далі експоненційна пауза.
    expect(sleeps).toEqual([2000, 2000]);
  });

  it('після 5 спроб — помилка 429', async () => {
    fetchMock.mockImplementation(async () => json(429, 'rate limited', { 'retry-after': '1' }));
    const error = (await fetchConfluencePage('1').catch((e: unknown) => e)) as ConfluenceError;
    expect(error.status).toBe(429);
    expect(error.message).toMatch(/частоту запитів/);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(sleeps).toHaveLength(4);
  });

  it('пауза підміняється й опцією sleep', async () => {
    const own: number[] = [];
    fetchMock
      .mockResolvedValueOnce(json(429, '', { 'retry-after': '3' }))
      .mockResolvedValueOnce(json(200, dcPage));
    await fetchConfluencePage('1', { sleep: async (ms) => void own.push(ms) });
    expect(own).toEqual([3000]);
    expect(sleeps).toEqual([]);
  });
});

/* ─────────────────────────── дерево сторінок ─────────────────────────── */

function treePage(id: string, title: string, ancestors: string[], version = 1) {
  return {
    id,
    title,
    type: 'page',
    version: { number: version },
    ancestors: ancestors.map((a) => ({ id: a })),
    _links: { webui: `/pages/viewpage.action?pageId=${id}` },
  };
}

describe('fetchPageTree', () => {
  const rootAncestors = ['100'];

  it('сторінка з нащадками: пагінація за _links.next і depth відносно кореня', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, treePage('200', 'Платежі', rootAncestors, 4)))
      .mockResolvedValueOnce(
        json(200, {
          results: [treePage('201', 'Створення', ['100', '200']), treePage('202', 'Погодження', ['100', '200'])],
          start: 0,
          limit: 2,
          size: 2,
          _links: {
            base: BASE,
            context: '/confluence',
            next: '/rest/api/content/search?cql=ancestor%3D200+and+type%3Dpage&expand=version,ancestors&limit=2&start=2',
          },
        }),
      )
      .mockResolvedValueOnce(
        json(200, {
          results: [treePage('203', 'Ліміти', ['100', '200', '202'], 2)],
          start: 2,
          limit: 2,
          size: 1,
          _links: { base: BASE, context: '/confluence' },
        }),
      );

    const tree = await fetchPageTree(`${BASE}/pages/viewpage.action?pageId=200`);

    expect(tree.truncated).toBe(false);
    expect(tree.root).toEqual({
      id: '200',
      title: 'Платежі',
      parentId: '100',
      depth: 0,
      version: '4',
      url: `${BASE}/pages/viewpage.action?pageId=200`,
    });
    expect(tree.pages.map((p) => [p.id, p.parentId, p.depth])).toEqual([
      ['200', '100', 0],
      ['201', '200', 1],
      ['202', '200', 1],
      ['203', '202', 2],
    ]);
    expect(tree.pages[3]?.url).toBe(`${BASE}/pages/viewpage.action?pageId=203`);

    expect(call(0).url).toBe(`${BASE}/rest/api/content/200?expand=version,ancestors`);
    const first = new URL(call(1).url);
    expect(first.pathname).toBe('/confluence/rest/api/content/search');
    expect(first.searchParams.get('cql')).toBe('ancestor=200 and type=page');
    expect(first.searchParams.get('expand')).toBe('version,ancestors');
    expect(first.searchParams.get('limit')).toBe('50');
    expect(first.searchParams.get('start')).toBe('0');
    expect(call(2).url).toBe(
      `${BASE}/rest/api/content/search?cql=ancestor%3D200+and+type%3Dpage&expand=version,ancestors&limit=2&start=2`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('без _links.next гортає за start/size', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, treePage('200', 'Платежі', [])))
      .mockResolvedValueOnce(
        json(200, { results: [treePage('201', 'A', ['200']), treePage('202', 'B', ['200'])], start: 0, limit: 2, size: 2 }),
      )
      .mockResolvedValueOnce(json(200, { results: [], start: 2, limit: 2, size: 0 }));

    const tree = await fetchPageTree('200');
    expect(tree.pages.map((p) => p.id)).toEqual(['200', '201', '202']);
    expect(new URL(call(2).url).searchParams.get('start')).toBe('2');
  });

  it('maxPages обрізає дерево й ставить truncated', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, treePage('200', 'Платежі', [])))
      .mockResolvedValueOnce(
        json(200, {
          results: [treePage('201', 'A', ['200']), treePage('202', 'B', ['200']), treePage('203', 'C', ['200'])],
          start: 0,
          limit: 50,
          size: 3,
        }),
      );
    const tree = await fetchPageTree('200', { maxPages: 2 });
    expect(tree.pages.map((p) => p.id)).toEqual(['200', '201']);
    expect(tree.truncated).toBe(true);
  });

  it('простір: CQL space="KEY", без кореня, depth від верху простору', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        results: [treePage('100', 'Головна PAY', []), treePage('200', 'Платежі', ['100'])],
        start: 0,
        limit: 50,
        size: 2,
        _links: { base: BASE },
      }),
    );

    const tree = await fetchPageTree(`${BASE}/display/PAY`);

    expect(tree.root).toBeUndefined();
    expect(tree.truncated).toBe(false);
    expect(tree.pages.map((p) => [p.id, p.parentId, p.depth])).toEqual([
      ['100', null, 0],
      ['200', '100', 1],
    ]);
    expect(new URL(call(0).url).searchParams.get('cql')).toBe('space="PAY" and type=page');
  });

  it('порожній простір — порожнє дерево', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { results: [], start: 0, limit: 50, size: 0 }));
    expect(await fetchPageTree(`${BASE}/spaces/EMPTY`)).toEqual({ pages: [], truncated: false });
  });

  it('нерозпізнане посилання — помилка без запиту', async () => {
    await expect(fetchPageTree('просто текст')).rejects.toThrow(/Не вдалося визначити ID сторінки/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* ───────────────────────────── вкладення ─────────────────────────────── */

describe('вкладення', () => {
  it('listAttachments: ім’я, тип, розмір, версія й абсолютний downloadUrl', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        results: [
          {
            id: 'att229376100',
            type: 'attachment',
            title: 'payment-form.png',
            metadata: { mediaType: 'image/png' },
            extensions: { mediaType: 'image/png', fileSize: 48213 },
            version: { number: 2 },
            _links: {
              download: '/download/attachments/229376001/payment-form.png?version=2&modificationDate=1715000000000&api=v2',
            },
          },
          {
            id: 'att229376101',
            title: 'approval-flow',
            extensions: { mediaType: 'application/vnd.jgraph.mxfile' },
            _links: { download: '/confluence/download/attachments/229376001/approval-flow?api=v2' },
          },
        ],
        start: 0,
        limit: 200,
        size: 2,
        _links: { base: BASE, context: '/confluence' },
      }),
    );

    const list = await listAttachments('229376001');

    expect(list).toEqual([
      {
        id: 'att229376100',
        title: 'payment-form.png',
        mediaType: 'image/png',
        size: 48213,
        version: '2',
        downloadUrl: `${BASE}/download/attachments/229376001/payment-form.png?version=2&modificationDate=1715000000000&api=v2`,
      },
      {
        id: 'att229376101',
        title: 'approval-flow',
        mediaType: 'application/vnd.jgraph.mxfile',
        downloadUrl: `${BASE}/download/attachments/229376001/approval-flow?api=v2`,
      },
    ]);
    expect(call(0).url).toBe(`${BASE}/rest/api/content/229376001/child/attachment?limit=200`);
  });

  it('listAttachments для сторінки без вкладень — порожній масив', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { results: [], start: 0, limit: 200, size: 0 }));
    expect(await listAttachments('1')).toEqual([]);
  });

  it('downloadAttachment: файл за /download/attachments з кодуванням імені', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    fetchMock.mockResolvedValueOnce(new Response(png, { status: 200, headers: { 'content-type': 'image/png;charset=binary' } }));

    const file = await downloadAttachment('229376001', 'Знімок екрана 1.png');

    expect(file.mediaType).toBe('image/png');
    expect(Buffer.isBuffer(file.data)).toBe(true);
    expect([...file.data]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(call(0).url).toBe(
      `${BASE}/download/attachments/229376001/${encodeURIComponent('Знімок екрана 1.png')}`,
    );
    expect(call(0).headers.Authorization).toBe(`Bearer ${PAT}`);
  });

  it('downloadAttachment: 404 — помилка з ім’ям файлу', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    await expect(downloadAttachment('229376001', 'none.png')).rejects.toThrow(/none\.png/);
  });

  it('downloadAttachment: нечисловий pageId — помилка без запиту', async () => {
    await expect(downloadAttachment('../etc', 'a.png')).rejects.toThrow(/числовий ID/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('downloadUrl: зовнішня адреса без облікових даних Confluence', async () => {
    fetchMock.mockResolvedValueOnce(new Response(Buffer.from('img'), { status: 200, headers: { 'content-type': 'image/jpeg' } }));
    const file = await downloadUrl('https://static.example.com/a.jpg');
    expect(file).toEqual({ data: Buffer.from('img'), mediaType: 'image/jpeg' });
    expect(call(0).headers.Authorization).toBeUndefined();
  });

  it('downloadUrl: адреса на тому ж Confluence — з PAT', async () => {
    fetchMock.mockResolvedValueOnce(new Response(Buffer.from('x'), { status: 200 }));
    const file = await downloadUrl(`${BASE}/download/attachments/1/a.png`);
    expect(file.mediaType).toBe('application/octet-stream');
    expect(call(0).headers.Authorization).toBe(`Bearer ${PAT}`);
  });

  it('downloadUrl: не-http(s) відхиляється без запиту', async () => {
    await expect(downloadUrl('file:///etc/passwd')).rejects.toThrow(/лише http\(s\)/);
    await expect(downloadUrl('не адреса')).rejects.toThrow(/Некоректна адреса/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('downloadUrl: редирект перевіряється за списком хостів, а не йде куди завгодно', async () => {
    const allowHost = (url: string) => ['static.example.com', 'cdn.example.com', 'corp.local'].includes(new URL(url).host);
    fetchMock.mockResolvedValueOnce(redirect('http://169.254.169.254/latest/meta-data/'));
    await expect(downloadUrl('https://static.example.com/a.png', { allowHost })).rejects.toThrow(/перенаправив на недозволений хост/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(call(0).init.redirect).toBe('manual');

    // Без списку — лише в межах того самого сервера.
    fetchMock.mockResolvedValueOnce(redirect('https://evil.example.net/x.png'));
    await expect(downloadUrl('https://static.example.com/b.png')).rejects.toThrow(/недозволений хост/);
  });

  it('downloadUrl: дозволений редирект — до 3 переходів, PAT лише на свій Confluence', async () => {
    const allowHost = (url: string) => ['static.example.com', 'cdn.example.com', 'corp.local'].includes(new URL(url).host);
    fetchMock
      .mockResolvedValueOnce(redirect(`${BASE}/download/attachments/1/a.png`, 301))
      .mockResolvedValueOnce(redirect('https://cdn.example.com/a.png'))
      .mockResolvedValueOnce(new Response(Buffer.from('img'), { status: 200, headers: { 'content-type': 'image/png' } }));
    const file = await downloadUrl('https://static.example.com/a.png', { allowHost });
    expect(file.mediaType).toBe('image/png');
    expect(call(0).headers.Authorization).toBeUndefined();
    expect(call(1).url).toBe(`${BASE}/download/attachments/1/a.png`);
    expect(call(1).headers.Authorization).toBe(`Bearer ${PAT}`);
    expect(call(2).url).toBe('https://cdn.example.com/a.png');
    expect(call(2).headers.Authorization).toBeUndefined();

    fetchMock.mockReset();
    for (let i = 0; i < 4; i += 1) fetchMock.mockResolvedValueOnce(redirect(`https://cdn.example.com/${i}.png`));
    await expect(downloadUrl('https://static.example.com/loop.png', { allowHost })).rejects.toThrow(/забагато перенаправлень/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('downloadUrl: файл понад maxBytes відхиляється', async () => {
    fetchMock.mockResolvedValueOnce(new Response(Buffer.alloc(20), { status: 200 }));
    await expect(downloadUrl('https://static.example.com/big.png', { maxBytes: 10 })).rejects.toThrow(/завеликий/);
  });
});

/* ─────────────────────────────── Cloud ───────────────────────────────── */

describe('Cloud лишився як був', () => {
  const CLOUD_TOKEN = 'cloud-api-token-abcdef123';

  beforeEach(() => {
    delete process.env.CONFLUENCE_TOKEN;
    process.env.CONFLUENCE_BASE_URL = 'https://acme.atlassian.net';
    process.env.CONFLUENCE_EMAIL = 'qa@acme.com';
    process.env.CONFLUENCE_API_TOKEN = CLOUD_TOKEN;
  });

  it('сторінка через v2 з Basic і /wiki', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        id: '123',
        title: 'Акти',
        parentId: '99',
        version: { number: 7 },
        body: { storage: { value: '<p>Текст.</p>' } },
        _links: { webui: '/spaces/QA/pages/123/Акти', base: 'https://acme.atlassian.net/wiki' },
      }),
    );
    const page = await fetchConfluencePage('https://acme.atlassian.net/wiki/spaces/QA/pages/123/Акти');
    expect(page.parentId).toBe('99');
    expect(call(0).url).toBe('https://acme.atlassian.net/wiki/api/v2/pages/123?body-format=storage');
    expect(call(0).headers.Authorization).toBe(
      `Basic ${Buffer.from(`qa@acme.com:${CLOUD_TOKEN}`).toString('base64')}`,
    );
  });

  it('дерево, вкладення й download на Cloud ідуть через /wiki', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, treePage('123', 'Акти', [])))
      .mockResolvedValueOnce(json(200, { results: [], start: 0, limit: 50, size: 0 }))
      .mockResolvedValueOnce(json(200, { results: [], start: 0, limit: 200, size: 0 }))
      .mockResolvedValueOnce(new Response(Buffer.from('x'), { status: 200 }));

    await fetchPageTree('123');
    await listAttachments('123');
    await downloadAttachment('123', 'a.png');

    expect(call(0).url).toBe('https://acme.atlassian.net/wiki/rest/api/content/123?expand=version,ancestors');
    expect(call(1).url.startsWith('https://acme.atlassian.net/wiki/rest/api/content/search?cql=')).toBe(true);
    expect(call(2).url).toBe('https://acme.atlassian.net/wiki/rest/api/content/123/child/attachment?limit=200');
    expect(call(3).url).toBe('https://acme.atlassian.net/wiki/download/attachments/123/a.png');
  });
});
