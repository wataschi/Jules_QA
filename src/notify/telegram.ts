/**
 * Сповіщення в Telegram (фаза 8 плану): важливе має приходити саме, а не лише
 * бути видним на дашборді.
 *
 *  - `TelegramNotifier.send` — `sendMessage` з `parse_mode: HTML`; на 429 Telegram
 *    кладе паузу в тіло (`parameters.retry_after`), а не в заголовок — беремо звідти;
 *  - токен бота стоїть у шляху URL, тому URL ніколи не потрапляє в помилки,
 *    а сам токен зареєстровано в `registerSecret`;
 *  - `formatEvent` і `eventDedupKey` — чисті функції: що писати й як не написати двічі.
 *    Журнал надісланих ключів веде викликач (сервер), тут бази немає.
 */
import { IntegrationError, registerSecret, shortBody } from '../integrations/errors.js';

export class TelegramError extends IntegrationError {
  constructor(message: string, options?: { status?: number; details?: unknown; cause?: unknown }) {
    super(message, options);
    this.name = 'TelegramError';
  }
}

export interface TelegramNotifierOptions {
  token: string;
  chatId: string;
  fetch?: typeof fetch;
  /** Дефолт `https://api.telegram.org`. */
  apiBase?: string;
  sleep?: (ms: number) => Promise<void>;
  /** Дефолт 15 000 мс. */
  timeoutMs?: number;
  /** Дефолт 5. */
  maxRetries?: number;
}

export type NotifyEvent =
  | { kind: 'source_down'; source: string; since: string; error?: string }
  | { kind: 'source_up'; source: string; downMinutes: number; since?: string }
  | { kind: 'stale_task'; taskId: string; title: string; ageHours: number; url?: string }
  | { kind: 'main_red'; project: string; sha: string; failed: number; url?: string }
  | { kind: 'direct_push'; project: string; sha: string; author?: string }
  | { kind: 'weekly'; project: string; week: string; markdown: string };

/** Ліміт Telegram — 4096 символів; лишаємо запас на закривальні теги. */
export const MESSAGE_LIMIT = 4000;

const DEFAULT_API_BASE = 'https://api.telegram.org';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 5;
const MAX_RETRY_WAIT_MS = 60_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Чи задані змінні оточення для Telegram. */
export function isTelegramConfigured(): boolean {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
  return Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
}

/** Екранування для `parse_mode: HTML`: Telegram розуміє лише `&lt; &gt; &amp; &quot;`. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const TAG_RE = /<(\/?)([a-z-]+)(?:\s[^>]*)?>/gi;

/**
 * Обрізає HTML-повідомлення до ліміту, не ламаючи розмітку: Telegram відхиляє
 * все повідомлення, якщо тег розрізано чи не закрито.
 */
export function truncateMessage(html: string, limit = MESSAGE_LIMIT): string {
  if (html.length <= limit) return html;
  let cut = html.slice(0, limit - 64);
  cut = cut.replace(/<[^>]*$/, '').replace(/&[a-z#0-9]*$/i, '');
  const open: string[] = [];
  for (const match of cut.matchAll(TAG_RE)) {
    const [, closing, name] = match;
    const tag = name.toLowerCase();
    if (closing) {
      const index = open.lastIndexOf(tag);
      if (index >= 0) open.splice(index, 1);
    } else {
      open.push(tag);
    }
  }
  const closers = open.reverse().map((tag) => `</${tag}>`).join('');
  return `${cut.trimEnd()}…${closers}`;
}

function safeUrl(url: string | undefined): string | null {
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : null;
}

function link(url: string | undefined, text: string): string {
  const href = safeUrl(url);
  return href ? `\n<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>` : '';
}

function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total} хв`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${hours} год ${rest} хв` : `${hours} год`;
}

function formatAge(hours: number): string {
  const h = Math.max(0, Math.round(hours));
  if (h < 48) return `${h} год`;
  return `${Math.floor(h / 24)} дн.`;
}

/**
 * Markdown тижневого звіту → HTML Telegram: заголовки й `**…**` — жирним,
 * `[текст](url)` — посиланням, `> ` — цитатою. Таблиць у звіті немає навмисно.
 */
function markdownToTelegramHtml(markdown: string): string {
  const out: string[] = [];
  let quote: string[] = [];
  const flushQuote = () => {
    if (quote.length > 0) out.push(`<blockquote>${quote.join('\n')}</blockquote>`);
    quote = [];
  };
  for (const raw of markdown.split(/\r?\n/)) {
    const quoted = /^>\s?(.*)$/.exec(raw);
    const line = convertInline(quoted ? quoted[1] : raw);
    if (quoted) {
      quote.push(line);
      continue;
    }
    flushQuote();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    out.push(heading ? `<b>${heading[1]}</b>` : line.replace(/^- /, '• '));
  }
  flushQuote();
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function convertInline(line: string): string {
  // Спершу ховаємо екрановані markdown-символи, щоб `\*` не став жирним.
  const escapes: string[] = [];
  let text = line.replace(/\\([\\*_[\]`])/g, (_m, ch: string) => {
    escapes.push(ch);
    return `\u0000${escapes.length - 1}\u0000`;
  });
  text = escapeHtml(text)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  return text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => escapeHtml(escapes[Number(i)]));
}

/** HTML-повідомлення для події: емодзі-маркер, жирний заголовок, деталі. */
export function formatEvent(event: NotifyEvent): string {
  let html: string;
  switch (event.kind) {
    case 'source_down': {
      const error = event.error?.trim()
        ? `\nПомилка: <code>${escapeHtml(shortBody(event.error, 500))}</code>`
        : '';
      html = `🔴 <b>Недоступне джерело: ${escapeHtml(event.source)}</b>\nНе відповідає з ${escapeHtml(event.since)}.${error}`;
      break;
    }
    case 'source_up':
      html =
        `🟢 <b>Джерело знову доступне: ${escapeHtml(event.source)}</b>\n` +
        `Не працювало ${formatDuration(event.downMinutes)}.`;
      break;
    case 'stale_task':
      html =
        `⏰ <b>Запит QA чекає ${formatAge(event.ageHours)}</b>\n` +
        `${escapeHtml(event.taskId)} · ${escapeHtml(event.title)}${link(event.url, 'Відкрити задачу')}`;
      break;
    case 'main_red':
      html =
        `❌ <b>Червоне на main: ${escapeHtml(event.project)}</b>\n` +
        `Коміт <code>${escapeHtml(event.sha.slice(0, 7))}</code>, впало тестів: ${event.failed}.` +
        link(event.url, 'Деталі прогону');
      break;
    case 'direct_push':
      html =
        `⚠️ <b>Коміт у main повз PR: ${escapeHtml(event.project)}</b>\n` +
        `<code>${escapeHtml(event.sha.slice(0, 7))}</code>` +
        (event.author ? ` · автор ${escapeHtml(event.author)}` : '');
      break;
    case 'weekly':
      html =
        `📊 <b>Тижневий звіт QA: ${escapeHtml(event.project)} · ${escapeHtml(event.week)}</b>\n\n` +
        // Заголовок звіту дублює наш — прибираємо перший рядок-заголовок markdown.
        markdownToTelegramHtml(event.markdown.replace(/^\s*#{1,6}\s+[^\n]*\n?/, ''));
      break;
  }
  return truncateMessage(html);
}

/**
 * Ключ дедуплікації: одна й та сама подія не має прийти двічі.
 * `stale_task` — одне нагадування на добу очікування (доба рахується від віку задачі,
 * тож ключ не залежить від годинника сервера й однаковий між перезапусками).
 */
export function eventDedupKey(event: NotifyEvent): string {
  switch (event.kind) {
    case 'source_down':
      return `source_down:${event.source}:${event.since}`;
    case 'source_up':
      // Початок падіння в ключі: друге падіння тієї самої тривалості — інша подія.
      return event.since
        ? `source_up:${event.source}:${event.since}`
        : `source_up:${event.source}:${Math.round(event.downMinutes)}`;
    case 'stale_task':
      return `stale_task:${event.taskId}:d${Math.floor(Math.max(0, event.ageHours) / 24)}`;
    case 'main_red':
      return `main_red:${event.project}:${event.sha}`;
    case 'direct_push':
      return `direct_push:${event.project}:${event.sha}`;
    case 'weekly':
      return `weekly:${event.project}:${event.week}`;
  }
}

interface TelegramResponse {
  ok?: boolean;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export class TelegramNotifier {
  private readonly endpoint: string;
  private readonly chatId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(opts: TelegramNotifierOptions) {
    if (!opts.token) throw new TelegramError('Не задано TELEGRAM_BOT_TOKEN.', { status: 400 });
    if (!opts.chatId) throw new TelegramError('Не задано TELEGRAM_CHAT_ID.', { status: 400 });
    registerSecret(opts.token);
    this.endpoint = `${(opts.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '')}/bot${opts.token}/sendMessage`;
    this.chatId = opts.chatId;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? defaultSleep;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  /** Надсилає HTML-повідомлення в чат. Довше за 4000 символів — обрізається. */
  async send(text: string): Promise<void> {
    const body = JSON.stringify({
      chat_id: this.chatId,
      text: truncateMessage(text),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    let lastStatus = 0;
    let lastDetail = '';

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        // Без `cause`: у помилці fetch буває URL, а в URL — токен бота.
        const reason = error instanceof Error ? error.message : String(error);
        throw new TelegramError(`Не вдалося звернутися до Telegram: ${reason}`);
      }

      const raw = await response.text().catch(() => '');
      let parsed: TelegramResponse = {};
      try {
        parsed = raw ? (JSON.parse(raw) as TelegramResponse) : {};
      } catch {
        parsed = {};
      }
      if (response.ok && parsed.ok !== false) return;

      lastStatus = response.status;
      lastDetail = parsed.description ?? shortBody(raw);
      if (response.status === 429 && attempt < this.maxRetries) {
        const seconds = parsed.parameters?.retry_after ?? Number(response.headers.get('retry-after') ?? 1);
        const wait = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000;
        await this.sleep(Math.min(wait, MAX_RETRY_WAIT_MS));
        continue;
      }
      break;
    }

    const hint =
      lastStatus === 401 || lastStatus === 404
        ? ' Перевірте TELEGRAM_BOT_TOKEN.'
        : lastStatus === 400 || lastStatus === 403
          ? ' Перевірте TELEGRAM_CHAT_ID і що бота додано в чат (і він може писати).'
          : lastStatus === 429
            ? ' Перевищено ліміт Telegram — повідомлення не надіслано.'
            : '';
    throw new TelegramError(
      `Telegram ${lastStatus} на sendMessage.${hint}${lastDetail ? ` Відповідь: ${shortBody(lastDetail)}` : ''}`,
      { status: lastStatus },
    );
  }
}
