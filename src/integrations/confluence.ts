/**
 * Інтеграція з Confluence (Cloud і Server/Data Center): витяг сторінок вимог,
 * дерева сторінок, вкладень і розбиття storage-HTML на блоки.
 *
 * Частини:
 *  1. Конфіг і HTTP. `CONFLUENCE_BASE_URL` — повна база з контекстним шляхом
 *     (`https://wiki.corp.local`, `https://corp.local/confluence`). Вхід:
 *     `CONFLUENCE_TOKEN` (персональний токен, `Bearer`, основний для DC),
 *     `CONFLUENCE_EMAIL` + `CONFLUENCE_API_TOKEN` (Cloud, Basic) або
 *     `CONFLUENCE_USER` + `CONFLUENCE_PASSWORD` (Basic на старих Server).
 *     Варіант задає `CONFLUENCE_FLAVOR=cloud|server`, інакше `*.atlassian.net` → cloud.
 *     Повтор на 429 з `Retry-After` (до 5 спроб), таймаут `CONFLUENCE_TIMEOUT` (мс).
 *     Якщо сервер підписаний внутрішнім центром сертифікації, Jules запускають з
 *     `NODE_EXTRA_CA_CERTS=/шлях/до/ca.pem` — у коді для цього нічого немає навмисно.
 *  2. Шляхи. Cloud: спершу v2 (`/wiki/api/v2/pages/{id}`), далі v1 з `/wiki`.
 *     Server/DC: лише REST v1 без `/wiki` (`${base}/rest/api/content/{id}`).
 *  3. Посилання: ID, `viewpage.action?pageId=`, `/spaces/KEY/pages/123`,
 *     `/display/SPACE/Назва` (пошук за назвою), `/x/AbCd` (редирект), простір.
 *  4. `splitIntoBlocks` — власний мінімальний парсер storage-HTML,
 *     БЕЗ зовнішніх залежностей: нам не потрібен повноцінний DOM, потрібні
 *     межі за заголовками й читабельний для моделі текст.
 *     `splitIntoBlocksWithAssets` додатково віддає картинки, схеми, посилання на
 *     Figma і ключі Jira, прив'язані до блоку, де вони стоять.
 *
 * Чому свій парсер, а не cheerio/jsdom: storage-формат Confluence — це XHTML з
 * власними тегами `ac:`/`ri:`, і нам однаково довелося б писати правила для
 * макросів, таблиць і списків. Зовнішня залежність дала б DOM, але не правила.
 */
import { createHash } from 'node:crypto';
import { ConfluenceError, registerSecret, shortBody } from './errors.js';

export interface ConfluencePage {
  externalId: string;
  title: string;
  version: string;
  html: string;
  url: string;
  spaceKey?: string;
  /** Батьківська сторінка (останній з ancestors). */
  parentId?: string;
}

export interface RawBlock {
  heading: string;
  anchor?: string;
  text: string;
  position: number;
}

export interface SplitOptions {
  format?: 'html' | 'text' | 'markdown';
  /** Дефолт 4000 символів — довші блоки ріжуться по абзацах. */
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 4000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 1000;
const MAX_RETRY_WAIT_MS = 120_000;
const MAX_TINY_REDIRECTS = 3;
const DEFAULT_TREE_MAX_PAGES = 300;
const SEARCH_LIMIT = 50;
const DEFAULT_MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

/* ─────────────────────────────── конфіг ──────────────────────────────── */

export type ConfluenceFlavor = 'cloud' | 'server';
export type ConfluenceAuthKind = 'bearer' | 'basic-email' | 'basic-password';

/** Конфіг без секретів — його можна писати в лог. */
export interface ConfluenceConfig {
  /** База як задана, без кінцевого `/` (для Cloud — без `/wiki`). */
  baseUrl: string;
  /** Корінь для `/rest/api`, `/download`, `/x/`: для Cloud — `${baseUrl}/wiki`. */
  apiBase: string;
  flavor: ConfluenceFlavor;
  auth: ConfluenceAuthKind;
  /** Email або логін для Basic; для PAT відсутній. */
  username?: string;
  timeoutMs: number;
}

/** Підміна мережі й паузи в тестах. */
export interface ConfluenceRequestOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let sleepImpl: (ms: number) => Promise<void> = defaultSleep;

/** Тільки для тестів: пауза між повторами без реального очікування. Без аргументу — повертає справжню. */
export function __setSleepForTests(fn?: (ms: number) => Promise<void>): void {
  sleepImpl = fn ?? defaultSleep;
}

function normalizeFlavor(value: string | undefined): ConfluenceFlavor | null {
  const v = value?.trim().toLowerCase();
  if (v === 'cloud') return 'cloud';
  if (v === 'server' || v === 'dc' || v === 'datacenter' || v === 'data-center') return 'server';
  return null;
}

/**
 * Варіант Confluence: `CONFLUENCE_FLAVOR`, а без нього — за хостом
 * (`*.atlassian.net` → cloud, будь-що інше → server).
 */
export function confluenceFlavor(baseUrl?: string): ConfluenceFlavor {
  const explicit = normalizeFlavor(process.env.CONFLUENCE_FLAVOR);
  if (explicit) return explicit;
  const base = baseUrl ?? process.env.CONFLUENCE_BASE_URL;
  if (!base) return 'server';
  try {
    const host = new URL(base).hostname.toLowerCase();
    return host === 'atlassian.net' || host.endsWith('.atlassian.net') ? 'cloud' : 'server';
  } catch {
    return 'server';
  }
}

/** Чи задано базу й хоча б один повний спосіб входу. */
export function isConfluenceConfigured(): boolean {
  const env = process.env;
  if (!env.CONFLUENCE_BASE_URL) return false;
  return Boolean(
    env.CONFLUENCE_TOKEN ||
      (env.CONFLUENCE_EMAIL && env.CONFLUENCE_API_TOKEN) ||
      (env.CONFLUENCE_USER && env.CONFLUENCE_PASSWORD),
  );
}

const NOT_CONFIGURED =
  'Confluence не налаштовано. Додайте в .env CONFLUENCE_BASE_URL і один зі способів входу: ' +
  'CONFLUENCE_TOKEN (персональний токен, Server/Data Center), ' +
  'CONFLUENCE_EMAIL + CONFLUENCE_API_TOKEN (Cloud) або CONFLUENCE_USER + CONFLUENCE_PASSWORD.';

interface ResolvedConfig {
  config: ConfluenceConfig;
  authorization: string;
}

function basicAuthHeader(user: string, secret: string): string {
  const encoded = Buffer.from(`${user}:${secret}`, 'utf-8').toString('base64');
  registerSecret(encoded);
  return `Basic ${encoded}`;
}

function resolveConfig(): ResolvedConfig {
  const env = process.env;
  const rawBase = env.CONFLUENCE_BASE_URL?.trim();
  if (!rawBase) throw new ConfluenceError(NOT_CONFIGURED);
  try {
    const parsed = new URL(rawBase);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('protocol');
  } catch {
    throw new ConfluenceError(
      `CONFLUENCE_BASE_URL має бути http(s)-адресою, наприклад https://wiki.corp.local або https://corp.local/confluence.`,
    );
  }

  const flavor = confluenceFlavor(rawBase);
  const trimmed = rawBase.replace(/\/+$/, '');
  const baseUrl = flavor === 'cloud' ? trimmed.replace(/\/wiki$/i, '') : trimmed;
  const apiBase = flavor === 'cloud' ? `${baseUrl}/wiki` : baseUrl;

  const pat = env.CONFLUENCE_TOKEN;
  const email = env.CONFLUENCE_EMAIL;
  const apiToken = env.CONFLUENCE_API_TOKEN;
  const user = env.CONFLUENCE_USER;
  const password = env.CONFLUENCE_PASSWORD;

  // Cloud не приймає PAT від Server, тому там першим іде email + API-токен.
  const order: ConfluenceAuthKind[] =
    flavor === 'cloud'
      ? ['basic-email', 'bearer', 'basic-password']
      : ['bearer', 'basic-password', 'basic-email'];

  for (const kind of order) {
    let authorization: string | null = null;
    let username: string | undefined;
    if (kind === 'bearer' && pat) {
      registerSecret(pat);
      authorization = `Bearer ${pat}`;
    } else if (kind === 'basic-email' && email && apiToken) {
      registerSecret(apiToken);
      authorization = basicAuthHeader(email, apiToken);
      username = email;
    } else if (kind === 'basic-password' && user && password) {
      registerSecret(password);
      authorization = basicAuthHeader(user, password);
      username = user;
    }
    if (!authorization) continue;
    const timeout = Number(env.CONFLUENCE_TIMEOUT);
    return {
      authorization,
      config: {
        baseUrl,
        apiBase,
        flavor,
        auth: kind,
        ...(username ? { username } : {}),
        timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
      },
    };
  }
  throw new ConfluenceError(NOT_CONFIGURED);
}

/** Конфіг Confluence зі змінних оточення, без токенів і паролів (безпечно логувати). */
export function readConfluenceConfig(): ConfluenceConfig {
  return resolveConfig().config;
}

/* ───────────────────────── розпізнавання посилань ────────────────────── */

/**
 * Витягує ID сторінки з типових посилань Confluence:
 *  - `https://acme.atlassian.net/wiki/spaces/QA/pages/123456789/Назва`
 *  - `https://acme.atlassian.net/wiki/spaces/QA/pages/123456789`
 *  - `.../pages/viewpage.action?pageId=123456789`
 *  - `.../wiki/api/v2/pages/123456789`
 *  - просто `123456789`
 */
export function parseConfluencePageId(ref: string): string | null {
  const value = ref.trim();
  if (/^\d+$/.test(value)) return value;

  const patterns = [
    /[?&]pageId=(\d+)/i,
    /\/pages\/(?:edit-v2\/|edit\/)?(\d+)/i,
    /\/content\/(\d+)/i,
    /\/pages\/viewpage\.action\?.*?pageId=(\d+)/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

export type ConfluenceRef =
  | { kind: 'page'; pageId: string }
  | { kind: 'title'; spaceKey: string; title: string }
  | { kind: 'tiny'; url: string }
  | { kind: 'space'; spaceKey: string };

/** `+` у шляху `/display/` — це пробіл; справжній плюс приходить як `%2B`. */
function decodePathPart(part: string): string {
  const spaced = part.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
}

function queryParam(value: string, name: string): string | null {
  const query = value.split('#')[0]!.split('?')[1];
  if (!query) return null;
  for (const pair of query.split('&')) {
    const [key, raw = ''] = pair.split('=');
    if (key?.toLowerCase() === name.toLowerCase()) return decodePathPart(raw);
  }
  return null;
}

/**
 * Розпізнає посилання Confluence без мережі: сторінка за ID, сторінка за
 * простором і назвою (`/display/`), коротке посилання `/x/…` або простір.
 */
export function parseConfluenceRef(ref: string): ConfluenceRef | null {
  const value = ref.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return { kind: 'page', pageId: value };

  const path = value.split('#')[0]!.split('?')[0]!;

  const pageId =
    queryParam(value, 'pageId')?.match(/^\d+$/)?.[0] ??
    path.match(/\/pages\/(?:edit-v2\/|edit\/)?(\d+)(?:\/|$)/i)?.[1] ??
    path.match(/\/blog\/(?:\d{4}\/\d{2}\/\d{2}\/)?(\d+)(?:\/|$)/i)?.[1] ??
    path.match(/\/content\/(\d+)(?:\/|$)/i)?.[1];
  if (pageId) return { kind: 'page', pageId };

  if (/\/viewpage\.action$/i.test(path)) {
    const spaceKey = queryParam(value, 'spaceKey');
    const title = queryParam(value, 'title');
    if (spaceKey && title) return { kind: 'title', spaceKey, title };
  }

  const display = path.match(/\/display\/([^/]+)(?:\/(.+?))?\/?$/i);
  if (display?.[1]) {
    const spaceKey = decodePathPart(display[1]);
    if (display[2]) return { kind: 'title', spaceKey, title: decodePathPart(display[2]) };
    return { kind: 'space', spaceKey };
  }

  if (/\/x\/[A-Za-z0-9_-]+\/?$/.test(path)) return { kind: 'tiny', url: value };

  const space = path.match(/\/spaces\/([^/]+)(?:\/(?:overview|pages))?\/?$/i);
  if (space?.[1] && !/\.action$/i.test(space[1])) {
    return { kind: 'space', spaceKey: decodePathPart(space[1]) };
  }
  if (/\/spaces\/viewspace\.action$/i.test(path)) {
    const key = queryParam(value, 'key');
    if (key) return { kind: 'space', spaceKey: key };
  }
  return null;
}

/* ─────────────────────────────── HTTP ────────────────────────────────── */

interface Ctx {
  config: ConfluenceConfig;
  authorization: string;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

function makeCtx(opts?: ConfluenceRequestOptions): Ctx {
  const { config, authorization } = resolveConfig();
  return {
    config,
    authorization,
    // Беремо fetch у момент виклику, щоб підміна глобального fetch у тестах працювала.
    fetchImpl: opts?.fetch ?? globalThis.fetch,
    sleep: opts?.sleep ?? sleepImpl,
  };
}

function retryDelay(header: string | null | undefined, attempt: number): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_WAIT_MS);
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_WAIT_MS);
  }
  return Math.min(RETRY_BASE_MS * 2 ** attempt, MAX_RETRY_WAIT_MS);
}

function headerOf(response: Response, name: string): string | null {
  // Записані відповіді в тестах інколи без headers.
  const headers = (response as { headers?: Headers }).headers;
  return typeof headers?.get === 'function' ? headers.get(name) : null;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function networkHint(error: unknown, flavor: ConfluenceFlavor | undefined): string {
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code ?? (error as { code?: string })?.code ?? '';
  const text = `${code} ${cause?.message ?? ''} ${error instanceof Error ? error.message : ''}`;
  if (/CERT|certificate|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(text)) {
    return ' Схоже на внутрішній сертифікат: запустіть Jules з NODE_EXTRA_CA_CERTS=/шлях/до/ca.pem.';
  }
  if (flavor === 'server' && /ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|ENETUNREACH|EAI_AGAIN/i.test(text)) {
    return ' Перевірте, що VPN підключено і CONFLUENCE_BASE_URL правильний.';
  }
  return '';
}

/**
 * Один запит із таймаутом і повтором на 429. Повертає відповідь як є
 * (включно з помилковою) — рішення, що з нею робити, за викликачем.
 */
async function send(
  transport: {
    fetchImpl: typeof fetch;
    sleep: (ms: number) => Promise<void>;
    timeoutMs: number;
    authorization?: string;
    flavor?: ConfluenceFlavor;
  },
  url: string,
  init: { accept?: string; redirect?: 'follow' | 'manual' } = {},
): Promise<Response> {
  const headers: Record<string, string> = { Accept: init.accept ?? 'application/json' };
  if (transport.authorization) headers.Authorization = transport.authorization;

  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await transport.fetchImpl(url, {
        method: 'GET',
        headers,
        ...(init.redirect ? { redirect: init.redirect } : {}),
        signal: AbortSignal.timeout(transport.timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new ConfluenceError(
          `Confluence не відповів за ${Math.round(transport.timeoutMs / 1000)} с.` +
            (transport.flavor === 'server' ? ' Перевірте VPN або збільште CONFLUENCE_TIMEOUT.' : ' Можна збільшити CONFLUENCE_TIMEOUT.'),
          { cause: error },
        );
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new ConfluenceError(
        `Не вдалося звернутися до Confluence: ${reason}.${networkHint(error, transport.flavor)}`,
        { cause: error },
      );
    }
    if (response.status === 429 && attempt < MAX_ATTEMPTS - 1) {
      // Тіло не потрібне, але його треба вичитати, щоб звільнити з'єднання.
      await response.text().catch(() => '');
      await transport.sleep(retryDelay(headerOf(response, 'retry-after'), attempt));
      continue;
    }
    return response;
  }
}

function ctxSend(ctx: Ctx, url: string, init?: { accept?: string; redirect?: 'follow' | 'manual' }) {
  return send(
    {
      fetchImpl: ctx.fetchImpl,
      sleep: ctx.sleep,
      timeoutMs: ctx.config.timeoutMs,
      // Облікові дані — лише на свій сервер, не на зовнішні адреси з редиректів.
      ...(sameOrigin(url, ctx.config.apiBase) ? { authorization: ctx.authorization } : {}),
      flavor: ctx.config.flavor,
    },
    url,
    init,
  );
}

function authHint(config: ConfluenceConfig): string {
  if (config.auth === 'bearer') {
    return ' Перевірте CONFLUENCE_TOKEN (персональний токен: Профіль → Personal Access Tokens) і права облікового запису на простір.';
  }
  if (config.auth === 'basic-password') {
    return ' Перевірте CONFLUENCE_USER і CONFLUENCE_PASSWORD та права облікового запису на простір.';
  }
  return ' Перевірте CONFLUENCE_EMAIL і CONFLUENCE_API_TOKEN (токен створюється в Atlassian account → API tokens).';
}

function httpError(ctx: Ctx, status: number, body: string, what: string): ConfluenceError {
  const hint =
    status === 401 || status === 403
      ? authHint(ctx.config)
      : status === 404
        ? ' Не знайдено або немає прав на перегляд.'
        : status === 429
          ? ' Confluence обмежує частоту запитів, спробуйте пізніше.'
          : '';
  return new ConfluenceError(`Confluence відповів ${status} ${what}.${hint} ${shortBody(body)}`.trim(), {
    status,
  });
}

async function readJson<T>(response: Response, what: string): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ConfluenceError(
      `Confluence повернув відповідь, яка не є JSON (${what}). Можливо, це сторінка входу SSO: ${shortBody(text, 120)}`,
      { status: 502 },
    );
  }
}

async function getJson<T>(ctx: Ctx, url: string, what: string): Promise<T> {
  const response = await ctxSend(ctx, url);
  if (!response.ok) {
    const body = await response.text().catch(() => response.statusText);
    throw httpError(ctx, response.status, body, what);
  }
  return readJson<T>(response, what);
}

/** Посилання з `_links` відносно бази: з контекстним шляхом або без нього. */
function joinLink(apiBase: string, link: string): string {
  if (/^https?:\/\//i.test(link)) return link;
  const base = new URL(apiBase);
  const basePath = base.pathname.replace(/\/+$/, '');
  const path = link.startsWith('/') ? link : `/${link}`;
  if (basePath && (path === basePath || path.startsWith(`${basePath}/`))) return `${base.origin}${path}`;
  return `${apiBase}${path}`;
}

/* ──────────────────────────── завантаження ───────────────────────────── */

interface ApiLinks {
  webui?: string;
  base?: string;
  tinyui?: string;
  download?: string;
  next?: string;
  context?: string;
}

interface ApiPage {
  id?: string | number;
  title?: string;
  version?: { number?: number; createdAt?: string } | number;
  body?: { storage?: { value?: string } };
  parentId?: string | number | null;
  space?: { key?: string };
  ancestors?: Array<{ id?: string | number }>;
  _links?: ApiLinks;
}

interface ApiList<T> {
  results?: T[];
  start?: number;
  limit?: number;
  size?: number;
  totalSize?: number;
  _links?: ApiLinks;
}

function extractVersion(page: ApiPage): string {
  const version = page.version;
  if (typeof version === 'number') return String(version);
  if (version && typeof version === 'object' && typeof version.number === 'number') {
    return String(version.number);
  }
  return '0';
}

function lastAncestorId(page: ApiPage): string | undefined {
  const last = page.ancestors?.[page.ancestors.length - 1];
  return last?.id !== undefined ? String(last.id) : undefined;
}

function buildPageUrl(config: ConfluenceConfig, page: ApiPage, pageId: string, linksBase?: string): string {
  const webui = page._links?.webui;
  const base = page._links?.base ?? linksBase ?? config.apiBase;
  if (webui) {
    return webui.startsWith('http') ? webui : `${base.replace(/\/+$/, '')}${webui}`;
  }
  return `${config.apiBase}/pages/viewpage.action?pageId=${pageId}`;
}

type RefInput = string | { url?: string; pageId?: string };

function toRef(input: RefInput): { ref: ConfluenceRef | null; label: string } {
  if (typeof input === 'string') return { ref: parseConfluenceRef(input), label: input };
  const pageId = input.pageId?.trim();
  if (pageId) return { ref: { kind: 'page', pageId }, label: pageId };
  return { ref: input.url ? parseConfluenceRef(input.url) : null, label: input.url ?? '' };
}

function unrecognizedRef(label: string): ConfluenceError {
  return new ConfluenceError(
    `Не вдалося визначити ID сторінки Confluence${label ? ` з посилання ${label}` : ''}. ` +
      'Очікується посилання виду /spaces/КОД/pages/123456789/Назва, /display/КОД/Назва, ' +
      'viewpage.action?pageId=…, коротке /x/… або числовий ID.',
    { status: 400 },
  );
}

async function findPageByTitle(ctx: Ctx, spaceKey: string, title: string): Promise<string> {
  const url =
    `${ctx.config.apiBase}/rest/api/content?spaceKey=${encodeURIComponent(spaceKey)}` +
    `&title=${encodeURIComponent(title)}&type=page`;
  const list = await getJson<ApiList<ApiPage>>(ctx, url, `на пошук сторінки «${title}» у просторі ${spaceKey}`);
  const id = list.results?.[0]?.id;
  if (id === undefined || id === null || id === '') {
    throw new ConfluenceError(
      `Сторінку «${title}» у просторі ${spaceKey} не знайдено. Перевірте назву або права на простір.`,
      { status: 404 },
    );
  }
  return String(id);
}

async function followTiny(ctx: Ctx, startUrl: string): Promise<ConfluenceRef> {
  let url = /^https?:\/\//i.test(startUrl) ? startUrl : joinLink(ctx.config.apiBase, startUrl);
  for (let hop = 0; hop < MAX_TINY_REDIRECTS; hop += 1) {
    const response = await ctxSend(ctx, url, { redirect: 'manual', accept: 'text/html,*/*' });
    const location = headerOf(response, 'location');
    await response.text().catch(() => '');
    if (response.status === 401 || response.status === 403) {
      throw httpError(ctx, response.status, '', `на коротке посилання ${startUrl}`);
    }
    if (response.status < 300 || response.status >= 400 || !location) {
      throw new ConfluenceError(
        `Коротке посилання ${startUrl} не перенаправило на сторінку (відповідь ${response.status}).`,
        { status: response.status === 404 ? 404 : 502 },
      );
    }
    const next = new URL(location, url).toString();
    const ref = parseConfluenceRef(next);
    if (!ref) throw unrecognizedRef(next);
    if (ref.kind !== 'tiny') return ref;
    url = next;
  }
  throw new ConfluenceError(
    `Коротке посилання ${startUrl} дало забагато перенаправлень (більше ${MAX_TINY_REDIRECTS}).`,
    { status: 502 },
  );
}

async function resolveWithCtx(
  ctx: Ctx,
  ref: ConfluenceRef,
): Promise<{ kind: 'page'; pageId: string } | { kind: 'space'; spaceKey: string }> {
  if (ref.kind === 'page' || ref.kind === 'space') return ref;
  if (ref.kind === 'title') {
    return { kind: 'page', pageId: await findPageByTitle(ctx, ref.spaceKey, ref.title) };
  }
  const target = await followTiny(ctx, ref.url);
  if (target.kind === 'title') {
    return { kind: 'page', pageId: await findPageByTitle(ctx, target.spaceKey, target.title) };
  }
  if (target.kind === 'tiny') throw unrecognizedRef(ref.url);
  return target;
}

/**
 * Зводить будь-яке посилання до ID сторінки або ключа простору:
 * назва → пошук у просторі, коротке `/x/…` → редирект (до 3 переходів).
 */
export async function resolveConfluenceRef(
  ref: string | ConfluenceRef,
  opts?: ConfluenceRequestOptions,
): Promise<{ kind: 'page'; pageId: string } | { kind: 'space'; spaceKey: string }> {
  const ctx = makeCtx(opts);
  const parsed = typeof ref === 'string' ? parseConfluenceRef(ref) : ref;
  if (!parsed) throw unrecognizedRef(typeof ref === 'string' ? ref : '');
  return resolveWithCtx(ctx, parsed);
}

async function resolvePageId(ctx: Ctx, input: RefInput): Promise<string> {
  const { ref, label } = toRef(input);
  if (!ref) throw unrecognizedRef(label);
  if (ref.kind === 'space') {
    throw new ConfluenceError(
      `Не вдалося визначити ID сторінки: посилання ${label} веде на простір ${ref.spaceKey}, а не на сторінку. ` +
        'Для простору беріть дерево сторінок.',
      { status: 400 },
    );
  }
  const resolved = await resolveWithCtx(ctx, ref);
  if (resolved.kind !== 'page') throw unrecognizedRef(label);
  return resolved.pageId;
}

/**
 * Тягне сторінку за URL, ID або коротким посиланням у storage-форматі.
 * Cloud: v2, потім v1 з `/wiki`. Server/DC: REST v1 без `/wiki`.
 */
export async function fetchConfluencePage(
  ref: string | { url?: string; pageId?: string },
  opts?: ConfluenceRequestOptions,
): Promise<ConfluencePage> {
  const ctx = makeCtx(opts);
  const pageId = await resolvePageId(ctx, ref);
  const { apiBase, flavor } = ctx.config;

  const urls =
    flavor === 'cloud'
      ? [
          // v2 — сучасний шлях; v1 лишаємо як запасний для старих інстансів.
          `${apiBase}/api/v2/pages/${pageId}?body-format=storage`,
          `${apiBase}/rest/api/content/${pageId}?expand=body.storage,version`,
        ]
      : [`${apiBase}/rest/api/content/${pageId}?expand=body.storage,version,ancestors,space`];

  let page: ApiPage | null = null;
  for (let i = 0; i < urls.length; i += 1) {
    const response = await ctxSend(ctx, urls[i]!);
    if (response.ok) {
      page = await readJson<ApiPage>(response, `сторінка ${pageId}`);
      break;
    }
    const body = await response.text().catch(() => response.statusText);
    const canFallBack = i < urls.length - 1 && [400, 404, 405, 410, 501].includes(response.status);
    if (!canFallBack) throw httpError(ctx, response.status, body, `на сторінку ${pageId}`);
  }
  if (!page) throw new ConfluenceError(`Сторінку ${pageId} не отримано.`, { status: 502 });

  const html = page.body?.storage?.value ?? '';
  if (!html) {
    throw new ConfluenceError(
      `Сторінка ${pageId} повернулась без тіла у storage-форматі. Можливо, це не звичайна сторінка (база знань/whiteboard).`,
      { status: 502 },
    );
  }

  const spaceKey = page.space?.key;
  const parentId =
    page.parentId !== undefined && page.parentId !== null && page.parentId !== ''
      ? String(page.parentId)
      : lastAncestorId(page);
  return {
    externalId: String(page.id ?? pageId),
    title: page.title ?? `Сторінка ${pageId}`,
    version: extractVersion(page),
    html,
    url: buildPageUrl(ctx.config, page, pageId),
    ...(spaceKey ? { spaceKey } : {}),
    ...(parentId ? { parentId } : {}),
  };
}

/* ─────────────────────────── дерево сторінок ─────────────────────────── */

export interface ConfluencePageInfo {
  id: string;
  title: string;
  parentId: string | null;
  depth: number;
  version: string;
  url: string;
}

export interface ConfluencePageTree {
  root?: ConfluencePageInfo;
  pages: ConfluencePageInfo[];
  truncated: boolean;
}

/** Обходить сторінки результату з пагінацією за `_links.next` або start/size. */
async function* paginate<T>(ctx: Ctx, firstUrl: string, what: string): AsyncGenerator<{ item: T; linksBase?: string }> {
  let url: string | null = firstUrl;
  const visited = new Set<string>();
  while (url && !visited.has(url)) {
    visited.add(url);
    const list: ApiList<T> = await getJson<ApiList<T>>(ctx, url, what);
    const results = list.results ?? [];
    for (const item of results) yield { item, linksBase: list._links?.base };

    if (list._links?.next) {
      url = joinLink(ctx.config.apiBase, list._links.next);
    } else if (results.length > 0 && typeof list.limit === 'number' && results.length >= list.limit) {
      const start = (list.start ?? 0) + (list.size ?? results.length);
      if (typeof list.totalSize === 'number' && start >= list.totalSize) break;
      url = /[?&]start=\d+/.test(url) ? url.replace(/([?&]start=)\d+/, `$1${start}`) : `${url}&start=${start}`;
    } else {
      url = null;
    }
  }
}

function toPageInfo(ctx: Ctx, page: ApiPage, rootDepth: number, linksBase?: string): ConfluencePageInfo {
  const id = String(page.id ?? '');
  return {
    id,
    title: page.title ?? `Сторінка ${id}`,
    parentId: lastAncestorId(page) ?? null,
    depth: Math.max(0, (page.ancestors?.length ?? 0) - rootDepth),
    version: extractVersion(page),
    url: buildPageUrl(ctx.config, page, id, linksBase),
  };
}

function cqlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Дерево сторінок без тіл: сторінка з усіма нащадками (CQL `ancestor=`) або
 * весь простір. `depth` — відносно кореня (корінь 0; для простору — від верху простору).
 */
export async function fetchPageTree(
  ref: string | { url?: string; pageId?: string },
  opts?: { maxPages?: number } & ConfluenceRequestOptions,
): Promise<ConfluencePageTree> {
  const ctx = makeCtx(opts);
  const maxPages = Math.max(1, Math.floor(opts?.maxPages ?? DEFAULT_TREE_MAX_PAGES));
  const { ref: parsed, label } = toRef(ref);
  if (!parsed) throw unrecognizedRef(label);
  const target = await resolveWithCtx(ctx, parsed);
  const { apiBase } = ctx.config;

  const pages: ConfluencePageInfo[] = [];
  const seen = new Set<string>();
  let root: ConfluencePageInfo | undefined;
  let rootDepth = 0;
  let cql: string;

  if (target.kind === 'page') {
    const rootPage = await getJson<ApiPage>(
      ctx,
      `${apiBase}/rest/api/content/${target.pageId}?expand=version,ancestors`,
      `на сторінку ${target.pageId}`,
    );
    rootDepth = rootPage.ancestors?.length ?? 0;
    root = toPageInfo(ctx, { ...rootPage, id: rootPage.id ?? target.pageId }, rootDepth);
    pages.push(root);
    seen.add(root.id);
    cql = `ancestor=${target.pageId} and type=page`;
  } else {
    cql = `space=${cqlString(target.spaceKey)} and type=page`;
  }

  const firstUrl =
    `${apiBase}/rest/api/content/search?cql=${encodeURIComponent(cql)}` +
    `&expand=version,ancestors&limit=${SEARCH_LIMIT}&start=0`;
  let truncated = false;
  for await (const { item, linksBase } of paginate<ApiPage>(ctx, firstUrl, 'на пошук сторінок дерева')) {
    const id = item.id !== undefined ? String(item.id) : '';
    if (!id || seen.has(id)) continue;
    if (pages.length >= maxPages) {
      truncated = true;
      break;
    }
    seen.add(id);
    pages.push(toPageInfo(ctx, item, rootDepth, linksBase));
  }

  return { ...(root ? { root } : {}), pages, truncated };
}

/* ───────────────────────────── вкладення ─────────────────────────────── */

export interface ConfluenceAttachment {
  id: string;
  /** Ім'я файлу. */
  title: string;
  mediaType: string;
  size?: number;
  version?: string;
  /** Абсолютна адреса завантаження. */
  downloadUrl: string;
}

interface ApiAttachment {
  id?: string | number;
  title?: string;
  metadata?: { mediaType?: string };
  extensions?: { mediaType?: string; fileSize?: number };
  version?: { number?: number } | number;
  _links?: ApiLinks;
}

function assertPageId(pageId: string): string {
  const id = String(pageId).trim();
  if (!/^\d+$/.test(id)) {
    throw new ConfluenceError(`Очікується числовий ID сторінки Confluence, отримано «${pageId}».`, { status: 400 });
  }
  return id;
}

/** Перелік вкладень сторінки (`/child/attachment`). */
export async function listAttachments(
  pageId: string,
  opts?: ConfluenceRequestOptions,
): Promise<ConfluenceAttachment[]> {
  const ctx = makeCtx(opts);
  const id = assertPageId(pageId);
  const firstUrl = `${ctx.config.apiBase}/rest/api/content/${id}/child/attachment?limit=200`;
  const out: ConfluenceAttachment[] = [];
  for await (const { item } of paginate<ApiAttachment>(ctx, firstUrl, `на вкладення сторінки ${id}`)) {
    const title = item.title ?? '';
    const versionValue = typeof item.version === 'number' ? item.version : item.version?.number;
    const size = item.extensions?.fileSize;
    out.push({
      id: String(item.id ?? ''),
      title,
      mediaType: item.metadata?.mediaType ?? item.extensions?.mediaType ?? 'application/octet-stream',
      ...(typeof size === 'number' ? { size } : {}),
      ...(typeof versionValue === 'number' ? { version: String(versionValue) } : {}),
      downloadUrl: item._links?.download
        ? joinLink(ctx.config.apiBase, item._links.download)
        : `${ctx.config.apiBase}/download/attachments/${id}/${encodeURIComponent(title)}`,
    });
  }
  return out;
}

async function readBinary(
  response: Response,
  maxBytes: number,
  what: string,
): Promise<{ data: Buffer; mediaType: string }> {
  const declared = Number(headerOf(response, 'content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ConfluenceError(`Файл ${what} завеликий: ${declared} байт (ліміт ${maxBytes}).`, { status: 413 });
  }
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > maxBytes) {
    throw new ConfluenceError(`Файл ${what} завеликий: ${data.length} байт (ліміт ${maxBytes}).`, { status: 413 });
  }
  const mediaType = headerOf(response, 'content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
  return { data, mediaType };
}

/** Завантажує вкладення сторінки за ім'ям файлу (`/download/attachments/…`). */
export async function downloadAttachment(
  pageId: string,
  filename: string,
  opts?: ConfluenceRequestOptions & { maxBytes?: number },
): Promise<{ data: Buffer; mediaType: string }> {
  const ctx = makeCtx(opts);
  const id = assertPageId(pageId);
  if (!filename.trim()) throw new ConfluenceError('Не задано ім\'я файлу вкладення.', { status: 400 });
  const url = `${ctx.config.apiBase}/download/attachments/${id}/${encodeURIComponent(filename)}`;
  const response = await ctxSend(ctx, url, { accept: '*/*' });
  if (!response.ok) {
    const body = await response.text().catch(() => response.statusText);
    throw httpError(ctx, response.status, body, `на вкладення «${filename}» сторінки ${id}`);
  }
  return readBinary(response, opts?.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES, `«${filename}»`);
}

/**
 * Завантажує зовнішню картинку за http(s)-адресою. Облікові дані Confluence
 * додаються лише для адрес на тому ж сервері.
 */
export async function downloadUrl(
  url: string,
  opts?: ConfluenceRequestOptions & { maxBytes?: number },
): Promise<{ data: Buffer; mediaType: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new ConfluenceError(`Некоректна адреса файлу: ${url}`, { status: 400 });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfluenceError(`Завантажувати можна лише http(s)-адреси, отримано ${parsed.protocol}`, { status: 400 });
  }
  const resolved = isConfluenceConfigured() ? resolveConfig() : null;
  const own = resolved && sameOrigin(parsed.toString(), resolved.config.apiBase);
  const response = await send(
    {
      fetchImpl: opts?.fetch ?? globalThis.fetch,
      sleep: opts?.sleep ?? sleepImpl,
      timeoutMs: resolved?.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(own ? { authorization: resolved.authorization, flavor: resolved.config.flavor } : {}),
    },
    parsed.toString(),
    { accept: '*/*' },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => response.statusText);
    throw new ConfluenceError(`Сервер відповів ${response.status} на ${parsed.toString()}. ${shortBody(body, 120)}`.trim(), {
      status: response.status,
    });
  }
  return readBinary(response, opts?.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES, parsed.pathname.split('/').pop() || 'за посиланням');
}

/* ───────────────────────── парсер storage-HTML ───────────────────────── */

/** Макроси, вміст яких лишаємо: у них буває сам текст вимоги. */
const KEEP_MACROS = new Set([
  'info',
  'note',
  'warning',
  'tip',
  'panel',
  'expand',
  'section',
  'column',
  'excerpt',
]);

const HEADING_MARK = '\u0001H';
const TABLE_MARK = '\u0002T';

interface BalancedMatch {
  start: number;
  end: number;
  openTag: string;
  inner: string;
}

/**
 * Знаходить перший елемент `tag` починаючи з `from`, з урахуванням вкладеності
 * (потрібно для таблиць у таблицях і макросів у макросах).
 */
function findBalanced(html: string, tag: string, from = 0): BalancedMatch | null {
  const openRe = new RegExp(`<${tag}(\\s[^>]*?)?(/)?>`, 'gi');
  openRe.lastIndex = from;
  const open = openRe.exec(html);
  if (!open) return null;
  if (open[2]) {
    return { start: open.index, end: open.index + open[0].length, openTag: open[0], inner: '' };
  }

  const bodyStart = openRe.lastIndex;
  const scanRe = new RegExp(`<(/)?${tag}(\\s[^>]*?)?(/)?>`, 'gi');
  scanRe.lastIndex = bodyStart;
  let depth = 1;
  let token: RegExpExecArray | null;
  while ((token = scanRe.exec(html)) !== null) {
    if (token[1]) {
      depth -= 1;
      if (depth === 0) {
        return {
          start: open.index,
          end: token.index + token[0].length,
          openTag: open[0],
          inner: html.slice(bodyStart, token.index),
        };
      }
    } else if (!token[3]) {
      depth += 1;
    }
  }
  // Незакритий тег — беремо все до кінця, щоб не втратити текст.
  return { start: open.index, end: html.length, openTag: open[0], inner: html.slice(bodyStart) };
}

function macroName(openTag: string): string {
  return (openTag.match(/ac:name\s*=\s*"([^"]*)"/i)?.[1] ?? '').toLowerCase();
}

/**
 * Прибирає макроси: навігаційні (зміст, дерево сторінок, включення) — разом із
 * вмістом, змістовні (info/note/panel/expand) — розгортає, лишаючи текст.
 */
function stripMacros(html: string): string {
  let out = html;
  let cursor = 0;
  let guard = 0;
  while (guard < 500) {
    guard += 1;
    const macro = findBalanced(out, 'ac:structured-macro', cursor);
    if (!macro) break;
    const name = macroName(macro.openTag);
    if (KEEP_MACROS.has(name)) {
      // Параметри макроса — це налаштування, не текст.
      const inner = macro.inner.replace(/<ac:parameter[\s\S]*?<\/ac:parameter>/gi, ' ');
      out = `${out.slice(0, macro.start)}\n${inner}\n${out.slice(macro.end)}`;
      cursor = macro.start;
    } else {
      out = `${out.slice(0, macro.start)}\n${out.slice(macro.end)}`;
      cursor = macro.start;
    }
  }
  return out;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  laquo: '«',
  raquo: '»',
  hellip: '…',
  bull: '•',
  middot: '·',
  deg: '°',
  copy: '©',
  reg: '®',
  trade: '™',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  times: '×',
  minus: '−',
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => safeCharFromCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeCharFromCode(Number.parseInt(dec, 10)))
    .replace(/&([a-z][a-z0-9]*);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match);
}

function safeCharFromCode(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
  return String.fromCodePoint(code);
}

/** HTML-фрагмент → однорядковий текст (для клітинок таблиці й заголовків). */
function inlineText(html: string): string {
  return normalizeWhitespace(htmlFragmentToText(html)).replace(/\n+/g, ' ').trim();
}

/** Таблиця → рядки «колонка: значення». */
function tableToText(tableHtml: string): string {
  const rows: string[][] = [];
  let headerCells: string[] | null = null;

  const rowRe = /<tr(?:\s[^>]*)?>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(tableHtml)) !== null) {
    const rowHtml = rowMatch[1] ?? '';
    const cells: string[] = [];
    let isHeaderRow = false;
    const cellRe = /<(th|td)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      if ((cellMatch[1] ?? '').toLowerCase() === 'th') isHeaderRow = true;
      cells.push(inlineText(cellMatch[2] ?? ''));
    }
    if (cells.length === 0) continue;
    if (isHeaderRow && headerCells === null && rows.length === 0) {
      headerCells = cells;
      continue;
    }
    rows.push(cells);
  }

  if (rows.length === 0) {
    // Таблиця лише з шапки — лишаємо перелік колонок, це теж інформація.
    return headerCells && headerCells.length > 0 ? `Колонки таблиці: ${headerCells.join(', ')}` : '';
  }

  const lines: string[] = [];
  rows.forEach((cells, index) => {
    const parts: string[] = [];
    cells.forEach((value, column) => {
      if (!value) return;
      const name = headerCells?.[column]?.trim();
      parts.push(name ? `${name}: ${value}` : `Колонка ${column + 1}: ${value}`);
    });
    if (parts.length === 0) return;
    lines.push(`рядок ${index + 1}:`);
    lines.push(...parts);
    lines.push('');
  });
  return lines.join('\n').trim();
}

/** Загальне перетворення HTML-фрагмента в текст без маркерів заголовків. */
function htmlFragmentToText(html: string): string {
  let out = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<(script|style)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, ' ');

  out = out
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<li(?:\s[^>]*)?>/gi, '\n- ')
    .replace(/<\/(ul|ol|table)>/gi, '\n\n')
    .replace(/<(p|div|blockquote|pre|ul|ol|table)(?:\s[^>]*)?>/gi, '\n')
    .replace(/<[^>]*>/g, '');

  return decodeEntities(out);
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * storage-HTML → плоский текст із маркерами заголовків і вже розгорнутими
 * таблицями. Маркери потрібні, щоб далі різати текст на блоки.
 */
function storageToMarkedText(html: string): string {
  let work = stripMacros(html);

  // Таблиці виносимо в плейсхолдери: усередині вони містять теги, які далі
  // були б знищені загальним прибиранням.
  const tables: string[] = [];
  let guard = 0;
  while (guard < 200) {
    guard += 1;
    const table = findBalanced(work, 'table');
    if (!table) break;
    const text = tableToText(table.inner);
    const index = tables.push(text) - 1;
    work = `${work.slice(0, table.start)}\n\n${TABLE_MARK}${index}\u0003\n\n${work.slice(table.end)}`;
  }

  // Заголовки h1–h4 стають межами блоків; h5/h6 лишаються звичайним текстом.
  work = work.replace(
    /<h([1-4])(?:\s[^>]*)?>([\s\S]*?)<\/h\1>/gi,
    (_m, level: string, inner: string) => `\n\n${HEADING_MARK}${level}\u0003${inlineText(inner)}\n\n`,
  );

  let text = normalizeWhitespace(htmlFragmentToText(work));
  text = text.replace(new RegExp(`${TABLE_MARK}(\\d+)\\u0003`, 'g'), (_m, index: string) => {
    return tables[Number(index)] ?? '';
  });
  return normalizeWhitespace(text);
}

/** Markdown / звичайний текст → той самий формат із маркерами заголовків. */
function plainToMarkedText(content: string, format: 'text' | 'markdown'): string {
  const lines = normalizeWhitespace(content).split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const md = line.match(/^(#{1,4})\s+(.+?)\s*#*$/);
    if (md) {
      out.push('', `${HEADING_MARK}${md[1]!.length}\u0003${md[2]!.trim()}`, '');
      continue;
    }
    if (format === 'text') {
      // Нумерований підрозділ («3.2 Акти») або короткий рядок КАПСОМ — типові
      // заголовки в тексті, вставленому з Word.
      const numbered = line.match(/^(\d+(?:\.\d+){0,3})[.)]?\s+(\S.{0,90})$/);
      if (numbered && !/[.:;]$/.test(line)) {
        const level = Math.min(4, (numbered[1]!.match(/\./g)?.length ?? 0) + 1);
        out.push('', `${HEADING_MARK}${level}\u0003${line.trim()}`, '');
        continue;
      }
      const letters = line.replace(/[^\p{L}]/gu, '');
      if (
        letters.length >= 3 &&
        line.length <= 90 &&
        letters === letters.toUpperCase() &&
        letters !== letters.toLowerCase()
      ) {
        out.push('', `${HEADING_MARK}2\u0003${line.trim()}`, '');
        continue;
      }
    }
    // Markdown-списки й цитати зводимо до тире, як і в HTML-гілці.
    out.push(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '- ').replace(/^>\s?/, ''));
  }
  return normalizeWhitespace(out.join('\n'));
}

function detectFormat(content: string): 'html' | 'markdown' | 'text' {
  if (/<\/?(p|div|h[1-6]|table|ul|ol|li|span|ac:[a-z-]+)\b/i.test(content)) return 'html';
  if (/^#{1,4}\s+\S/m.test(content)) return 'markdown';
  return 'text';
}

/** Anchor у стилі Confluence: заголовок без пробілів і пунктуації. */
function anchorFromHeading(heading: string): string | undefined {
  const anchor = heading.replace(/[^\p{L}\p{N}]/gu, '');
  return anchor.length > 0 ? anchor : undefined;
}

/** Ріже надто довгий блок по абзацах (а якщо абзац сам завеликий — по рядках). */
function chunkByParagraphs(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let current = '';

  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed) chunks.push(trimmed);
    current = '';
  };

  for (const paragraph of text.split(/\n{2,}/)) {
    const pieces = paragraph.length <= maxChars ? [paragraph] : splitLongParagraph(paragraph, maxChars);
    for (const piece of pieces) {
      if (current && current.length + piece.length + 2 > maxChars) pushCurrent();
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  pushCurrent();
  return chunks.length > 0 ? chunks : [text.slice(0, maxChars)];
}

function splitLongParagraph(paragraph: string, maxChars: number): string[] {
  const out: string[] = [];
  let current = '';
  for (const line of paragraph.split('\n')) {
    if (current && current.length + line.length + 1 > maxChars) {
      out.push(current);
      current = '';
    }
    if (line.length > maxChars) {
      if (current) {
        out.push(current);
        current = '';
      }
      for (let i = 0; i < line.length; i += maxChars) out.push(line.slice(i, i + maxChars));
      continue;
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current) out.push(current);
  return out;
}

/**
 * Розбиває storage-HTML Confluence або звичайний текст/markdown на блоки за
 * заголовками h1–h4.
 *
 * Правила: таблиці → рядки «колонка: значення», списки → рядки з тире,
 * навігаційні макроси відкидаються, блок довший за `maxChars` ділиться по
 * абзацах, порожні блоки відкидаються.
 */
export function splitIntoBlocks(content: string, opts?: SplitOptions): RawBlock[] {
  if (!content || content.trim().length === 0) return [];
  const maxChars = Math.max(200, opts?.maxChars ?? DEFAULT_MAX_CHARS);
  const format = opts?.format ?? detectFormat(content);

  const marked =
    format === 'html' ? storageToMarkedText(content) : plainToMarkedText(content, format);

  // Ділимо на секції за маркерами заголовків.
  const sections: Array<{ heading: string; text: string }> = [];
  let currentHeading = '';
  let buffer: string[] = [];
  const flush = () => {
    const text = normalizeWhitespace(buffer.join('\n'));
    if (text || currentHeading) sections.push({ heading: currentHeading, text });
    buffer = [];
  };

  for (const line of marked.split('\n')) {
    const heading = line.match(new RegExp(`^${HEADING_MARK}(\\d)\\u0003(.*)$`));
    if (heading) {
      flush();
      currentHeading = (heading[2] ?? '').trim();
      continue;
    }
    buffer.push(line);
  }
  flush();

  const blocks: RawBlock[] = [];
  for (const section of sections) {
    if (!section.text) continue; // порожні блоки (лише заголовок або макрос) відкидаємо
    const anchor = anchorFromHeading(section.heading);
    const chunks = chunkByParagraphs(section.text, maxChars);
    chunks.forEach((chunk, index) => {
      if (!chunk.trim()) return;
      const heading =
        chunks.length > 1 && section.heading
          ? `${section.heading} (частина ${index + 1})`
          : section.heading;
      blocks.push({
        heading,
        ...(anchor ? { anchor } : {}),
        text: chunk,
        position: blocks.length,
      });
    });
  }
  return blocks;
}

/** sha256 від нормалізованого тексту, перші 16 символів. */
export function hashBlock(text: string): string {
  const normalized = normalizeWhitespace(text);
  return createHash('sha256').update(normalized, 'utf-8').digest('hex').slice(0, 16);
}

/* ─────────────────── картинки, схеми, Figma і Jira ───────────────────── */

export type DiagramType = 'drawio' | 'gliffy' | 'plantuml' | 'mermaid' | 'other';

export type AssetRef =
  | {
      kind: 'image';
      source: 'attachment' | 'url';
      /** Ім'я файлу вкладення або останній сегмент URL. */
      name: string;
      url?: string;
      alt?: string;
      /** Вкладення з іншої сторінки (`ri:page` усередині `ri:attachment`). */
      page?: { title: string; spaceKey?: string };
    }
  | {
      kind: 'diagram';
      diagramType: DiagramType;
      name: string;
      /** Текст діаграми для plantuml/mermaid. */
      source?: string;
      /** Ім'я макроса як у storage (`drawio`, `inc-drawio`, `lucidchart`…). */
      macro: string;
      /** Сторінка, де лежить схема (`inc-drawio`, `gliffy` з іншої сторінки). */
      pageId?: string;
    };

export interface FigmaLinkRef {
  url: string;
  fileKey: string;
  /** У форматі API: `12:345` (в URL — `12-345`). */
  nodeId?: string;
}

export type RawBlockWithAssets = RawBlock & {
  assets: AssetRef[];
  figmaLinks: FigmaLinkRef[];
  jiraKeys: string[];
};

/**
 * Розбирає посилання на Figma без мережі: `figma.com/(file|design|proto|board)/<key>/…`,
 * гілки (`/branch/<key>` — ключ гілки й є ключем файлу для API) і `figma.com/embed?url=…`.
 */
export function parseFigmaLink(url: string): FigmaLinkRef | null {
  return parseFigmaLinkInner(url, 0);
}

function parseFigmaLinkInner(url: string, depth: number): FigmaLinkRef | null {
  const value = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const host = parsed.hostname.toLowerCase();
  if (host !== 'figma.com' && !host.endsWith('.figma.com')) return null;

  if (/^\/embed\/?$/i.test(parsed.pathname)) {
    const inner = parsed.searchParams.get('url');
    return inner && depth < 1 ? parseFigmaLinkInner(inner, depth + 1) : null;
  }

  const match = parsed.pathname.match(
    /^\/(?:file|design|proto|board)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?(?:\/|$)/i,
  );
  if (!match?.[1]) return null;
  const node = parsed.searchParams.get('node-id')?.trim();
  return {
    url: value,
    fileKey: match[2] ?? match[1],
    ...(node ? { nodeId: node.replace(/-/g, ':') } : {}),
  };
}

const DRAWIO_MACROS = new Set(['drawio', 'inc-drawio', 'drawio-sketch', 'inc-drawio-sketch', 'drawio-board']);
const GLIFFY_MACROS = new Set(['gliffy']);
const PLANTUML_MACROS = new Set(['plantuml', 'plantumlrender']);
const MERMAID_MACROS = new Set(['mermaid', 'mermaid-cloud', 'mermaid-macro']);
/** Вбудовані схеми, з яких текст без моделі не дістати — лишається тільки знімок. */
const OTHER_DIAGRAM_MACROS = new Set([
  'lucidchart',
  'lucidchart-macro',
  'lucid',
  'balsamiq',
  'mockup',
  'creately',
  'smartdraw',
  'visio',
  'viewvisio',
  'miro',
  'miro-board',
  'graphviz',
  'flowchart',
]);
const JIRA_MACROS = new Set(['jira', 'jiraissues']);
/** Макроси вбудовування, у яких буває посилання на Figma. */
const EMBED_MACROS = new Set(['widget', 'iframe', 'figma', 'figma-for-confluence']);

const DIAGRAM_LABELS: Record<Exclude<DiagramType, 'other'>, string> = {
  drawio: 'Схема draw.io',
  gliffy: 'Схема Gliffy',
  plantuml: 'Схема PlantUML',
  mermaid: 'Схема Mermaid',
};

interface ExtractedItem {
  asset?: AssetRef;
  figma?: FigmaLinkRef;
  jira?: string;
}

const ITEM_OPEN = '\u0004';
const ITEM_CLOSE = '\u0005';
const ITEM_RE = /\u0004(\d+)\u0005/g;

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function readAttr(tag: string, name: string): string | undefined {
  const re = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const match = tag.match(re);
  const raw = match?.[1] ?? match?.[2];
  return raw === undefined ? undefined : decodeEntities(raw);
}

/** Параметри макроса верхнього рівня (ключі в нижньому регістрі). */
function macroParams(inner: string): Record<string, string> {
  const cleaned = inner.replace(/<ac:(rich|plain)-text-body\b[\s\S]*?<\/ac:\1-text-body>/gi, ' ');
  const params: Record<string, string> = {};
  const re = /<ac:parameter\b([^>]*)>([\s\S]*?)<\/ac:parameter>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(cleaned)) !== null) {
    const name = readAttr(match[1] ?? '', 'ac:name')?.toLowerCase() ?? '';
    const body = match[2] ?? '';
    // Widget Connector зберігає url як <ri:url ri:value="…"/>, а не текстом.
    const riUrl = body.match(/<ri:url\b[^>]*>/i)?.[0];
    const value = riUrl ? readAttr(riUrl, 'ri:value') ?? '' : inlineText(body);
    if (!(name in params)) params[name] = value.trim();
  }
  return params;
}

function plainTextBody(inner: string): string | undefined {
  const body = inner.match(/<ac:plain-text-body\b[^>]*>([\s\S]*?)<\/ac:plain-text-body>/i)?.[1];
  if (body === undefined) return undefined;
  // `]]>` у тексті Confluence розбиває на кілька CDATA — склеюємо назад.
  const text = body.includes('<![CDATA[')
    ? Array.from(body.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g), (m) => m[1] ?? '').join('')
    : decodeEntities(body);
  return text.trim() ? text.replace(/\r\n?/g, '\n').trim() : undefined;
}

function firstParam(params: Record<string, string>, names: string[]): string | undefined {
  for (const name of names) {
    const value = params[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function lastUrlSegment(url: string): string {
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean).pop();
    return segment ? decodeURIComponent(segment) : url;
  } catch {
    return url;
  }
}

/**
 * Замінює картинки, схеми, Jira-макроси й посилання на Figma маркерами
 * `\u0004N\u0005` (+ людський плейсхолдер), щоб після звичайного розбиття на
 * блоки знати, у якому блоці стояв кожен ресурс.
 */
function markAssets(html: string): { html: string; items: ExtractedItem[] } {
  const items: ExtractedItem[] = [];
  const counters = { plantuml: 0, mermaid: 0 };
  const mark = (item: ExtractedItem) => `${ITEM_OPEN}${items.push(item) - 1}${ITEM_CLOSE}`;

  let out = html;
  let cursor = 0;
  for (let guard = 0; guard < 2000; guard += 1) {
    const macro = findBalanced(out, 'ac:structured-macro', cursor);
    if (!macro) break;
    const name = macroName(macro.openTag);
    const replacement = markMacro(name, macro.inner, counters, mark);
    if (replacement === null) {
      // Не наш макрос — заходимо всередину, там можуть бути вкладені.
      cursor = macro.start + macro.openTag.length;
      continue;
    }
    out = `${out.slice(0, macro.start)}${replacement}${out.slice(macro.end)}`;
    cursor = macro.start + replacement.length;
  }

  out = out.replace(/<ac:image\b([^>]*)>([\s\S]*?)<\/ac:image>/gi, (_m, attrs: string, inner: string) => {
    const alt = readAttr(attrs, 'ac:alt') ?? readAttr(attrs, 'ac:title');
    const attachmentTag = inner.match(/<ri:attachment\b[^>]*>/i)?.[0];
    const urlTag = inner.match(/<ri:url\b[^>]*>/i)?.[0];
    let asset: AssetRef | null = null;
    let figma: FigmaLinkRef | null = null;
    if (attachmentTag) {
      const filename = readAttr(attachmentTag, 'ri:filename');
      if (filename) {
        const pageTag = inner.match(/<ri:page\b[^>]*>/i)?.[0];
        const pageTitle = pageTag ? readAttr(pageTag, 'ri:content-title') : undefined;
        const spaceKey = pageTag ? readAttr(pageTag, 'ri:space-key') : undefined;
        asset = {
          kind: 'image',
          source: 'attachment',
          name: filename,
          ...(alt ? { alt } : {}),
          ...(pageTitle ? { page: { title: pageTitle, ...(spaceKey ? { spaceKey } : {}) } } : {}),
        };
      }
    } else if (urlTag) {
      const url = readAttr(urlTag, 'ri:value');
      if (url) {
        asset = { kind: 'image', source: 'url', name: lastUrlSegment(url), url, ...(alt ? { alt } : {}) };
        figma = parseFigmaLink(url);
      }
    }
    if (!asset) return ' ';
    const markers = mark({ asset }) + (figma ? mark({ figma }) : '');
    return `${markers}${escapeHtml(`[Зображення: ${asset.name}]`)}`;
  });

  // ri:url поза картинками — посилання (`ac:link`); текст посилання лишається.
  out = out.replace(/<ri:url\b[^>]*>/gi, (tag: string) => {
    const figma = parseFigmaLink(readAttr(tag, 'ri:value') ?? '');
    return figma ? `${mark({ figma })}${tag}` : tag;
  });

  out = out.replace(/<a\b[^>]*>/gi, (tag: string) => {
    const href = readAttr(tag, 'href');
    const figma = href ? parseFigmaLink(href) : null;
    return figma ? `${mark({ figma })}${tag}` : tag;
  });

  return { html: out, items };
}

function markMacro(
  name: string,
  inner: string,
  counters: { plantuml: number; mermaid: number },
  mark: (item: ExtractedItem) => string,
): string | null {
  const params = () => macroParams(inner);
  const asBlock = (markers: string, label: string) => `\n<p>${markers}${escapeHtml(label)}</p>\n`;

  if (DRAWIO_MACROS.has(name) || GLIFFY_MACROS.has(name)) {
    const p = params();
    const diagramType: DiagramType = DRAWIO_MACROS.has(name) ? 'drawio' : 'gliffy';
    const nameValue =
      firstParam(p, diagramType === 'drawio' ? ['diagramname', 'diagramdisplayname'] : ['name', 'displayname']) ??
      (diagramType === 'drawio' ? 'draw.io' : 'Gliffy');
    const pageId = firstParam(p, ['pageid'])?.match(/^\d+$/)?.[0];
    const asset: AssetRef = { kind: 'diagram', diagramType, name: nameValue, macro: name, ...(pageId ? { pageId } : {}) };
    return asBlock(mark({ asset }), `[${DIAGRAM_LABELS[diagramType]}: ${nameValue}]`);
  }

  if (PLANTUML_MACROS.has(name) || MERMAID_MACROS.has(name)) {
    const diagramType: DiagramType = PLANTUML_MACROS.has(name) ? 'plantuml' : 'mermaid';
    counters[diagramType] += 1;
    const p = params();
    const nameValue =
      firstParam(p, ['title', 'name', 'filename', 'diagramname']) ??
      `${diagramType === 'plantuml' ? 'PlantUML' : 'Mermaid'} ${counters[diagramType]}`;
    const source = plainTextBody(inner);
    const asset: AssetRef = { kind: 'diagram', diagramType, name: nameValue, macro: name, ...(source ? { source } : {}) };
    return asBlock(mark({ asset }), `[${DIAGRAM_LABELS[diagramType]}: ${nameValue}]`);
  }

  if (OTHER_DIAGRAM_MACROS.has(name)) {
    const p = params();
    const nameValue = firstParam(p, ['name', 'title', 'diagramname', 'documenttitle', 'documentname']) ?? name;
    const source = plainTextBody(inner);
    const pageId = firstParam(p, ['pageid'])?.match(/^\d+$/)?.[0];
    const asset: AssetRef = {
      kind: 'diagram',
      diagramType: 'other',
      name: nameValue,
      macro: name,
      ...(source ? { source } : {}),
      ...(pageId ? { pageId } : {}),
    };
    return asBlock(mark({ asset }), `[Схема ${name}: ${nameValue}]`);
  }

  if (JIRA_MACROS.has(name)) {
    const key = firstParam(params(), ['key'])?.toUpperCase();
    // Макрос із JQL-запитом замість ключа — це не посилання на задачу.
    if (!key || !/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) return null;
    return `${mark({ jira: key })}${escapeHtml(`[Jira: ${key}]`)}`;
  }

  if (EMBED_MACROS.has(name)) {
    const url = firstParam(params(), ['url', 'src', 'link']);
    const figma = url ? parseFigmaLink(url) : null;
    if (!figma) return null;
    return asBlock(mark({ figma }), '[Макет Figma]');
  }

  return null;
}

/** Плейсхолдер у заголовку не повинен потрапляти в anchor. */
function stripItemsFromHeading(heading: string): string {
  return heading
    .replace(/\u0004\d+\u0005(?:\[[^\]]*\])?/g, '')
    .replace(/[\u0004\u0005]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Те саме розбиття, що й `splitIntoBlocks`, плюс ресурси кожного блоку:
 * картинки (`ac:image`), схеми (draw.io, Gliffy, PlantUML, Mermaid, інші),
 * посилання на Figma (`<a href>`, `ri:url`, Widget Connector) і ключі Jira.
 * На місці ресурсу в тексті стоїть плейсхолдер (`[Зображення: …]`, `[Схема draw.io: …]`),
 * тож блок із самою лише картинкою не відкидається як порожній.
 * Ресурси всередині навігаційних макросів відкидаються разом із макросом, як і текст.
 */
export function splitIntoBlocksWithAssets(html: string, opts?: SplitOptions): RawBlockWithAssets[] {
  if (!html || html.trim().length === 0) return [];
  const format = opts?.format ?? detectFormat(html);
  if (format !== 'html') {
    return splitIntoBlocks(html, { ...opts, format }).map((block) => ({
      ...block,
      assets: [],
      figmaLinks: [],
      jiraKeys: [],
    }));
  }

  const { html: marked, items } = markAssets(html);
  const raw = splitIntoBlocks(marked, { ...opts, format: 'html' });
  const out: RawBlockWithAssets[] = [];

  for (const block of raw) {
    const ids: number[] = [];
    const collect = (text: string) => {
      for (const match of text.matchAll(ITEM_RE)) ids.push(Number(match[1]));
    };
    collect(block.heading);
    collect(block.text);

    const hasMarkers = /[\u0004\u0005]/.test(block.text);
    const text = hasMarkers
      ? normalizeWhitespace(block.text.replace(ITEM_RE, '').replace(/[\u0004\u0005]/g, ''))
      : block.text;
    if (!text) continue;

    let heading = block.heading;
    let anchor = block.anchor;
    if (/[\u0004\u0005]/.test(heading)) {
      heading = stripItemsFromHeading(heading);
      anchor = anchorFromHeading(heading.replace(/ \(частина \d+\)$/, ''));
    }

    const assets: AssetRef[] = [];
    const figmaLinks: FigmaLinkRef[] = [];
    const jiraKeys: string[] = [];
    for (const id of ids) {
      const item = items[id];
      if (!item) continue;
      if (item.asset) assets.push(item.asset);
      if (item.figma && !figmaLinks.some((link) => link.url === item.figma!.url)) figmaLinks.push(item.figma);
      if (item.jira && !jiraKeys.includes(item.jira)) jiraKeys.push(item.jira);
    }

    out.push({
      heading,
      ...(anchor ? { anchor } : {}),
      text,
      position: out.length,
      assets,
      figmaLinks,
      jiraKeys,
    });
  }
  return out;
}
