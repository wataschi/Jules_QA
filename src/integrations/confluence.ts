/**
 * Інтеграція з Confluence Cloud: витяг сторінки вимог і розбиття її на блоки.
 *
 * Дві незалежні частини:
 *  1. `fetchConfluencePage` — REST-запит (Basic auth: email + API-токен).
 *     Спершу пробуємо v2 (`/wiki/api/v2/pages/{id}?body-format=storage`),
 *     на старих інстансах падаємо на v1
 *     (`/wiki/rest/api/content/{id}?expand=body.storage,version`).
 *  2. `splitIntoBlocks` — власний мінімальний парсер storage-HTML,
 *     БЕЗ зовнішніх залежностей: нам не потрібен повноцінний DOM, потрібні
 *     межі за заголовками й читабельний для моделі текст.
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

/* ─────────────────────────────── конфіг ──────────────────────────────── */

interface ConfluenceConfig {
  /** Базовий сайт без `/wiki`: `https://acme.atlassian.net`. */
  site: string;
  email: string;
  token: string;
  timeoutMs: number;
}

/** Чи задані всі три змінні оточення для Confluence. */
export function isConfluenceConfigured(): boolean {
  const { CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN } = process.env;
  return Boolean(CONFLUENCE_BASE_URL && CONFLUENCE_EMAIL && CONFLUENCE_API_TOKEN);
}

function readConfig(): ConfluenceConfig {
  const base = process.env.CONFLUENCE_BASE_URL;
  const email = process.env.CONFLUENCE_EMAIL;
  const token = process.env.CONFLUENCE_API_TOKEN;
  if (!base || !email || !token) {
    throw new ConfluenceError(
      'Confluence не налаштовано. Додайте в .env: CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN.',
    );
  }
  registerSecret(token);
  return {
    site: base.replace(/\/+$/, '').replace(/\/wiki$/i, ''),
    email,
    token,
    timeoutMs: Number(process.env.CONFLUENCE_TIMEOUT ?? DEFAULT_TIMEOUT_MS),
  };
}

/* ───────────────────────── розпізнавання pageId ──────────────────────── */

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

/* ──────────────────────────── завантаження ───────────────────────────── */

interface ApiPage {
  id?: string | number;
  title?: string;
  version?: { number?: number; createdAt?: string } | number;
  body?: { storage?: { value?: string } };
  _links?: { webui?: string; base?: string; tinyui?: string };
}

function basicAuthHeader(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}:${token}`, 'utf-8').toString('base64')}`;
}

function extractVersion(page: ApiPage): string {
  const version = page.version;
  if (typeof version === 'number') return String(version);
  if (version && typeof version === 'object' && typeof version.number === 'number') {
    return String(version.number);
  }
  return '0';
}

function buildPageUrl(config: ConfluenceConfig, page: ApiPage, pageId: string): string {
  const webui = page._links?.webui;
  const base = page._links?.base ?? `${config.site}/wiki`;
  if (webui) {
    return webui.startsWith('http') ? webui : `${base.replace(/\/+$/, '')}${webui}`;
  }
  return `${config.site}/wiki/pages/viewpage.action?pageId=${pageId}`;
}

async function requestPage(
  config: ConfluenceConfig,
  url: string,
): Promise<{ ok: true; page: ApiPage } | { ok: false; status: number; body: string }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: basicAuthHeader(config.email, config.token),
      },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfluenceError(`Не вдалося звернутися до Confluence: ${reason}`, { cause: error });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => response.statusText);
    return { ok: false, status: response.status, body };
  }
  const page = (await response.json().catch(() => null)) as ApiPage | null;
  if (!page) {
    throw new ConfluenceError('Confluence повернув відповідь, яка не є JSON.', { status: 502 });
  }
  return { ok: true, page };
}

/**
 * Тягне сторінку за URL або ID у storage-форматі.
 * Потребує `CONFLUENCE_BASE_URL` + `CONFLUENCE_EMAIL` + `CONFLUENCE_API_TOKEN`.
 */
export async function fetchConfluencePage(ref: {
  url?: string;
  pageId?: string;
}): Promise<ConfluencePage> {
  const config = readConfig();
  const pageId = ref.pageId?.trim() || (ref.url ? parseConfluencePageId(ref.url) : null);
  if (!pageId) {
    throw new ConfluenceError(
      `Не вдалося визначити ID сторінки Confluence${ref.url ? ` з посилання ${ref.url}` : ''}. ` +
        'Очікується посилання виду /wiki/spaces/КОД/pages/123456789/Назва або числовий ID.',
      { status: 400 },
    );
  }

  // v2 — сучасний шлях; v1 лишаємо як запасний для старих інстансів.
  const v2 = `${config.site}/wiki/api/v2/pages/${pageId}?body-format=storage`;
  const v1 = `${config.site}/wiki/rest/api/content/${pageId}?expand=body.storage,version`;

  let attempt = await requestPage(config, v2);
  if (!attempt.ok && [400, 404, 405, 410, 501].includes(attempt.status)) {
    attempt = await requestPage(config, v1);
  }
  if (!attempt.ok) {
    const hint =
      attempt.status === 401 || attempt.status === 403
        ? ' Перевірте CONFLUENCE_EMAIL і CONFLUENCE_API_TOKEN (токен створюється в Atlassian account → API tokens).'
        : attempt.status === 404
          ? ' Сторінку не знайдено або немає прав на перегляд.'
          : '';
    throw new ConfluenceError(
      `Confluence відповів ${attempt.status} на сторінку ${pageId}.${hint} ${shortBody(attempt.body)}`.trim(),
      { status: attempt.status },
    );
  }

  const page = attempt.page;
  const html = page.body?.storage?.value ?? '';
  if (!html) {
    throw new ConfluenceError(
      `Сторінка ${pageId} повернулась без тіла у storage-форматі. Можливо, це не звичайна сторінка (база знань/whiteboard).`,
      { status: 502 },
    );
  }

  return {
    externalId: String(page.id ?? pageId),
    title: page.title ?? `Сторінка ${pageId}`,
    version: extractVersion(page),
    html,
    url: buildPageUrl(config, page, pageId),
  };
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
