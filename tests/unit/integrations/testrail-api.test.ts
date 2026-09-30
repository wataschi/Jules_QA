import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSecrets } from '../../../src/integrations/errors.js';
import {
  TestrailClient,
  TestrailError,
  createTestrailClientFromEnv,
  isTestrailConfigured,
} from '../../../src/integrations/testrail-api.js';

const API_KEY = 'super-secret-api-key-1234567890';

interface FakeResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  text?: string;
}

function respond({ status = 200, body, headers = {}, text }: FakeResponse): Response {
  const payload = text ?? (body === undefined ? '' : JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => payload,
    json: async () => JSON.parse(payload),
  } as unknown as Response;
}

/** Клієнт із моментальною «паузою» — щоб тести не чекали справжні секунди. */
function client(extra: Partial<ConstructorParameters<typeof TestrailClient>[0]> = {}) {
  const sleeps: number[] = [];
  const instance = new TestrailClient({
    baseUrl: 'https://acme.testrail.io/',
    user: 'qa@acme.com',
    apiKey: API_KEY,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    retryBaseMs: 100,
    ...extra,
  });
  return { instance, sleeps };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetSecrets();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSecrets();
});

describe('TestrailClient — базовий запит', () => {
  it('використовує index.php?/api/v2/... і Basic auth', async () => {
    fetchMock.mockResolvedValueOnce(respond({ body: { sections: [{ id: 1, name: 'Акти', parent_id: null }] } }));
    const { instance } = client();
    const sections = await instance.getSections(7, 3);

    expect(sections).toEqual([{ id: 1, name: 'Акти', parent_id: null }]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://acme.testrail.io/index.php?/api/v2/get_sections/7&suite_id=3');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from(`qa@acme.com:${API_KEY}`, 'utf-8').toString('base64')}`,
    );
  });

  it('розуміє і масив, і пагінований конверт TestRail 6.7+', async () => {
    fetchMock
      .mockResolvedValueOnce(
        respond({
          body: {
            offset: 0,
            limit: 250,
            cases: [{ id: 1 }],
            _links: { next: '/api/v2/get_cases/7&limit=250&offset=250' },
          },
        }),
      )
      .mockResolvedValueOnce(respond({ body: { cases: [{ id: 2 }], _links: { next: null } } }));

    const { instance } = client();
    const cases = await instance.getCases(7);
    expect(cases).toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://acme.testrail.io/index.php?/api/v2/get_cases/7&limit=250&offset=250',
    );
  });

  it('старий формат — просто масив', async () => {
    fetchMock.mockResolvedValueOnce(respond({ body: [{ id: 5 }] }));
    const { instance } = client();
    expect(await instance.getRuns(7)).toEqual([{ id: 5 }]);
  });
});

describe('TestrailClient — 429 і повтори', () => {
  it('чекає Retry-After і повторює запит', async () => {
    fetchMock
      .mockResolvedValueOnce(respond({ status: 429, headers: { 'retry-after': '2' }, text: 'rate limit' }))
      .mockResolvedValueOnce(respond({ body: { sections: [] } }));

    const { instance, sleeps } = client();
    await expect(instance.getSections(7)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([2000]);
  });

  it('без Retry-After пауза експоненційна', async () => {
    fetchMock
      .mockResolvedValueOnce(respond({ status: 429, text: 'rate limit' }))
      .mockResolvedValueOnce(respond({ status: 429, text: 'rate limit' }))
      .mockResolvedValueOnce(respond({ status: 429, text: 'rate limit' }))
      .mockResolvedValueOnce(respond({ body: { runs: [] } }));

    const { instance, sleeps } = client();
    await instance.getRuns(7);
    expect(sleeps).toEqual([100, 200, 400]);
  });

  it('після 5 повторів здається і віддає TestrailError зі status', async () => {
    fetchMock.mockResolvedValue(respond({ status: 429, text: 'rate limit' }));
    const { instance, sleeps } = client();

    const error = await instance.getSections(7).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TestrailError);
    expect((error as TestrailError).status).toBe(429);
    expect((error as TestrailError).message).toContain('Перевищено ліміт запитів');
    expect(fetchMock).toHaveBeenCalledTimes(6); // перша спроба + 5 повторів
    expect(sleeps).toHaveLength(5);
  });

  it('4xx не повторюється', async () => {
    fetchMock.mockResolvedValue(respond({ status: 400, text: 'bad field' }));
    const { instance } = client();
    await expect(instance.addCase(1, {})).rejects.toBeInstanceOf(TestrailError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('TestrailClient — ключ не протікає', () => {
  it('ключа немає ні в повідомленні помилки, ні в її serialization', async () => {
    // Найгірший випадок: TestRail відбиває наш запит разом із заголовком.
    fetchMock.mockResolvedValue(
      respond({
        status: 401,
        text: `Authentication failed for request with Authorization: Basic ${Buffer.from(
          `qa@acme.com:${API_KEY}`,
        ).toString('base64')} and key ${API_KEY}`,
      }),
    );
    const { instance } = client();
    const error = (await instance.getSections(7).catch((e: unknown) => e)) as TestrailError;

    expect(error).toBeInstanceOf(TestrailError);
    expect(error.status).toBe(401);
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).not.toContain(Buffer.from(`qa@acme.com:${API_KEY}`).toString('base64'));
    expect(JSON.stringify({ message: error.message })).not.toContain(API_KEY);
    expect(error.message).toContain('TESTRAIL_API_KEY');
  });

  it('помилка транспорту теж без ключа', async () => {
    fetchMock.mockRejectedValue(new Error(`connect ECONNREFUSED (key ${API_KEY})`));
    const { instance } = client();
    const error = (await instance.getRuns(1).catch((e: unknown) => e)) as TestrailError;
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).toContain('Не вдалося звернутися до TestRail');
  });
});

describe('TestrailClient.updateCases', () => {
  it('одним запитом оновлює багато кейсів', async () => {
    fetchMock.mockResolvedValue(respond({ body: {} }));
    const { instance } = client();
    await instance.updateCases(3, [10, 11, 12], { priority_id: 4 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://acme.testrail.io/index.php?/api/v2/update_cases/3');
    expect(JSON.parse(String(init.body))).toEqual({ priority_id: 4, case_ids: [10, 11, 12] });
  });

  it('ріже на порції по 250 і прибирає дублі та сміття', async () => {
    fetchMock.mockResolvedValue(respond({ body: {} }));
    const { instance } = client();
    const ids = [...Array.from({ length: 300 }, (_, i) => i + 1), 1, 0, -5];
    await instance.updateCases(3, ids, { type_id: 7 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body));
    expect(firstBody.case_ids).toHaveLength(250);
    expect(secondBody.case_ids).toHaveLength(50);
    expect(firstBody.type_id).toBe(7);
  });

  it('порожній список не робить запитів', async () => {
    const { instance } = client();
    await instance.updateCases(3, [], { priority_id: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('конфігурація з оточення', () => {
  const keys = ['TESTRAIL_BASE_URL', 'TESTRAIL_USER', 'TESTRAIL_API_KEY'] as const;
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

  it('isTestrailConfigured бачить усі три змінні', () => {
    expect(isTestrailConfigured()).toBe(false);
    process.env.TESTRAIL_BASE_URL = 'https://acme.testrail.io';
    process.env.TESTRAIL_USER = 'qa@acme.com';
    expect(isTestrailConfigured()).toBe(false);
    process.env.TESTRAIL_API_KEY = API_KEY;
    expect(isTestrailConfigured()).toBe(true);
  });

  it('createTestrailClientFromEnv підказує, чого бракує', () => {
    const error = (() => {
      try {
        createTestrailClientFromEnv();
        return null;
      } catch (e) {
        return e as TestrailError;
      }
    })();
    expect(error).toBeInstanceOf(TestrailError);
    expect(error?.message).toContain('TESTRAIL_BASE_URL');
    expect(error?.status).toBe(400);
  });
});
