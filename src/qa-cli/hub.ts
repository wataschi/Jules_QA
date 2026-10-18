/**
 * HTTP-клієнт хаба Jules для CLI: `${hub}/api/registry/*` з таймаутом і повтором на 429.
 *
 * Мережеві збої (немає Tailscale, хаб вимкнено, таймаут, 502–504 від `tailscale serve`)
 * — окремий тип `HubUnavailable`: хуки й `inbox` на нього тихо мовчать, а CI падає явно.
 * Відмова самого хаба (4xx/5xx з тілом) — `HubError` зі статусом.
 */
import { registerSecret } from '../integrations/errors.js';

export class HubUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HubUnavailable';
  }
}

export class HubError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'HubError';
    this.status = status;
  }
}

export interface HubClientOptions {
  hub: string;
  token?: string;
  fetch: typeof fetch;
  timeoutMs?: number;
  /** Скільки разів повторювати на 429 (разом із першою спробою). */
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type Query = Record<string, string | number | undefined | null>;

export interface HubClient {
  readonly baseUrl: string;
  getJson<T>(route: string, query?: Query): Promise<T>;
  getText(route: string, query?: Query): Promise<string>;
  postJson<T>(route: string, body: unknown): Promise<T>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const UNAVAILABLE_STATUSES = new Set([502, 503, 504]);

function buildUrl(base: string, route: string, query?: Query): string {
  const url = new URL(`${base}${route.startsWith('/') ? route : `/${route}`}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function retryAfterMs(header: string | null, attempt: number): number {
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  const date = header ? Date.parse(header) : NaN;
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 60_000));
  return Math.min(1000 * 2 ** (attempt - 1), 30_000);
}

function shortText(text: string, limit = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

export function createHubClient(opts: HubClientOptions): HubClient {
  const baseUrl = `${opts.hub.replace(/\/+$/, '')}/api/registry`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  registerSecret(opts.token);

  async function request(method: 'GET' | 'POST', url: string, body?: unknown, accept = 'application/json') {
    const headers: Record<string, string> = { Accept: accept };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await opts.fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const reason =
          (error as Error)?.name === 'TimeoutError' || (error as Error)?.name === 'AbortError'
            ? `немає відповіді за ${Math.round(timeoutMs / 1000)} с`
            : ((error as { cause?: { code?: string } })?.cause?.code ?? (error as Error)?.message ?? String(error));
        throw new HubUnavailable(`Jules недоступний (${opts.hub}): ${reason}. Перевірте Tailscale.`);
      }

      if (response.status === 429 && attempt < maxAttempts) {
        await sleep(retryAfterMs(response.headers.get('retry-after'), attempt));
        continue;
      }
      if (UNAVAILABLE_STATUSES.has(response.status)) {
        throw new HubUnavailable(`Jules недоступний (${opts.hub}): HTTP ${response.status}.`);
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        let detail = text;
        try {
          const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
          detail = String(parsed.error ?? parsed.message ?? text);
        } catch {
          /* не JSON — показуємо як є */
        }
        const hint =
          response.status === 401 || response.status === 403
            ? ' Перевірте JULES_TOKEN (машинний токен проєкту видається в Jules → «Налаштування»).'
            : '';
        throw new HubError(
          `Jules відповів ${response.status} на ${method} ${new URL(url).pathname}: ${shortText(detail)}${hint}`.trim(),
          response.status,
        );
      }
      return response;
    }
  }

  return {
    baseUrl,
    async getJson<T>(route: string, query?: Query) {
      const response = await request('GET', buildUrl(baseUrl, route, query));
      return (await response.json()) as T;
    },
    async getText(route: string, query?: Query) {
      const response = await request('GET', buildUrl(baseUrl, route, query), undefined, 'text/markdown, text/plain, */*');
      return response.text();
    },
    async postJson<T>(route: string, body: unknown) {
      const response = await request('POST', buildUrl(baseUrl, route), body);
      const text = await response.text();
      return (text ? JSON.parse(text) : {}) as T;
    },
  };
}
