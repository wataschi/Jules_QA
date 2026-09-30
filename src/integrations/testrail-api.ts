/**
 * Клієнт TestRail API v2.
 *
 * Особливості, які ламають наївні клієнти й тому реалізовані тут явно:
 *  - шлях завжди `index.php?/api/v2/...` (так, зі знаком питання);
 *  - Basic auth: `TESTRAIL_USER` + `TESTRAIL_API_KEY`; ключ ніде не логується
 *    і вирізається з тексту будь-якої помилки (`registerSecret`);
 *  - 429 з `Retry-After` — до 5 повторів з експоненційною паузою;
 *  - TestRail 6.7+ віддає списки з пагінацією (`{ offset, limit, cases: [] }`),
 *    старіші — просто масив: обробляємо обидва варіанти;
 *  - `update_cases` — пакетне оновлення однаковими значеннями: один запит на
 *    багато кейсів (інакше на 500 кейсах отримуємо 500 запитів і 429).
 */
import { TestrailError, registerSecret, shortBody } from './errors.js';

export interface TestrailClientOptions {
  baseUrl: string;
  user: string;
  apiKey: string;
  /** Дефолт 30 000 мс. */
  timeoutMs?: number;
  /** Дефолт 5 повторів на 429/5xx. */
  maxRetries?: number;
  /** Пауза між повторами. Підміняється в тестах, щоб не чекати насправді. */
  sleep?: (ms: number) => Promise<void>;
  /** База експоненційної паузи, мс. Дефолт 500. */
  retryBaseMs?: number;
}

export interface TestrailSection {
  id: number;
  name: string;
  parent_id: number | null;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_BASE_MS = 500;
const MAX_RETRY_WAIT_MS = 30_000;
/** TestRail приймає до 250 кейсів на один `update_cases`. */
const UPDATE_CHUNK = 250;
const MAX_PAGES = 200;

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Чи задані змінні оточення для TestRail API. */
export function isTestrailConfigured(): boolean {
  const { TESTRAIL_BASE_URL, TESTRAIL_USER, TESTRAIL_API_KEY } = process.env;
  return Boolean(TESTRAIL_BASE_URL && TESTRAIL_USER && TESTRAIL_API_KEY);
}

/** Створює клієнт зі змінних оточення. Кидає помилку з підказкою, якщо їх немає. */
export function createTestrailClientFromEnv(
  overrides?: Partial<TestrailClientOptions>,
): TestrailClient {
  const { TESTRAIL_BASE_URL, TESTRAIL_USER, TESTRAIL_API_KEY } = process.env;
  if (!TESTRAIL_BASE_URL || !TESTRAIL_USER || !TESTRAIL_API_KEY) {
    throw new TestrailError(
      'TestRail не налаштовано. Додайте в .env: TESTRAIL_BASE_URL, TESTRAIL_USER, TESTRAIL_API_KEY. ' +
        'Без них доступні лише експорти CSV/XML.',
      { status: 400 },
    );
  }
  return new TestrailClient({
    baseUrl: TESTRAIL_BASE_URL,
    user: TESTRAIL_USER,
    apiKey: TESTRAIL_API_KEY,
    ...overrides,
  });
}

export class TestrailClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: TestrailClientOptions) {
    if (!opts.baseUrl) throw new TestrailError('Не задано TESTRAIL_BASE_URL.', { status: 400 });
    if (!opts.user) throw new TestrailError('Не задано TESTRAIL_USER.', { status: 400 });
    if (!opts.apiKey) throw new TestrailError('Не задано TESTRAIL_API_KEY.', { status: 400 });

    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    // Ключ живе лише в заголовку; у реєстр секретів — щоб не протік у помилку.
    registerSecret(opts.apiKey);
    this.authHeader = `Basic ${Buffer.from(`${opts.user}:${opts.apiKey}`, 'utf-8').toString('base64')}`;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseMs = opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** `Retry-After` у секундах або HTTP-даті; інакше експоненційна пауза. */
  private retryDelay(header: string | null, attempt: number): number {
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, MAX_RETRY_WAIT_MS);
      }
      const date = Date.parse(header);
      if (!Number.isNaN(date)) {
        return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_WAIT_MS);
      }
    }
    return Math.min(this.retryBaseMs * 2 ** attempt, MAX_RETRY_WAIT_MS);
  }

  /** Один виклик API з повторами на 429/5xx. */
  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}/index.php?/api/v2/${path}`;
    let lastStatus = 0;
    let lastBody = '';

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: {
            Authorization: this.authHeader,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new TestrailError(`Не вдалося звернутися до TestRail (${method} ${path}): ${reason}`, {
          cause: error,
        });
      }

      if (response.ok) {
        const text = await response.text();
        if (!text.trim()) return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new TestrailError(
            `TestRail повернув не-JSON на ${method} ${path}: ${shortBody(text)}`,
            { status: response.status },
          );
        }
      }

      lastStatus = response.status;
      lastBody = await response.text().catch(() => response.statusText);

      if (RETRYABLE_STATUSES.has(response.status) && attempt < this.maxRetries) {
        const delay = this.retryDelay(response.headers.get('retry-after'), attempt);
        await this.sleep(delay);
        continue;
      }
      break;
    }

    throw new TestrailError(this.describeFailure(lastStatus, lastBody, method, path), {
      status: lastStatus,
    });
  }

  private describeFailure(status: number, body: string, method: string, path: string): string {
    // `shortBody` вирізає ключ, якщо TestRail віддав його в ехо-відповіді.
    const detail = shortBody(body);
    const hint =
      status === 401 || status === 403
        ? ' Перевірте TESTRAIL_USER (email) і TESTRAIL_API_KEY (ключ із My Settings → API Keys).'
        : status === 429
          ? ' Перевищено ліміт запитів TestRail — спробуйте пізніше або зменшіть розмір пакета.'
          : status === 400
            ? ' TestRail відхилив дані запиту (перевірте мапінг полів і обов’язкові кастомні поля).'
            : '';
    return `TestRail ${status} на ${method} ${path}.${hint}${detail ? ` Відповідь: ${detail}` : ''}`;
  }

  /**
   * Список із пагінацією: TestRail 6.7+ віддає `{ offset, limit, <key>: [] }`
   * і `_links.next`, старіші — просто масив.
   */
  private async getList<T>(path: string, key: string): Promise<T[]> {
    const out: T[] = [];
    let nextPath: string | null = path;
    let pages = 0;

    while (nextPath && pages < MAX_PAGES) {
      pages += 1;
      const raw: unknown = await this.request<unknown>('GET', nextPath);
      if (Array.isArray(raw)) {
        out.push(...(raw as T[]));
        break;
      }
      const payload = (raw ?? {}) as Record<string, unknown> & {
        _links?: { next?: string | null };
      };
      const items = payload[key];
      if (Array.isArray(items)) out.push(...(items as T[]));

      const next = payload._links?.next;
      // `_links.next` приходить як `/api/v2/get_cases/1&limit=250&offset=250`.
      nextPath = next ? next.replace(/^\/?api\/v2\//, '') : null;
    }
    return out;
  }

  async getSections(projectId: number, suiteId?: number): Promise<TestrailSection[]> {
    const suffix = suiteId ? `&suite_id=${suiteId}` : '';
    return this.getList<TestrailSection>(`get_sections/${projectId}${suffix}`, 'sections');
  }

  async addSection(
    projectId: number,
    name: string,
    parentId?: number,
    suiteId?: number,
  ): Promise<{ id: number }> {
    const payload: Record<string, unknown> = { name };
    if (parentId) payload.parent_id = parentId;
    if (suiteId) payload.suite_id = suiteId;
    return this.request<{ id: number }>('POST', `add_section/${projectId}`, payload);
  }

  async getCases(
    projectId: number,
    suiteId?: number,
    sectionId?: number,
  ): Promise<Array<Record<string, unknown>>> {
    let suffix = suiteId ? `&suite_id=${suiteId}` : '';
    if (sectionId) suffix += `&section_id=${sectionId}`;
    return this.getList<Record<string, unknown>>(`get_cases/${projectId}${suffix}`, 'cases');
  }

  async addCase(sectionId: number, payload: Record<string, unknown>): Promise<{ id: number }> {
    return this.request<{ id: number }>('POST', `add_case/${sectionId}`, payload);
  }

  async updateCase(caseId: number, payload: Record<string, unknown>): Promise<void> {
    await this.request<unknown>('POST', `update_case/${caseId}`, payload);
  }

  /**
   * Пакетне оновлення однаковими значеннями — один запит на багато кейсів.
   * Розбивається на порції по 250 ID.
   */
  async updateCases(
    suiteId: number,
    caseIds: number[],
    payload: Record<string, unknown>,
  ): Promise<void> {
    const unique = [...new Set(caseIds.filter((id) => Number.isInteger(id) && id > 0))];
    if (unique.length === 0) return;
    for (let i = 0; i < unique.length; i += UPDATE_CHUNK) {
      const chunk = unique.slice(i, i + UPDATE_CHUNK);
      await this.request<unknown>('POST', `update_cases/${suiteId}`, {
        ...payload,
        case_ids: chunk,
      });
    }
  }

  async getRuns(projectId: number): Promise<Array<Record<string, unknown>>> {
    return this.getList<Record<string, unknown>>(`get_runs/${projectId}`, 'runs');
  }

  async getResultsForRun(runId: number): Promise<Array<Record<string, unknown>>> {
    return this.getList<Record<string, unknown>>(`get_results_for_run/${runId}`, 'results');
  }
}

export { TestrailError };
