import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSecrets } from '../../../src/integrations/errors.js';
import {
  JiraClient,
  JiraError,
  escapeJql,
  isJiraConfigured,
  jiraIssueUrl,
  upsertWeeklyIssue,
} from '../../../src/integrations/jira.js';

const TOKEN = 'jira-pat-secret-NjQ5MzE2ODkyNzQ1';

function respond(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  const payload = typeof body === 'string' ? body : body === undefined ? '' : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => payload,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
let sleeps: number[];

function client(): JiraClient {
  return new JiraClient({
    baseUrl: 'https://jira.example.com/',
    token: TOKEN,
    fetch: fetchMock as unknown as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    retryBaseMs: 10,
  });
}

function call(i: number): { url: string; init: RequestInit; body: any } {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
  return { url, init, body: init.body ? JSON.parse(String(init.body)) : undefined };
}

beforeEach(() => {
  resetSecrets();
  fetchMock = vi.fn();
  sleeps = [];
});

afterEach(() => {
  resetSecrets();
  vi.unstubAllEnvs();
});

describe('JiraClient', () => {
  it('ходить у /rest/api/2/… з Bearer-токеном', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, { version: '9.12.9', baseUrl: 'https://jira.example.com' }));
    expect(await client().serverInfo()).toEqual({ version: '9.12.9', baseUrl: 'https://jira.example.com' });
    const { url, init } = call(0);
    expect(url).toBe('https://jira.example.com/rest/api/2/serverInfo');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('шукає з пагінацією через POST /search', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(200, { total: 3, issues: [{ key: 'A-1', id: '1', fields: { summary: 'x' } }, { key: 'A-2', id: 2 }] }))
      .mockResolvedValueOnce(respond(200, { total: 3, issues: [{ key: 'A-3', id: '3', fields: {} }] }));
    const issues = await client().search('project = "A"', { fields: ['summary'] });
    expect(issues.map((i) => i.key)).toEqual(['A-1', 'A-2', 'A-3']);
    expect(issues[1]).toEqual({ key: 'A-2', id: '2', fields: {} });
    expect(call(0).url).toBe('https://jira.example.com/rest/api/2/search');
    expect(call(0).body).toEqual({ jql: 'project = "A"', startAt: 0, maxResults: 100, fields: ['summary'] });
    expect(call(1).body.startAt).toBe(2);
  });

  it('повертає порожній список, коли нічого не знайдено', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, { total: 0, issues: [] }));
    expect(await client().search('labels = "none"')).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('створює задачу з username виконавця для Data Center', async () => {
    fetchMock.mockResolvedValueOnce(respond(201, { id: '10001', key: 'CYBER-77' }));
    const created = await client().createIssue({
      projectKey: 'CYBER',
      issueType: 'Task',
      summary: 'S',
      description: 'h2. D',
      labels: ['jules-weekly-2026-W42'],
      assignee: 'qa.lead',
    });
    expect(created).toEqual({ key: 'CYBER-77', id: '10001' });
    expect(call(0).url).toBe('https://jira.example.com/rest/api/2/issue');
    expect(call(0).body).toEqual({
      fields: {
        project: { key: 'CYBER' },
        issuetype: { name: 'Task' },
        summary: 'S',
        description: 'h2. D',
        labels: ['jules-weekly-2026-W42'],
        assignee: { name: 'qa.lead' },
      },
    });
  });

  it('оновлює задачу через PUT і додає коментар', async () => {
    fetchMock.mockResolvedValueOnce(respond(204)).mockResolvedValueOnce(respond(201, { id: '5' }));
    const jira = client();
    await jira.updateIssue('CYBER-7', { description: 'нове' });
    await jira.addComment('CYBER-7', 'коментар');
    expect(call(0).url).toBe('https://jira.example.com/rest/api/2/issue/CYBER-7');
    expect(call(0).init.method).toBe('PUT');
    expect(call(0).body).toEqual({ fields: { description: 'нове' } });
    expect(call(1).url).toBe('https://jira.example.com/rest/api/2/issue/CYBER-7/comment');
    expect(call(1).body).toEqual({ body: 'коментар' });
  });

  it('повторює запит на 429 з Retry-After', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(429, '', { 'retry-after': '2' }))
      .mockResolvedValueOnce(respond(429, ''))
      .mockResolvedValueOnce(respond(201, { id: '1', key: 'CYBER-1' }));
    const created = await client().createIssue({ projectKey: 'CYBER', issueType: 'Task', summary: 's', description: 'd' });
    expect(created.key).toBe('CYBER-1');
    expect(sleeps).toEqual([2000, 20]);
  });

  it('не повторює POST на 503, щоб не створити дубль', async () => {
    fetchMock.mockResolvedValue(respond(503, 'Service Unavailable'));
    await expect(
      client().createIssue({ projectKey: 'CYBER', issueType: 'Task', summary: 's', description: 'd' }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('кидає JiraError з errorMessages і errors без токена в тексті', async () => {
    fetchMock.mockResolvedValueOnce(
      respond(400, {
        errorMessages: ['Поле обов’язкове'],
        errors: { labels: 'The label cannot contain spaces', token: TOKEN },
      }),
    );
    const error = await client()
      .createIssue({ projectKey: 'CYBER', issueType: 'Task', summary: 's', description: 'd' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JiraError);
    expect((error as JiraError).status).toBe(400);
    const message = (error as Error).message;
    expect(message).toContain('Jira 400 на POST issue');
    expect(message).toContain('Поле обов’язкове');
    expect(message).toContain('labels: The label cannot contain spaces');
    expect(message).not.toContain(TOKEN);
  });

  it('пояснює 401 і не-JSON відповідь (сторінка входу)', async () => {
    fetchMock.mockResolvedValueOnce(respond(401, ''));
    await expect(client().serverInfo()).rejects.toThrow(/JIRA_TOKEN/);
    fetchMock.mockResolvedValueOnce(respond(200, '<html>Log in</html>'));
    await expect(client().serverInfo()).rejects.toThrow(/не-JSON/);
  });

  it('загортає мережеву помилку в JiraError', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(client().serverInfo()).rejects.toThrow(/Не вдалося звернутися до Jira.*ECONNREFUSED/);
  });
});

describe('upsertWeeklyIssue', () => {
  const input = {
    projectKey: 'CYBER',
    issueType: 'Task',
    label: 'jules-weekly-2026-W42',
    summary: 'QA: тижневий звіт Cyber 2026-W42',
    description: 'h2. Звіт',
  };

  it('створює задачу, якщо задачі тижня ще немає', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(200, { total: 0, issues: [] }))
      .mockResolvedValueOnce(respond(201, { id: '9', key: 'CYBER-9' }));
    expect(await upsertWeeklyIssue(client(), input)).toEqual({ key: 'CYBER-9', created: true });
    expect(call(0).body.jql).toBe('project = "CYBER" AND labels = "jules-weekly-2026-W42"');
    expect(call(1).body.fields.labels).toEqual(['jules-weekly-2026-W42']);
  });

  it('оновлює знайдену задачу, зберігаючи наявні мітки', async () => {
    fetchMock
      .mockResolvedValueOnce(
        respond(200, { total: 1, issues: [{ key: 'CYBER-5', id: '5', fields: { labels: ['qa', 'jules-weekly-2026-W42'] } }] }),
      )
      .mockResolvedValueOnce(respond(204));
    expect(await upsertWeeklyIssue(client(), input)).toEqual({ key: 'CYBER-5', created: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(call(1).init.method).toBe('PUT');
    expect(call(1).url).toBe('https://jira.example.com/rest/api/2/issue/CYBER-5');
    expect(call(1).body).toEqual({
      fields: { summary: input.summary, description: input.description, labels: ['qa', 'jules-weekly-2026-W42'] },
    });
  });
});

describe('допоміжні функції', () => {
  it('escapeJql екранує лапки й зворотні слеші', () => {
    expect(escapeJql('a"b\\c\nd')).toBe('a\\"b\\\\c d');
  });

  it('jiraIssueUrl будує посилання /browse/KEY', () => {
    expect(jiraIssueUrl('https://jira.example.com/jira/', 'CYBER-1')).toBe('https://jira.example.com/jira/browse/CYBER-1');
  });

  it('isJiraConfigured перевіряє JIRA_BASE_URL і JIRA_TOKEN', () => {
    vi.stubEnv('JIRA_BASE_URL', 'https://jira.example.com');
    vi.stubEnv('JIRA_TOKEN', '');
    expect(isJiraConfigured()).toBe(false);
    vi.stubEnv('JIRA_TOKEN', 'x');
    expect(isJiraConfigured()).toBe(true);
  });

  it('конструктор вимагає адресу й токен', () => {
    expect(() => new JiraClient({ baseUrl: '', token: TOKEN })).toThrow(JiraError);
    expect(() => new JiraClient({ baseUrl: 'https://x', token: '' })).toThrow(/JIRA_TOKEN/);
  });
});
