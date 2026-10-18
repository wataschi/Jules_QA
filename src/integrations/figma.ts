/**
 * Інтеграція з Figma REST API: розбір посилань, клієнт і витяг кадрів як
 * блоків вимог (тексти екрана, інстанси компонентів зі станами).
 *
 * Важливе про доступ і ліміти:
 *  - токен (`FIGMA_TOKEN`, персональний) іде лише в заголовку `X-Figma-Token`,
 *    реєструється через `registerSecret` і не потрапляє в текст помилок;
 *  - ліміти REST API залежать від тарифу й ТИПУ МІСЦЯ власника токена: для
 *    View/Collab вони мізерні (Figma може відповісти 429 з `Retry-After` на
 *    години чи дні). Тому токен потрібен від Full або Dev seat, а Jules кешує
 *    все за версією файлу (`getVersion` — легкий запит `depth=1`);
 *  - 429/5xx повторюємо до 5 разів з паузою з `Retry-After` або
 *    експоненційною; якщо Figma просить чекати довше за хвилину — не чекаємо,
 *    а віддаємо `FigmaError` зі `status: 429` і `retryAfterMs`;
 *  - посилання на картинки з `getImageUrls` ведуть на S3 і живуть ~30 днів;
 *    `download` ходить туди БЕЗ токена.
 *
 * Розбір дерева (`extractFrames`, `frameToBlockText`) — чисті функції.
 */
import { createHash } from 'node:crypto';
import { IntegrationError, registerSecret, shortBody } from './errors.js';

/* ─────────────────────────────── типи ────────────────────────────────── */

export interface FigmaBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FigmaComponentProperty {
  type?: string;
  value: string | number | boolean;
}

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
  characters?: string;
  absoluteBoundingBox?: FigmaBoundingBox | null;
  componentProperties?: Record<string, FigmaComponentProperty>;
  visible?: boolean;
}

export interface FigmaFile {
  name: string;
  version: string;
  lastModified: string;
  document: FigmaNode;
}

export interface FigmaFrame {
  nodeId: string;
  name: string;
  pageName: string;
  /** Тексти в порядку читання (y, потім x), без прихованих і без повторів підряд. */
  texts: string[];
  /** Інстанси компонентів з їхніми властивостями, унікальні. */
  components: Array<{ name: string; properties: Record<string, string> }>;
  width?: number;
  height?: number;
  /** sha256 (16 hex) від нормалізованих name + texts + components. */
  hash: string;
}

export type FigmaUrlKind = 'design' | 'file' | 'proto' | 'board';

export interface FigmaUrlRef {
  fileKey: string;
  nodeId?: string;
  kind: FigmaUrlKind;
}

/** Помилка Figma REST API. `status` — HTTP-код відповіді. */
export class FigmaError extends IntegrationError {
  /** Скільки Figma просить чекати після 429, якщо це довше за допустиму паузу. */
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options?: { status?: number; details?: unknown; cause?: unknown; retryAfterMs?: number },
  ) {
    super(message, options);
    this.name = 'FigmaError';
    this.retryAfterMs = options?.retryAfterMs;
  }
}

/* ───────────────────────────── посилання ─────────────────────────────── */

const URL_KINDS = new Set<FigmaUrlKind>(['design', 'file', 'proto', 'board']);

/**
 * Розбирає посилання Figma:
 *  - `https://www.figma.com/design/<key>/Назва?node-id=12-345`
 *  - `/file/<key>`, `/proto/<key>`, `/board/<key>` (FigJam)
 *  - гілки `/design/<key>/branch/<branchKey>/…` → ключ гілки (так його чекає API)
 *  - `https://www.figma.com/embed?url=…` (Widget Connector у Confluence)
 * `node-id=12-345` нормалізується до `12:345`.
 */
export function parseFigmaUrl(url: string): FigmaUrlRef | null {
  const value = url.trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== 'figma.com' && !host.endsWith('.figma.com')) return null;

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments[0] === 'embed') {
    const inner = parsed.searchParams.get('url');
    return inner ? parseFigmaUrl(inner) : null;
  }

  const kind = segments[0] as FigmaUrlKind;
  if (!URL_KINDS.has(kind)) return null;
  let fileKey = segments[1];
  if (segments[3] && segments[2] === 'branch') fileKey = segments[3];
  if (!fileKey || !/^[A-Za-z0-9]+$/.test(fileKey)) return null;

  const ref: FigmaUrlRef = { fileKey, kind };
  const nodeId = parsed.searchParams.get('node-id')?.trim();
  if (nodeId) ref.nodeId = nodeId.replace(/-/g, ':');
  return ref;
}

/* ─────────────────────────────── клієнт ──────────────────────────────── */

export interface FigmaClientOptions {
  token: string;
  /** Дефолт `https://api.figma.com`. */
  baseUrl?: string;
  /** Підміняється в тестах. Дефолт — глобальний `fetch`. */
  fetch?: typeof fetch;
  /** Дефолт 30 000 мс. */
  timeoutMs?: number;
  /** Пауза між повторами. У тестах — миттєва. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BASE_URL = 'https://api.figma.com';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 1_000;
const MAX_RETRY_WAIT_MS = 60_000;
/** Скільки ID вузлів кладемо в один запит, щоб не впертися в довжину URL. */
const IDS_CHUNK = 50;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Чи задано `FIGMA_TOKEN`. */
export function isFigmaConfigured(): boolean {
  return Boolean(process.env.FIGMA_TOKEN);
}

/** Клієнт зі змінних оточення (`FIGMA_TOKEN`). Кидає помилку з підказкою, якщо токена немає. */
export function createFigmaClientFromEnv(overrides?: Partial<FigmaClientOptions>): FigmaClient {
  const token = overrides?.token ?? process.env.FIGMA_TOKEN;
  if (!token) {
    throw new FigmaError(
      'Figma не налаштовано. Додайте в .env FIGMA_TOKEN — персональний токен користувача з місцем Full або Dev.',
      { status: 400 },
    );
  }
  return new FigmaClient({ ...overrides, token });
}

export class FigmaClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: FigmaClientOptions) {
    if (!opts.token) throw new FigmaError('Не задано FIGMA_TOKEN.', { status: 400 });
    registerSecret(opts.token);
    this.token = opts.token;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? ((...args) => fetch(...args));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** Дерево файлу. `depth: 1` — лише сторінки (легкий запит метаданих). */
  async getFile(fileKey: string, opts?: { depth?: number }): Promise<FigmaFile> {
    const query = new URLSearchParams();
    if (opts?.depth !== undefined) query.set('depth', String(opts.depth));
    return this.getJson<FigmaFile>(`/v1/files/${encodeURIComponent(fileKey)}`, query);
  }

  /** Окремі вузли. ID, яких немає у файлі, у результат не потрапляють. */
  async getNodes(fileKey: string, ids: string[]): Promise<Record<string, { document: FigmaNode }>> {
    const out: Record<string, { document: FigmaNode }> = {};
    for (const part of chunk(unique(ids), IDS_CHUNK)) {
      const payload = await this.getJson<{ nodes?: Record<string, { document?: FigmaNode } | null> }>(
        `/v1/files/${encodeURIComponent(fileKey)}/nodes`,
        new URLSearchParams({ ids: part.join(',') }),
      );
      for (const [id, entry] of Object.entries(payload.nodes ?? {})) {
        if (entry?.document) out[id] = { document: entry.document };
      }
    }
    return out;
  }

  /** Посилання на відрендерені вузли. `null` — Figma не змогла відрендерити вузол. */
  async getImageUrls(
    fileKey: string,
    ids: string[],
    opts?: { format?: 'png' | 'jpg' | 'svg'; scale?: number },
  ): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    for (const part of chunk(unique(ids), IDS_CHUNK)) {
      const query = new URLSearchParams({ ids: part.join(','), format: opts?.format ?? 'png' });
      if (opts?.scale !== undefined) query.set('scale', String(opts.scale));
      const path = `/v1/images/${encodeURIComponent(fileKey)}`;
      const payload = await this.getJson<{ err?: string | null; images?: Record<string, string | null> }>(
        path,
        query,
      );
      if (payload.err) {
        throw new FigmaError(`Figma не змогла відрендерити кадри (${path}): ${shortBody(payload.err)}`, {
          status: 502,
        });
      }
      Object.assign(out, payload.images ?? {});
    }
    return out;
  }

  /** Завантажує файл за посиланням з `getImageUrls` (S3, без токена). */
  async download(url: string): Promise<{ data: Buffer; mediaType: string }> {
    const response = await this.send(url, {}, 'GET завантаження картинки');
    const data = Buffer.from(await response.arrayBuffer());
    const mediaType =
      response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
    return { data, mediaType };
  }

  /** Версія файлу для кешу: `getFile` з `depth=1`. */
  async getVersion(fileKey: string): Promise<{ version: string; lastModified: string; name: string }> {
    const file = await this.getFile(fileKey, { depth: 1 });
    return { version: String(file.version), lastModified: file.lastModified, name: file.name };
  }

  private async getJson<T>(path: string, query: URLSearchParams): Promise<T> {
    const qs = query.toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
    const response = await this.send(url, { 'X-Figma-Token': this.token, Accept: 'application/json' }, `GET ${path}`);
    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new FigmaError(`Figma повернула не-JSON на GET ${path}: ${shortBody(text)}`, {
        status: response.status,
      });
    }
  }

  /** Запит із повторами на 429/5xx. Повертає лише успішну відповідь. */
  private async send(url: string, headers: Record<string, string>, label: string): Promise<Response> {
    let lastStatus = 0;
    let lastBody = '';
    let lastHeaders: Headers | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new FigmaError(`Не вдалося звернутися до Figma (${label}): ${reason}`, { cause: error });
      }
      if (response.ok) return response;

      lastStatus = response.status;
      lastHeaders = response.headers;
      lastBody = await response.text().catch(() => response.statusText);

      if (!RETRYABLE_STATUSES.has(response.status) || attempt === MAX_RETRIES) break;
      const delay = retryDelay(response.headers.get('retry-after'), attempt);
      if (delay > MAX_RETRY_WAIT_MS) {
        throw new FigmaError(this.describeFailure(lastStatus, lastBody, label, lastHeaders), {
          status: lastStatus,
          retryAfterMs: delay,
        });
      }
      await this.sleep(delay);
    }

    throw new FigmaError(this.describeFailure(lastStatus, lastBody, label, lastHeaders), {
      status: lastStatus,
    });
  }

  private describeFailure(status: number, body: string, label: string, headers?: Headers): string {
    const detail = shortBody(body);
    let hint = '';
    if (status === 401 || status === 403) {
      hint =
        ' Токен недійсний, прострочений або не має доступу до файлу. Перевірте FIGMA_TOKEN і те, що файл розшарено власнику токена.';
    } else if (status === 404) {
      hint = ' Файл чи вузол не знайдено (або токен його не бачить).';
    } else if (status === 429) {
      const tier = headers?.get('x-figma-plan-tier');
      const limitType = headers?.get('x-figma-rate-limit-type');
      const extra = [tier && `тариф ${tier}`, limitType && `тип ліміту ${limitType}`].filter(Boolean).join(', ');
      hint =
        ' Перевищено ліміт запитів Figma. Ліміти залежать від тарифу й типу місця власника токена — потрібне місце Full або Dev.' +
        (extra ? ` (${extra})` : '');
    }
    return `Figma ${status} на ${label}.${hint}${detail ? ` Відповідь: ${detail}` : ''}`;
  }
}

function unique(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

/** `Retry-After` у секундах або HTTP-даті; інакше експоненційна пауза. */
function retryDelay(header: string | null, attempt: number): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(date - Date.now(), 0);
  }
  return Math.min(RETRY_BASE_MS * 2 ** attempt, MAX_RETRY_WAIT_MS);
}

/* ─────────────────────────────── кадри ───────────────────────────────── */

const FRAME_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET']);

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isVisible(node: FigmaNode): boolean {
  return node.visible !== false;
}

function propertyName(raw: string): string {
  // Не-варіантні властивості мають суфікс ID: `Label#123:0` → `Label`.
  return raw.replace(/#[^#]*$/, '').trim() || raw;
}

interface PositionedText {
  text: string;
  x: number;
  y: number;
  order: number;
}

function buildFrame(frame: FigmaNode, pageName: string): FigmaFrame {
  const positioned: PositionedText[] = [];
  const components: FigmaFrame['components'] = [];
  const seenComponents = new Set<string>();

  const walk = (node: FigmaNode, insideInstance: boolean) => {
    if (!isVisible(node)) return;
    if (node.type === 'TEXT') {
      const text = normalizeText(node.characters ?? '');
      if (text) {
        const box = node.absoluteBoundingBox;
        positioned.push({
          text,
          x: box ? Math.round(box.x) : Number.POSITIVE_INFINITY,
          y: box ? Math.round(box.y) : Number.POSITIVE_INFINITY,
          order: positioned.length,
        });
      }
    }
    // Вкладені інстанси (іконка в кнопці) — шум; беремо лише зовнішній, але тексти — всі.
    if (node.type === 'INSTANCE' && !insideInstance) {
      const properties: Record<string, string> = {};
      const raw = node.componentProperties ?? {};
      // Порядок властивостей — як у Figma (Variant зазвичай першим); для дедупу — сортуємо.
      for (const key of Object.keys(raw)) {
        const value = raw[key]?.value;
        if (value === undefined || value === null) continue;
        properties[propertyName(key)] = String(value);
      }
      const name = normalizeText(node.name);
      const key = componentKey({ name, properties });
      if (!seenComponents.has(key)) {
        seenComponents.add(key);
        components.push({ name, properties });
      }
    }
    for (const childNode of node.children ?? []) {
      walk(childNode, insideInstance || node.type === 'INSTANCE');
    }
  };
  walk(frame, false);

  positioned.sort((a, b) => a.y - b.y || a.x - b.x || a.order - b.order);
  const texts: string[] = [];
  for (const item of positioned) {
    if (texts[texts.length - 1] !== item.text) texts.push(item.text);
  }

  const name = normalizeText(frame.name);
  const result: FigmaFrame = {
    nodeId: frame.id,
    name,
    pageName,
    texts,
    components,
    hash: frameHash(name, texts, components),
  };
  const box = frame.absoluteBoundingBox;
  if (box) {
    result.width = box.width;
    result.height = box.height;
  }
  return result;
}

function componentKey(component: { name: string; properties: Record<string, string> }): string {
  return JSON.stringify([component.name, Object.entries(component.properties).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))]);
}

/** Порядок компонентів у хеші не важить: перестановка шарів не має давати «зміну макета». */
function frameHash(name: string, texts: string[], components: FigmaFrame['components']): string {
  const componentKeys = components.map(componentKey).sort();
  return createHash('sha256')
    .update(JSON.stringify({ name, texts, components: componentKeys }))
    .digest('hex')
    .slice(0, 16);
}

function framesOfContainer(children: FigmaNode[] | undefined, pageName: string, out: FigmaFrame[]): void {
  for (const node of children ?? []) {
    if (!isVisible(node)) continue;
    if (FRAME_TYPES.has(node.type)) out.push(buildFrame(node, pageName));
    else if (node.type === 'SECTION') framesOfContainer(node.children, pageName, out);
  }
}

/**
 * Кадри верхнього рівня: діти сторінки (`CANVAS`) типу FRAME / COMPONENT /
 * COMPONENT_SET, а також кадри всередині секцій. Корінь `DOCUMENT` — по всіх
 * сторінках. Якщо корінь сам кадр (запит конкретного вузла) — він і є кадром.
 */
export function extractFrames(root: FigmaNode, opts?: { pageName?: string }): FigmaFrame[] {
  const out: FigmaFrame[] = [];
  if (!root || typeof root !== 'object') return out;
  if (root.type === 'DOCUMENT') {
    for (const page of root.children ?? []) {
      if (page.type === 'CANVAS') framesOfContainer(page.children, opts?.pageName ?? page.name, out);
    }
  } else if (root.type === 'CANVAS') {
    framesOfContainer(root.children, opts?.pageName ?? root.name, out);
  } else if (root.type === 'SECTION') {
    framesOfContainer(root.children, opts?.pageName ?? '', out);
  } else if (FRAME_TYPES.has(root.type)) {
    out.push(buildFrame(root, opts?.pageName ?? ''));
  }
  return out;
}

/** Кадри з усіх сторінок файлу. */
export function extractFramesFromFile(file: FigmaFile): FigmaFrame[] {
  return file?.document ? extractFrames(file.document) : [];
}

/**
 * Кадр → текст блоку вимоги:
 * ```
 * Екран: Вхід
 * Тексти:
 * - Увійти
 * Компоненти й стани:
 * - Button (Variant=Primary, State=Disabled)
 * ```
 */
export function frameToBlockText(frame: FigmaFrame): string {
  const lines = [`Екран: ${frame.name}`];
  if (frame.texts.length > 0) {
    lines.push('Тексти:', ...frame.texts.map((text) => `- ${text}`));
  }
  if (frame.components.length > 0) {
    lines.push('Компоненти й стани:');
    for (const component of frame.components) {
      const props = Object.entries(component.properties).map(([key, value]) => `${key}=${value}`);
      lines.push(props.length > 0 ? `- ${component.name} (${props.join(', ')})` : `- ${component.name}`);
    }
  }
  return lines.join('\n');
}
