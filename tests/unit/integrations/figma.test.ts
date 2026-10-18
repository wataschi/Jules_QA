import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSecrets } from '../../../src/integrations/errors.js';
import {
  FigmaClient,
  FigmaError,
  extractFrames,
  extractFramesFromFile,
  frameToBlockText,
  isFigmaConfigured,
  parseFigmaUrl,
  type FigmaFile,
  type FigmaNode,
} from '../../../src/integrations/figma.js';

const TOKEN = 'figd_super-secret-token-1234567890';
const FIXTURE = path.resolve(import.meta.dirname, '../../fixtures/figma/login-file.json');

function readFile(): FigmaFile {
  return JSON.parse(readFileSync(FIXTURE, 'utf-8')) as FigmaFile;
}

interface FakeResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  text?: string;
  bytes?: Buffer;
}

function respond({ status = 200, body, headers = {}, text, bytes }: FakeResponse): Response {
  const payload = text ?? (body === undefined ? '' : JSON.stringify(body));
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => payload,
    json: async () => JSON.parse(payload),
    arrayBuffer: async () => {
      const buf = bytes ?? Buffer.from(payload);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
  } as unknown as Response;
}

function client(fetchMock: ReturnType<typeof vi.fn>) {
  const sleeps: number[] = [];
  const instance = new FigmaClient({
    token: TOKEN,
    fetch: fetchMock as unknown as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { instance, sleeps };
}

function headersOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): Record<string, string> {
  return (fetchMock.mock.calls[call]![1] as RequestInit).headers as Record<string, string>;
}

describe('parseFigmaUrl', () => {
  it('розбирає посилання design з node-id і переводить 12-345 у 12:345', () => {
    expect(
      parseFigmaUrl('https://www.figma.com/design/AbC123xyz/Кабінет?node-id=12-345&t=abc-1'),
    ).toEqual({ fileKey: 'AbC123xyz', nodeId: '12:345', kind: 'design' });
  });

  it('розпізнає file, proto і board', () => {
    expect(parseFigmaUrl('https://figma.com/file/KEY1/Name')).toEqual({ fileKey: 'KEY1', kind: 'file' });
    expect(parseFigmaUrl('https://www.figma.com/proto/KEY2/Name?node-id=1%3A2')).toEqual({
      fileKey: 'KEY2',
      nodeId: '1:2',
      kind: 'proto',
    });
    expect(parseFigmaUrl('www.figma.com/board/KEY3/Board')).toEqual({ fileKey: 'KEY3', kind: 'board' });
  });

  it('бере ключ гілки й розгортає embed-посилання Widget Connector', () => {
    expect(parseFigmaUrl('https://www.figma.com/design/MAIN1/branch/BRANCH9/Name')?.fileKey).toBe('BRANCH9');
    const embed = `https://www.figma.com/embed?embed_host=confluence&url=${encodeURIComponent(
      'https://www.figma.com/file/EMB1/Name?node-id=3-4',
    )}`;
    expect(parseFigmaUrl(embed)).toEqual({ fileKey: 'EMB1', nodeId: '3:4', kind: 'file' });
  });

  it('повертає null для чужих доменів, невідомих розділів і сміття', () => {
    expect(parseFigmaUrl('https://example.com/design/KEY/x')).toBeNull();
    expect(parseFigmaUrl('https://notfigma.com/file/KEY/x')).toBeNull();
    expect(parseFigmaUrl('https://www.figma.com/files/recent')).toBeNull();
    expect(parseFigmaUrl('https://www.figma.com/design/')).toBeNull();
    expect(parseFigmaUrl('')).toBeNull();
    expect(parseFigmaUrl('не посилання')).toBeNull();
  });
});

describe('isFigmaConfigured', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('true лише коли задано FIGMA_TOKEN', () => {
    vi.stubEnv('FIGMA_TOKEN', '');
    expect(isFigmaConfigured()).toBe(false);
    vi.stubEnv('FIGMA_TOKEN', TOKEN);
    expect(isFigmaConfigured()).toBe(true);
  });
});

describe('FigmaClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetSecrets();
    fetchMock = vi.fn();
  });

  afterEach(() => {
    resetSecrets();
  });

  it('шле токен у заголовку X-Figma-Token і передає depth у getFile', async () => {
    fetchMock.mockResolvedValueOnce(respond({ body: readFile() }));
    const { instance } = client(fetchMock);
    const file = await instance.getFile('KEY1', { depth: 2 });
    expect(file.name).toBe('Кабінет клієнта');
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.figma.com/v1/files/KEY1?depth=2');
    expect(headersOf(fetchMock)['X-Figma-Token']).toBe(TOKEN);
  });

  it('getVersion робить легкий запит depth=1', async () => {
    fetchMock.mockResolvedValueOnce(
      respond({ body: { name: 'F', version: '42', lastModified: '2026-01-01T00:00:00Z', document: {} } }),
    );
    const { instance } = client(fetchMock);
    expect(await instance.getVersion('KEY1')).toEqual({
      version: '42',
      lastModified: '2026-01-01T00:00:00Z',
      name: 'F',
    });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.figma.com/v1/files/KEY1?depth=1');
  });

  it('повторює запит на 429 з паузою з Retry-After', async () => {
    fetchMock
      .mockResolvedValueOnce(respond({ status: 429, headers: { 'Retry-After': '3' }, text: 'rate limited' }))
      .mockResolvedValueOnce(respond({ body: { nodes: { '1:2': { document: { id: '1:2', name: 'A', type: 'FRAME' } } } } }));
    const { instance, sleeps } = client(fetchMock);
    const nodes = await instance.getNodes('KEY1', ['1:2']);
    expect(nodes['1:2']!.document.name).toBe('A');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([3000]);
  });

  it('не чекає годинами: довгий Retry-After одразу дає FigmaError 429', async () => {
    fetchMock.mockResolvedValueOnce(
      respond({ status: 429, headers: { 'Retry-After': '86400', 'X-Figma-Plan-Tier': 'starter' }, text: '{}' }),
    );
    const { instance, sleeps } = client(fetchMock);
    const error = await instance.getFile('KEY1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FigmaError);
    expect((error as FigmaError).status).toBe(429);
    expect((error as FigmaError).retryAfterMs).toBe(86_400_000);
    expect((error as FigmaError).message).toContain('Full або Dev');
    expect(sleeps).toEqual([]);
  });

  it('після 5 невдалих повторів кидає FigmaError зі статусом 429', async () => {
    fetchMock.mockResolvedValue(respond({ status: 429, text: 'slow down' }));
    const { instance, sleeps } = client(fetchMock);
    await expect(instance.getFile('KEY1')).rejects.toMatchObject({ name: 'FigmaError', status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(sleeps).toHaveLength(5);
  });

  it('на 403 кидає FigmaError без токена в тексті й без повторів', async () => {
    fetchMock.mockResolvedValueOnce(
      respond({ status: 403, text: `{"status":403,"err":"Invalid token ${TOKEN}"}` }),
    );
    const { instance } = client(fetchMock);
    const error = (await instance.getFile('KEY1').catch((caught: unknown) => caught)) as FigmaError;
    expect(error).toBeInstanceOf(FigmaError);
    expect(error.status).toBe(403);
    expect(error.message).toContain('FIGMA_TOKEN');
    expect(error.message).not.toContain(TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('загортає мережеву помилку у FigmaError', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    const { instance } = client(fetchMock);
    await expect(instance.getFile('KEY1')).rejects.toThrow(/Не вдалося звернутися до Figma.*ECONNRESET/);
  });

  it('не створюється без токена', () => {
    expect(() => new FigmaClient({ token: '' })).toThrow(FigmaError);
  });

  it('getImageUrls передає формат і масштаб, порожній список — без запиту', async () => {
    fetchMock.mockResolvedValueOnce(
      respond({ body: { err: null, images: { '1:2': 'https://s3.example/1.png', '2:2': null } } }),
    );
    const { instance } = client(fetchMock);
    expect(await instance.getImageUrls('KEY1', [], {})).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
    const images = await instance.getImageUrls('KEY1', ['1:2', '2:2'], { format: 'png', scale: 2 });
    expect(images).toEqual({ '1:2': 'https://s3.example/1.png', '2:2': null });
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/v1/images/KEY1');
    expect(url.searchParams.get('ids')).toBe('1:2,2:2');
    expect(url.searchParams.get('format')).toBe('png');
    expect(url.searchParams.get('scale')).toBe('2');
  });

  it('getImageUrls кидає FigmaError, якщо Figma повернула err', async () => {
    fetchMock.mockResolvedValueOnce(respond({ body: { err: 'Render timeout', images: {} } }));
    const { instance } = client(fetchMock);
    await expect(instance.getImageUrls('KEY1', ['1:2'])).rejects.toThrow(/Render timeout/);
  });

  it('download повертає байти й тип, не надсилаючи токен на S3', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    fetchMock.mockResolvedValueOnce(respond({ bytes: png, headers: { 'Content-Type': 'image/png; charset=binary' } }));
    const { instance } = client(fetchMock);
    const result = await instance.download('https://s3.example/1.png');
    expect(result.mediaType).toBe('image/png');
    expect(result.data.equals(png)).toBe(true);
    expect(headersOf(fetchMock)['X-Figma-Token']).toBeUndefined();
  });
});

describe('extractFrames', () => {
  const file = readFile();
  const frames = extractFramesFromFile(file);
  const login = frames.find((frame) => frame.nodeId === '1:2')!;

  it('бере кадри верхнього рівня з усіх сторінок, включно з секціями, без прихованих', () => {
    expect(frames.map((frame) => [frame.nodeId, frame.name, frame.pageName])).toEqual([
      ['1:2', 'Login', 'Вхід'],
      ['2:2', 'Login / Error', 'Вхід'],
      ['3:1', 'Button', 'Компоненти'],
    ]);
  });

  it('упорядковує тексти за y, потім x, пропускає приховані й повтори підряд', () => {
    expect(login.texts).toEqual(['Вхід', 'Email', 'Пароль', 'Забули пароль?', 'Увійти']);
  });

  it('збирає унікальні інстанси з властивостями-рядками без вкладених інстансів', () => {
    expect(login.components).toEqual([
      { name: 'Button', properties: { Variant: 'Primary', State: 'Disabled', Label: 'Увійти' } },
      { name: 'Input', properties: { State: 'Error', 'Show hint': 'true' } },
    ]);
  });

  it('заповнює розміри кадру й хеш із 16 hex', () => {
    expect(login.width).toBe(375);
    expect(login.height).toBe(812);
    expect(login.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('хеш стабільний: не змінюється від перестановки шарів і зайвих полів', () => {
    const copy = readFile();
    const frameNode = copy.document.children![0]!.children![0]!;
    frameNode.children = [...frameNode.children!].reverse();
    (frameNode as FigmaNode & { fills?: unknown }).fills = [{ type: 'SOLID' }];
    const again = extractFramesFromFile(copy).find((frame) => frame.nodeId === '1:2')!;
    expect(again.hash).toBe(login.hash);
  });

  it('хеш змінюється, коли змінився текст на макеті', () => {
    const copy = readFile();
    copy.document.children![0]!.children![0]!.children![0]!.characters = 'Новий пароль';
    const changed = extractFramesFromFile(copy).find((frame) => frame.nodeId === '1:2')!;
    expect(changed.hash).not.toBe(login.hash);
  });

  it('вважає кадром сам корінь, якщо запитано конкретний FRAME', () => {
    const node = file.document.children![0]!.children![2]!.children![0]!;
    const result = extractFrames(node, { pageName: 'Вхід' });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ nodeId: '2:2', pageName: 'Вхід', texts: ['Невірний пароль'] });
  });

  it('повертає порожній список для вузла, що не є кадром чи сторінкою', () => {
    expect(extractFrames({ id: '9:9', name: 'T', type: 'TEXT', characters: 'x' })).toEqual([]);
    expect(extractFrames({ id: '0:1', name: 'Порожня', type: 'CANVAS', children: [] })).toEqual([]);
  });
});

describe('frameToBlockText', () => {
  it('описує екран, тексти й компоненти зі станами', () => {
    const login = extractFramesFromFile(readFile())[0]!;
    expect(frameToBlockText(login)).toBe(
      [
        'Екран: Login',
        'Тексти:',
        '- Вхід',
        '- Email',
        '- Пароль',
        '- Забули пароль?',
        '- Увійти',
        'Компоненти й стани:',
        '- Button (Variant=Primary, State=Disabled, Label=Увійти)',
        '- Input (State=Error, Show hint=true)',
      ].join('\n'),
    );
  });

  it('для порожнього кадру лишає тільки назву екрана', () => {
    expect(
      frameToBlockText({ nodeId: '1:1', name: 'Splash', pageName: '', texts: [], components: [], hash: '0' }),
    ).toBe('Екран: Splash');
  });
});
