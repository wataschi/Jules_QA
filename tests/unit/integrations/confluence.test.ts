import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchConfluencePage,
  hashBlock,
  isConfluenceConfigured,
  parseConfluencePageId,
  splitIntoBlocks,
} from '../../../src/integrations/confluence.js';
import { ConfluenceError, resetSecrets } from '../../../src/integrations/errors.js';

const FIXTURE = path.resolve(
  import.meta.dirname,
  '../../fixtures/confluence-acts-page.storage.html',
);

function readFixture(): string {
  return readFileSync(FIXTURE, 'utf-8');
}

describe('splitIntoBlocks (storage-HTML Confluence)', () => {
  const blocks = splitIntoBlocks(readFixture());
  const byHeading = (heading: string) => blocks.find((block) => block.heading === heading);

  it('ріже сторінку за заголовками h1–h4 і нумерує блоки', () => {
    expect(blocks.map((block) => block.heading)).toEqual([
      'Акти виконаних робіт',
      'Створення акта',
      'Поля форми акта',
      'Видалення акта',
    ]);
    expect(blocks.map((block) => block.position)).toEqual([0, 1, 2, 3]);
    expect(blocks.every((block) => block.text.trim().length > 0)).toBe(true);
  });

  it('відкидає порожні блоки (заголовок без тексту)', () => {
    expect(byHeading('Порожній підрозділ')).toBeUndefined();
  });

  it('відкидає навігаційні макроси, але лишає текст змістовних', () => {
    const all = blocks.map((block) => block.text).join('\n');
    expect(all).not.toContain('maxLevel');
    expect(all).not.toContain('ac:structured-macro');
    expect(all).not.toContain('ri:attachment');
    // info-макрос — це теж вимога, його текст потрібен.
    expect(byHeading('Створення акта')?.text).toContain('Акт без суми не зберігається');
  });

  it('перетворює таблицю в рядки «колонка: значення»', () => {
    const text = byHeading('Поля форми акта')?.text ?? '';
    expect(text).toContain('рядок 1:');
    expect(text).toContain('Поле: Номер');
    expect(text).toContain("Обов'язкове: так");
    expect(text).toContain('Правило: більше 0, не більше 2 знаків після коми');
    expect(text).toContain('Поле: Коментар');
    expect(text).not.toContain('<td>');
  });

  it('перетворює списки в рядки з тире', () => {
    const text = byHeading('Створення акта')?.text ?? '';
    expect(text).toContain('- Поле «Сума» обов\'язкове.');
    expect(text).toContain('- Дата акта не може бути в майбутньому.');
  });

  it('декодує HTML-сутності й не лишає тегів', () => {
    const all = blocks.map((block) => block.text).join('\n');
    expect(all).not.toMatch(/&(amp|nbsp|laquo|raquo);/);
    expect(all).not.toMatch(/<[a-z/!]/i);
    expect(byHeading('Акти виконаних робіт')?.text).toContain('«Кібер»');
    expect(byHeading('Створення акта')?.text).toContain('договору & року');
  });

  it('дає anchor для повернення в Confluence', () => {
    expect(byHeading('Створення акта')?.anchor).toBe('Створенняакта');
  });

  it('ріже довгий блок по абзацах до maxChars', () => {
    const paragraph = 'Абзац вимоги про акти. '.repeat(20);
    const html = `<h2>Довгий розділ</h2>${Array.from({ length: 8 }, () => `<p>${paragraph}</p>`).join('')}`;
    const chunks = splitIntoBlocks(html, { maxChars: 600 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((block) => block.text.length <= 600)).toBe(true);
    expect(chunks[0]?.heading).toBe('Довгий розділ (частина 1)');
    expect(chunks[1]?.heading).toBe('Довгий розділ (частина 2)');
    // Anchor лишається спільним — усі частини ведуть на той самий заголовок.
    expect(new Set(chunks.map((block) => block.anchor)).size).toBe(1);
  });

  it('повертає порожній масив для порожнього вмісту', () => {
    expect(splitIntoBlocks('')).toEqual([]);
    expect(splitIntoBlocks('   \n  ')).toEqual([]);
  });
});

describe('splitIntoBlocks (текст і markdown)', () => {
  it('ріже markdown за заголовками #', () => {
    const md = [
      '# Акти',
      '',
      'Вступний абзац.',
      '',
      '## Створення',
      '',
      '- Сума обов’язкова',
      '- Дата не в майбутньому',
      '',
      '### Поля',
      '',
      'Номер до 20 символів.',
    ].join('\n');
    const blocks = splitIntoBlocks(md, { format: 'markdown' });
    expect(blocks.map((block) => block.heading)).toEqual(['Акти', 'Створення', 'Поля']);
    expect(blocks[1]?.text).toContain('- Сума обов’язкова');
  });

  it('ріже вставлений текст за нумерованими й КАПСОМ заголовками', () => {
    const text = [
      'ЗАГАЛЬНІ ВИМОГИ',
      '',
      'Система працює з актами.',
      '',
      '2. Створення акта',
      '',
      'Менеджер створює акт із карти договору.',
      '',
      '2.1 Валідація',
      '',
      'Сума більше нуля.',
    ].join('\n');
    const blocks = splitIntoBlocks(text, { format: 'text' });
    expect(blocks.map((block) => block.heading)).toEqual([
      'ЗАГАЛЬНІ ВИМОГИ',
      '2. Створення акта',
      '2.1 Валідація',
    ]);
    expect(blocks[2]?.text).toBe('Сума більше нуля.');
  });
});

describe('hashBlock', () => {
  it('sha256, перші 16 символів', () => {
    const hash = hashBlock('Сума акта більше нуля');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('стабільний до зайвих пробілів і перенесень рядків', () => {
    expect(hashBlock('Акт\n  без суми  ')).toBe(hashBlock('Акт\nбез суми'));
    expect(hashBlock('Акт без суми\r\nдруга')).toBe(hashBlock('Акт без суми\nдруга'));
  });

  it('змінюється на зміну змісту', () => {
    expect(hashBlock('Сума > 0')).not.toBe(hashBlock('Сума >= 0'));
  });
});

describe('parseConfluencePageId', () => {
  it('розпізнає типові URL', () => {
    expect(
      parseConfluencePageId('https://acme.atlassian.net/wiki/spaces/QA/pages/123456789/Акти'),
    ).toBe('123456789');
    expect(parseConfluencePageId('https://acme.atlassian.net/wiki/spaces/QA/pages/987654321')).toBe(
      '987654321',
    );
    expect(
      parseConfluencePageId('https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=555'),
    ).toBe('555');
    expect(parseConfluencePageId('https://acme.atlassian.net/wiki/api/v2/pages/42')).toBe('42');
    expect(parseConfluencePageId('  123  ')).toBe('123');
  });

  it('повертає null, коли ID немає', () => {
    expect(parseConfluencePageId('https://acme.atlassian.net/wiki/spaces/QA/overview')).toBeNull();
    expect(parseConfluencePageId('просто текст')).toBeNull();
  });
});

describe('isConfluenceConfigured', () => {
  const keys = ['CONFLUENCE_BASE_URL', 'CONFLUENCE_EMAIL', 'CONFLUENCE_API_TOKEN'] as const;
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of keys) {
      original[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it('false без змінних оточення', () => {
    expect(isConfluenceConfigured()).toBe(false);
  });

  it('false, якщо задано лише частину', () => {
    process.env.CONFLUENCE_BASE_URL = 'https://acme.atlassian.net/wiki';
    expect(isConfluenceConfigured()).toBe(false);
  });

  it('true, коли задані всі три', () => {
    process.env.CONFLUENCE_BASE_URL = 'https://acme.atlassian.net/wiki';
    process.env.CONFLUENCE_EMAIL = 'qa@acme.com';
    process.env.CONFLUENCE_API_TOKEN = 'token-value';
    expect(isConfluenceConfigured()).toBe(true);
  });
});

describe('fetchConfluencePage (fetch підмінений, без мережі)', () => {
  const TOKEN = 'confluence-api-token-9876543210';
  const keys = ['CONFLUENCE_BASE_URL', 'CONFLUENCE_EMAIL', 'CONFLUENCE_API_TOKEN'] as const;
  const original: Record<string, string | undefined> = {};
  let fetchMock: ReturnType<typeof vi.fn>;

  function respond(status: number, body: unknown): Response {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: `status ${status}`,
      text: async () => text,
      json: async () => JSON.parse(text),
    } as unknown as Response;
  }

  const v2Page = {
    id: '123456789',
    title: 'Акти виконаних робіт',
    version: { number: 7 },
    body: { storage: { value: '<h1>Акти</h1><p>Текст вимоги.</p>' } },
    _links: { webui: '/spaces/QA/pages/123456789/Акти', base: 'https://acme.atlassian.net/wiki' },
  };

  beforeEach(() => {
    resetSecrets();
    for (const key of keys) original[key] = process.env[key];
    process.env.CONFLUENCE_BASE_URL = 'https://acme.atlassian.net/wiki/';
    process.env.CONFLUENCE_EMAIL = 'qa@acme.com';
    process.env.CONFLUENCE_API_TOKEN = TOKEN;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetSecrets();
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it('тягне сторінку через v2 з Basic auth і розпізнає pageId з URL', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, v2Page));

    const page = await fetchConfluencePage({
      url: 'https://acme.atlassian.net/wiki/spaces/QA/pages/123456789/Акти',
    });

    expect(page).toEqual({
      externalId: '123456789',
      title: 'Акти виконаних робіт',
      version: '7',
      html: '<h1>Акти</h1><p>Текст вимоги.</p>',
      url: 'https://acme.atlassian.net/wiki/spaces/QA/pages/123456789/Акти',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://acme.atlassian.net/wiki/api/v2/pages/123456789?body-format=storage');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from(`qa@acme.com:${TOKEN}`, 'utf-8').toString('base64')}`,
    );
  });

  it('падає на v1, якщо v2 віддав 404', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(404, 'not found'))
      .mockResolvedValueOnce(respond(200, { ...v2Page, version: { number: 3 } }));

    const page = await fetchConfluencePage({ pageId: '123456789' });
    expect(page.version).toBe('3');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://acme.atlassian.net/wiki/rest/api/content/123456789?expand=body.storage,version',
    );
  });

  it('помилка 401 не містить токена й підказує, що перевірити', async () => {
    fetchMock.mockResolvedValue(respond(401, `Unauthorized for token ${TOKEN}`));

    const error = (await fetchConfluencePage({ pageId: '1' }).catch(
      (e: unknown) => e,
    )) as ConfluenceError;

    expect(error).toBeInstanceOf(ConfluenceError);
    expect(error.status).toBe(401);
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain('CONFLUENCE_API_TOKEN');
  });

  it('без pageId у посиланні — зрозуміла помилка, без запиту', async () => {
    await expect(
      fetchConfluencePage({ url: 'https://acme.atlassian.net/wiki/spaces/QA/overview' }),
    ).rejects.toThrow(/Не вдалося визначити ID сторінки/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('без змінних оточення — помилка з переліком змінних', async () => {
    delete process.env.CONFLUENCE_API_TOKEN;
    await expect(fetchConfluencePage({ pageId: '1' })).rejects.toThrow(/CONFLUENCE_API_TOKEN/);
  });

  it('сторінка без storage-тіла — зрозуміла помилка', async () => {
    fetchMock.mockResolvedValue(respond(200, { id: '1', title: 'Порожня', version: { number: 1 } }));
    await expect(fetchConfluencePage({ pageId: '1' })).rejects.toThrow(/storage-форматі/);
  });
});
