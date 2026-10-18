/**
 * Клієнт Jira Server / Data Center (REST API v2; у замовника Jira 9.12.9).
 *
 * Відмінності від Jira Cloud, через які клієнт для Cloud тут не годиться:
 *  - автентифікація — Personal Access Token: `Authorization: Bearer <PAT>`
 *    (з'явився в 8.14); токен реєструється в `registerSecret` і ніде не друкується;
 *  - опис і коментарі — вікі-розмітка, а не ADF;
 *  - виконавець задається `{ name: <username> }`, а не `accountId`.
 *
 * Повтор: 429 — завжди (запит не виконано, повтор безпечний); 502/503/504 —
 * лише для GET, бо повтор POST на 5xx може створити дубль задачі.
 *
 * Модуль чистий: без бази, `fetch` і `sleep` підміняються через опції.
 */
import { IntegrationError, registerSecret, shortBody } from './errors.js';

/** Помилка Jira. `status` — HTTP-код відповіді (0 — мережа чи таймаут). */
export class JiraError extends IntegrationError {
  constructor(message: string, options?: { status?: number; details?: unknown; cause?: unknown }) {
    super(message, options);
    this.name = 'JiraError';
  }
}

export interface JiraClientOptions {
  /** Корінь Jira без `/rest`: `https://jira.example.com` або `https://host/jira`. */
  baseUrl: string;
  /** Personal Access Token сервісного облікового запису. */
  token: string;
  fetch?: typeof fetch;
  /** Дефолт 30 000 мс. */
  timeoutMs?: number;
  /** Пауза між повторами; у тестах — миттєва. */
  sleep?: (ms: number) => Promise<void>;
  /** Дефолт 5. */
  maxRetries?: number;
  /** База експоненційної паузи, мс. Дефолт 500. */
  retryBaseMs?: number;
}

export interface JiraIssue {
  key: string;
  id: string;
  fields: Record<string, unknown>;
}

export interface JiraCreateIssueInput {
  projectKey: string;
  issueType: string;
  summary: string;
  /** Вікі-розмітка Jira. */
  description: string;
  labels?: string[];
  /** Username (Data Center), не accountId. */
  assignee?: string;
}

export interface JiraUpdateIssueFields {
  summary?: string;
  description?: string;
  labels?: string[];
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_BASE_MS = 500;
const MAX_RETRY_WAIT_MS = 30_000;
const DEFAULT_SEARCH_LIMIT = 1000;
const SEARCH_PAGE = 100;

type Method = 'GET' | 'POST' | 'PUT';

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Чи задані змінні оточення для Jira. */
export function isJiraConfigured(): boolean {
  const { JIRA_BASE_URL, JIRA_TOKEN } = process.env;
  return Boolean(JIRA_BASE_URL && JIRA_TOKEN);
}

/** Створює клієнт зі змінних оточення `JIRA_BASE_URL`, `JIRA_TOKEN`. */
export function createJiraClientFromEnv(overrides?: Partial<JiraClientOptions>): JiraClient {
  const { JIRA_BASE_URL, JIRA_TOKEN } = process.env;
  if (!JIRA_BASE_URL || !JIRA_TOKEN) {
    throw new JiraError(
      'Jira не налаштовано. Додайте в .env: JIRA_BASE_URL і JIRA_TOKEN (PAT сервісного облікового запису).',
      { status: 400 },
    );
  }
  return new JiraClient({ baseUrl: JIRA_BASE_URL, token: JIRA_TOKEN, ...overrides });
}

/**
 * Екранує значення для JQL-рядка в подвійних лапках (лапки додає викликач):
 * `project = "${escapeJql(key)}"`.
 */
export function escapeJql(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n|\r/g, ' ');
}

/** Посилання на задачу в інтерфейсі Jira. */
export function jiraIssueUrl(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/browse/${encodeURIComponent(key)}`;
}

/** Текст помилки з тіла Jira: `errorMessages[]` і `errors{поле: текст}`. */
function jiraErrorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { errorMessages?: unknown; errors?: unknown; message?: unknown };
    const parts: string[] = [];
    if (Array.isArray(parsed.errorMessages)) {
      parts.push(...parsed.errorMessages.filter((m): m is string => typeof m === 'string' && m.trim() !== ''));
    }
    if (parsed.errors && typeof parsed.errors === 'object') {
      for (const [field, message] of Object.entries(parsed.errors as Record<string, unknown>)) {
        parts.push(`${field}: ${String(message)}`);
      }
    }
    if (parts.length === 0 && typeof parsed.message === 'string') parts.push(parsed.message);
    if (parts.length > 0) return shortBody(parts.join('; '), 500);
  } catch {
    // Не JSON — це HTML сторінки помилки чи проксі; нижче покажемо початок тіла.
  }
  return shortBody(body.replace(/<[^>]+>/g, ' '));
}

export class JiraClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: JiraClientOptions) {
    if (!opts.baseUrl) throw new JiraError('Не задано JIRA_BASE_URL.', { status: 400 });
    if (!opts.token) throw new JiraError('Не задано JIRA_TOKEN.', { status: 400 });
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    registerSecret(opts.token);
    this.token = opts.token;
    // Через лямбду: глобальний fetch, викликаний як метод об'єкта, падає з «Illegal invocation».
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseMs = opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** `Retry-After` у секундах або HTTP-даті; інакше експоненційна пауза. */
  private retryDelay(header: string | null, attempt: number): number {
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_WAIT_MS);
      const date = Date.parse(header);
      if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_WAIT_MS);
    }
    return Math.min(this.retryBaseMs * 2 ** attempt, MAX_RETRY_WAIT_MS);
  }

  private async request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}/rest/api/2/${path}`;
    let lastStatus = 0;
    let lastBody = '';

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new JiraError(`Не вдалося звернутися до Jira (${method} ${path}): ${reason}`, { cause: error });
      }

      if (response.ok) {
        const text = await response.text();
        if (!text.trim()) return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new JiraError(
            `Jira повернула не-JSON на ${method} ${path} — схоже на сторінку входу (SSO) або проксі. ` +
              `Перевірте JIRA_BASE_URL. Відповідь: ${shortBody(text)}`,
            { status: response.status },
          );
        }
      }

      lastStatus = response.status;
      lastBody = await response.text().catch(() => response.statusText);
      const retryable =
        response.status === 429 || (method === 'GET' && [502, 503, 504].includes(response.status));
      if (retryable && attempt < this.maxRetries) {
        await this.sleep(this.retryDelay(response.headers.get('retry-after'), attempt));
        continue;
      }
      break;
    }

    throw new JiraError(this.describeFailure(lastStatus, lastBody, method, path), { status: lastStatus });
  }

  private describeFailure(status: number, body: string, method: string, path: string): string {
    const detail = jiraErrorDetail(body);
    const hint =
      status === 401
        ? ' Jira не прийняла токен: перевірте JIRA_TOKEN (PAT, не пароль) і чи не сплив його строк.'
        : status === 403
          ? ' Сервісному обліковому запису бракує прав у цьому проєкті (Browse / Create / Edit Issues).'
          : status === 404
            ? ' Не знайдено: перевірте ключ проєкту чи задачі й JIRA_BASE_URL (з контекстом, якщо Jira не в корені).'
            : status === 429
              ? ' Перевищено ліміт запитів Jira — спробуйте пізніше.'
              : status === 400
                ? ' Jira відхилила дані (обов’язкові поля, тип задачі, мітки без пробілів, username виконавця).'
                : '';
    return `Jira ${status} на ${method} ${path}.${hint}${detail ? ` Відповідь: ${detail}` : ''}`;
  }

  /** Версія й базова адреса інстансу — перевірка зв'язку і токена. */
  async serverInfo(): Promise<{ version: string; baseUrl: string }> {
    const info = await this.request<{ version?: string; baseUrl?: string }>('GET', 'serverInfo');
    return { version: String(info?.version ?? ''), baseUrl: String(info?.baseUrl ?? this.baseUrl) };
  }

  /** Пошук JQL із пагінацією. `maxResults` — загальна межа результатів (дефолт 1000). */
  async search(jql: string, opts?: { fields?: string[]; maxResults?: number }): Promise<JiraIssue[]> {
    const limit = Math.max(0, opts?.maxResults ?? DEFAULT_SEARCH_LIMIT);
    const out: JiraIssue[] = [];
    while (out.length < limit) {
      const page = await this.request<{ issues?: unknown[]; total?: number }>('POST', 'search', {
        jql,
        startAt: out.length,
        maxResults: Math.min(SEARCH_PAGE, limit - out.length),
        ...(opts?.fields ? { fields: opts.fields } : {}),
      });
      const issues = Array.isArray(page?.issues) ? page.issues : [];
      for (const raw of issues) {
        const issue = raw as { key?: unknown; id?: unknown; fields?: unknown };
        out.push({
          key: String(issue.key ?? ''),
          id: String(issue.id ?? ''),
          fields: issue.fields && typeof issue.fields === 'object' ? (issue.fields as Record<string, unknown>) : {},
        });
      }
      const total = typeof page?.total === 'number' ? page.total : out.length;
      if (issues.length === 0 || out.length >= total) break;
    }
    return out.slice(0, limit);
  }

  async createIssue(input: JiraCreateIssueInput): Promise<{ key: string; id: string }> {
    const fields: Record<string, unknown> = {
      project: { key: input.projectKey },
      issuetype: { name: input.issueType },
      summary: input.summary,
      description: input.description,
    };
    if (input.labels && input.labels.length > 0) fields.labels = input.labels;
    if (input.assignee) fields.assignee = { name: input.assignee };
    const created = await this.request<{ key?: string; id?: string }>('POST', 'issue', { fields });
    if (!created?.key) {
      throw new JiraError('Jira не повернула ключ створеної задачі.', { status: 502 });
    }
    return { key: created.key, id: String(created.id ?? '') };
  }

  async updateIssue(key: string, fields: JiraUpdateIssueFields): Promise<void> {
    const payload: Record<string, unknown> = {};
    if (fields.summary !== undefined) payload.summary = fields.summary;
    if (fields.description !== undefined) payload.description = fields.description;
    if (fields.labels !== undefined) payload.labels = fields.labels;
    if (Object.keys(payload).length === 0) return;
    await this.request<unknown>('PUT', `issue/${encodeURIComponent(key)}`, { fields: payload });
  }

  /** Коментар у вікі-розмітці. */
  async addComment(key: string, body: string): Promise<void> {
    await this.request<unknown>('POST', `issue/${encodeURIComponent(key)}/comment`, { body });
  }
}

/**
 * Задача тижня: шукаємо за міткою, знайдено → оновлюємо, інакше створюємо.
 * Мітка — ключ ідемпотентності, тому повторний запуск не робить дубля.
 */
export async function upsertWeeklyIssue(
  client: JiraClient,
  input: {
    projectKey: string;
    issueType: string;
    label: string;
    summary: string;
    description: string;
    assignee?: string;
  },
): Promise<{ key: string; created: boolean }> {
  const jql = `project = "${escapeJql(input.projectKey)}" AND labels = "${escapeJql(input.label)}"`;
  const found = await client.search(jql, { fields: ['summary', 'labels'], maxResults: 1 });
  const existing = found[0];
  if (existing) {
    const current = Array.isArray(existing.fields.labels)
      ? existing.fields.labels.filter((l): l is string => typeof l === 'string')
      : [];
    // Мітки, які люди додали руками, не губимо.
    const labels = current.includes(input.label) ? current : [...current, input.label];
    await client.updateIssue(existing.key, {
      summary: input.summary,
      description: input.description,
      labels,
    });
    return { key: existing.key, created: false };
  }
  const created = await client.createIssue({
    projectKey: input.projectKey,
    issueType: input.issueType,
    summary: input.summary,
    description: input.description,
    labels: [input.label],
    assignee: input.assignee,
  });
  return { key: created.key, created: true };
}
