import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { applyThinkingControls } from './thinking.js';

/**
 * LM Studio OpenAI-compatible endpoint reverse proxy.
 *
 * It sits between the model clients (Midscene grounding, planner/critic) and the
 * upstream LM Studio server (reachable directly or over a Tailscale tunnel) and
 * applies two transparent fixes to every `/chat/completions` request:
 *
 * 1. Image-format correction (`normalizeImageDataUris`). LM Studio's
 *    OpenAI-compatible endpoint mishandles certain base64 image prefixes — most
 *    notably `data:image/webp;base64,` — returning `'url' field must be a base64
 *    encoded image` or empty content, even though the model is fully capable.
 *    Instead of blindly swapping webp→png, we sniff the *actual* bytes by magic
 *    number (the HiveADE approach) and rewrite the data-URL prefix to match the
 *    real format. This corrects mislabelled payloads in either direction without
 *    corrupting genuinely-encoded images.
 *
 * 2. Thinking-mode suppression (`applyThinkingControls`). Local Qwen "thinking"
 *    models otherwise burn their token budget on internal reasoning and return
 *    empty `content`. See `./thinking.ts`.
 *
 * Doing this at the proxy keeps it model-agnostic and independent of Midscene's
 * internal request shape.
 *
 * See: https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1752
 *      https://github.com/cline/cline/issues/9902
 */

/** Magic-number signatures, longest-first where prefixes overlap. */
type ImageSig = { mime: string; test: (b: Buffer) => boolean };
const IMAGE_SIGNATURES: ImageSig[] = [
  {
    mime: 'image/png',
    test: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47,
  },
  { mime: 'image/jpeg', test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/gif',
    test: (b) => b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  },
  {
    mime: 'image/webp',
    test: (b) =>
      b.length >= 12 &&
      b.toString('ascii', 0, 4) === 'RIFF' &&
      b.toString('ascii', 8, 12) === 'WEBP',
  },
];

const DATA_URL_RE = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/is;

/** Returns the true mime from leading bytes, or null if unrecognised. */
function sniffMime(b64Head: string): string | null {
  let head: Buffer;
  try {
    head = Buffer.from(b64Head.slice(0, 32), 'base64');
  } catch {
    return null;
  }
  for (const sig of IMAGE_SIGNATURES) {
    if (sig.test(head)) return sig.mime;
  }
  return null;
}

export interface LmStudioProxyHandle {
  /** Local base URL to hand to model clients (keeps the upstream path, e.g. `/v1`). */
  url: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * Recursively corrects every base64 image data-URL whose declared mime does not
 * match its actual bytes (sniffed by magic number), in place. Returns `true` if
 * anything changed.
 *
 * Example: a real PNG mislabelled as `data:image/webp;base64,…` becomes
 * `data:image/png;base64,…`. Genuinely-encoded images are left untouched.
 */
export function normalizeImageDataUris(node: unknown): boolean {
  let changed = false;

  const fix = (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    const match = DATA_URL_RE.exec(value);
    if (!match) return value;
    const declared = value.slice(5, value.indexOf(';base64,'));
    const sniffed = sniffMime(match[1]);
    if (sniffed && sniffed !== declared) {
      changed = true;
      return `data:${sniffed};base64,${match[1]}`;
    }
    return value;
  };

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const next = fix(node[i]);
      if (next !== node[i]) {
        node[i] = next;
      } else if (node[i] && typeof node[i] === 'object') {
        changed = normalizeImageDataUris(node[i]) || changed;
      }
    }
  } else if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const next = fix(obj[key]);
      if (next !== obj[key]) {
        obj[key] = next;
      } else if (obj[key] && typeof obj[key] === 'object') {
        changed = normalizeImageDataUris(obj[key]) || changed;
      }
    }
  }

  return changed;
}

/** @deprecated Back-compat alias; use {@link normalizeImageDataUris}. */
export const rewriteImageDataUris = normalizeImageDataUris;

/* ─────────────────────────── Лічильник викликів моделі ───────────────────────
 * Питання «чи справді regression іде без LLM» до цього не мало відповіді. Тут
 * живе єдиний лічильник `/chat/completions`-запитів: проксі інкрементує його для
 * всього, що йде через нього, а `installModelCallCounter()` додатково перехоплює
 * глобальний fetch — це потрібно тому, що проксі стартує в runner-процесі
 * Playwright (global-setup), а сам рушій крокує у worker-процесі, тож без хука
 * лічильник у воркері завжди лишався б нулем.
 * ─────────────────────────────────────────────────────────────────────────── */

let modelCallCount = 0;

/** Інкрементує лічильник викликів моделі (один HTTP-запит = один виклик). */
/** Шлях, за яким проксі віддає лічильник викликів моделі. */
export const METRICS_PATH = '/__jules/metrics';

/** Адреса лічильника, якщо рушій ходить до моделі через локальний проксі. */
export function proxyMetricsUrl(): string | null {
  const candidates = [
    process.env.MIDSCENE_OPENAI_BASE_URL,
    process.env.MIDSCENE_VQA_BASE_URL,
    process.env.MIDSCENE_MODEL_BASE_URL,
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
        return `${url.origin}${METRICS_PATH}`;
      }
    } catch {
      /* некоректний URL — пробуємо наступний */
    }
  }
  return null;
}

/** Поточний лічильник проксі або `null`, якщо проксі недоступний. */
export async function readProxyModelCalls(): Promise<number | null> {
  const url = proxyMetricsUrl();
  if (!url) return null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    const data = (await response.json()) as { calls?: number };
    return typeof data.calls === 'number' ? data.calls : null;
  } catch {
    return null;
  }
}

export function countModelCall(): void {
  modelCallCount++;
}

export function getModelCallCount(): number {
  return modelCallCount;
}

export function resetModelCallCount(): void {
  modelCallCount = 0;
}

/** Знімає поточне значення та скидає лічильник (для міток «за крок»). */
export function takeModelCallCount(): number {
  const value = modelCallCount;
  modelCallCount = 0;
  return value;
}

const CHAT_COMPLETIONS_RE = /\/chat\/completions(?:\?|$)/;

let fetchHookInstalled = false;

function requestUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (input && typeof input === 'object' && 'url' in input) {
    return String((input as { url: unknown }).url);
  }
  return '';
}

/**
 * Одноразово обгортає `globalThis.fetch`, щоб рахувати виклики моделі в тому
 * процесі, де крокує рушій. Повертає `true`, якщо хук справді встановлено.
 */
export function installModelCallCounter(): boolean {
  if (fetchHookInstalled) return true;
  const original = globalThis.fetch;
  if (typeof original !== 'function') return false;

  globalThis.fetch = ((input: Parameters<typeof original>[0], init?: Parameters<typeof original>[1]) => {
    if (CHAT_COMPLETIONS_RE.test(requestUrl(input))) {
      countModelCall();
    }
    return original(input, init);
  }) as typeof original;

  fetchHookInstalled = true;
  return true;
}

function buildLocalUrl(port: number, basePath: string): string {
  return `http://127.0.0.1:${port}${basePath}`;
}

/**
 * Starts the proxy. When `port` is busy (e.g. another worker already started an
 * instance) the function resolves with a handle pointing at the existing port
 * instead of throwing, so concurrent Playwright workers stay functional.
 */
export async function startLmStudioProxy(opts: {
  upstreamBaseUrl: string;
  port?: number;
}): Promise<LmStudioProxyHandle> {
  const upstream = new URL(opts.upstreamBaseUrl);
  const basePath = upstream.pathname.replace(/\/$/, '');
  const desiredPort = opts.port ?? 0;

  const server = http.createServer((req, res) => {
    // Лічильник викликів моделі читає інший процес: рушій крокує у воркері
    // Playwright, а проксі живе в процесі раннера.
    if (req.method === 'GET' && (req.url ?? '').startsWith(METRICS_PATH)) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ calls: getModelCallCount() }));
      return;
    }
    void forward(req, res, upstream).catch((error) => {
      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
      }
      res.end(JSON.stringify({ error: { message: `proxy error: ${String(error)}` } }));
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(desiredPort, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE' && desiredPort) {
      return {
        url: buildLocalUrl(desiredPort, basePath),
        port: desiredPort,
        close: async () => undefined,
      };
    }
    throw error;
  }

  const port = (server.address() as AddressInfo).port;

  return {
    url: buildLocalUrl(port, basePath),
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function forward(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstream: URL,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  let body = Buffer.concat(chunks);

  const reqUrl = req.url ?? '';
  const isChat = req.method === 'POST' && /\/chat\/completions$/.test(reqUrl);

  // Проксі — єдина точка, через яку проходить увесь трафік до моделі, тому рахуємо тут завжди.
  // Подвійного обліку немає: fetch-хук ставиться лише у воркері, а проксі живе в раннері.
  if (isChat) {
    countModelCall();
  }

  if (isChat && body.length > 0) {
    try {
      const json = JSON.parse(body.toString('utf-8'));
      const imagesFixed = normalizeImageDataUris(json);
      const thinkingFixed =
        json && typeof json === 'object'
          ? applyThinkingControls(json as Record<string, unknown>)
          : false;
      if (imagesFixed || thinkingFixed) {
        body = Buffer.from(JSON.stringify(json), 'utf-8');
      }
    } catch {
      /* not JSON — forward untouched */
    }
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower === 'host' || lower === 'content-length' || lower === 'connection') continue;
    headers[key] = Array.isArray(value) ? value.join(', ') : value;
  }

  const method = req.method ?? 'GET';
  const targetUrl = upstream.origin + reqUrl;

  const upstreamResponse = await fetch(targetUrl, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
  });

  res.statusCode = upstreamResponse.status;
  upstreamResponse.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === 'content-encoding' || lower === 'transfer-encoding' || lower === 'content-length') {
      return;
    }
    res.setHeader(key, value);
  });

  const responseBuffer = Buffer.from(await upstreamResponse.arrayBuffer());
  res.end(responseBuffer);
}
