import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSecrets } from '../../../src/integrations/errors.js';
import {
  TelegramError,
  TelegramNotifier,
  escapeHtml,
  eventDedupKey,
  formatEvent,
  isTelegramConfigured,
  truncateMessage,
  type NotifyEvent,
} from '../../../src/notify/telegram.js';

const TOKEN = '123456789:AAHsecretTelegramToken_xyz';

function respond(status: number, body?: unknown): Response {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => payload,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
let sleeps: number[];

function notifier(): TelegramNotifier {
  return new TelegramNotifier({
    token: TOKEN,
    chatId: '-1001234',
    fetch: fetchMock as unknown as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
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

describe('TelegramNotifier.send', () => {
  it('шле sendMessage з parse_mode HTML і без прев’ю посилань', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, { ok: true, result: {} }));
    await notifier().send('<b>Привіт</b>');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      chat_id: '-1001234',
      text: '<b>Привіт</b>',
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  });

  it('бере паузу з retry_after у тілі 429 і повторює', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(429, { ok: false, error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } }))
      .mockResolvedValueOnce(respond(200, { ok: true }));
    await notifier().send('x');
    expect(sleeps).toEqual([7000]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('кидає TelegramError з описом і без токена в тексті', async () => {
    fetchMock.mockResolvedValueOnce(respond(400, { ok: false, error_code: 400, description: `Bad Request: chat not found ${TOKEN}` }));
    const error = await notifier().send('x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelegramError);
    expect((error as TelegramError).status).toBe(400);
    expect((error as Error).message).toContain('chat not found');
    expect((error as Error).message).toContain('TELEGRAM_CHAT_ID');
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it('не показує URL з токеном при мережевій помилці', async () => {
    fetchMock.mockRejectedValueOnce(new Error(`connect failed https://api.telegram.org/bot${TOKEN}/sendMessage`));
    const error = await notifier().send('x').catch((e: unknown) => e);
    expect((error as Error).message).toContain('Не вдалося звернутися до Telegram');
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it('обрізає задовге повідомлення до 4000 символів', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, { ok: true }));
    await notifier().send('a'.repeat(5000));
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.text.length).toBeLessThanOrEqual(4000);
    expect(body.text.endsWith('…')).toBe(true);
  });
});

describe('truncateMessage', () => {
  it('не лишає розрізаних і незакритих тегів', () => {
    const html = `<b>Заголовок</b>\n<blockquote>${'слово '.repeat(1000)}</blockquote>`;
    const out = truncateMessage(html);
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out.endsWith('…</blockquote>')).toBe(true);
    expect(truncateMessage('коротко')).toBe('коротко');
  });

  it('не ріже HTML-сутність навпіл', () => {
    const out = truncateMessage(`${'a'.repeat(3930)}&amp;&amp;&amp;&amp;&amp;`, 4000);
    expect(out).not.toMatch(/&[a-z]*…/);
  });
});

describe('formatEvent', () => {
  it('екранує HTML у даних подій', () => {
    const text = formatEvent({ kind: 'stale_task', taskId: 'T-1', title: 'Акт <script> & "лапки"', ageHours: 30, url: 'https://jules/t/1?a=1&b=2' });
    expect(text).toBe(
      '⏰ <b>Запит QA чекає 30 год</b>\nT-1 · Акт &lt;script&gt; &amp; &quot;лапки&quot;\n<a href="https://jules/t/1?a=1&amp;b=2">Відкрити задачу</a>',
    );
  });

  it('не вставляє посилання з небезпечною схемою', () => {
    const text = formatEvent({ kind: 'main_red', project: 'Cyber', sha: 'abcdef1234', failed: 3, url: 'javascript:alert(1)' });
    expect(text).toBe('❌ <b>Червоне на main: Cyber</b>\nКоміт <code>abcdef1</code>, впало тестів: 3.');
  });

  it('форматує решту подій українською з емодзі-маркером', () => {
    expect(formatEvent({ kind: 'source_down', source: 'Confluence', since: '2026-10-18 10:00', error: 'ETIMEDOUT <vpn>' })).toBe(
      '🔴 <b>Недоступне джерело: Confluence</b>\nНе відповідає з 2026-10-18 10:00.\nПомилка: <code>ETIMEDOUT &lt;vpn&gt;</code>',
    );
    expect(formatEvent({ kind: 'source_up', source: 'VPN', downMinutes: 135 })).toBe(
      '🟢 <b>Джерело знову доступне: VPN</b>\nНе працювало 2 год 15 хв.',
    );
    expect(formatEvent({ kind: 'direct_push', project: 'Cyber', sha: '1234567890', author: 'ivan' })).toBe(
      '⚠️ <b>Коміт у main повз PR: Cyber</b>\n<code>1234567</code> · автор ivan',
    );
    expect(formatEvent({ kind: 'stale_task', taskId: 'T-2', title: 'x', ageHours: 72 })).toContain('чекає 3 дн.');
  });

  it('перетворює markdown тижневого звіту на HTML Telegram', () => {
    const text = formatEvent({
      kind: 'weekly',
      project: 'Cyber',
      week: '2026-W42',
      markdown: '## Звіт\n\n### Прогони\n- Успішність: **91% (+3 п.п.)**\n- A <b> \\*не жирне\\*\n\n> висновок\n\n[Дашборд](https://jules/p?a=1&b=2)\n',
    });
    expect(text).toBe(
      [
        '📊 <b>Тижневий звіт QA: Cyber · 2026-W42</b>',
        '',
        '<b>Прогони</b>',
        '• Успішність: <b>91% (+3 п.п.)</b>',
        '• A &lt;b&gt; *не жирне*',
        '',
        '<blockquote>висновок</blockquote>',
        '',
        '<a href="https://jules/p?a=1&amp;b=2">Дашборд</a>',
      ].join('\n'),
    );
  });
});

describe('eventDedupKey', () => {
  it('дає ключі за правилами дедуплікації', () => {
    expect(eventDedupKey({ kind: 'source_down', source: 'confluence', since: '2026-10-18T10:00:00Z' })).toBe(
      'source_down:confluence:2026-10-18T10:00:00Z',
    );
    expect(eventDedupKey({ kind: 'main_red', project: 'cyber', sha: 'abc', failed: 1 })).toBe('main_red:cyber:abc');
    expect(eventDedupKey({ kind: 'weekly', project: 'cyber', week: '2026-W42', markdown: 'x' })).toBe('weekly:cyber:2026-W42');
    expect(eventDedupKey({ kind: 'direct_push', project: 'cyber', sha: 'def' })).toBe('direct_push:cyber:def');
  });

  it('stale_task — одне нагадування на добу очікування', () => {
    const at = (ageHours: number): NotifyEvent => ({ kind: 'stale_task', taskId: 'T-1', title: 'x', ageHours });
    expect(eventDedupKey(at(5))).toBe(eventDedupKey(at(23.9)));
    expect(eventDedupKey(at(24))).not.toBe(eventDedupKey(at(23)));
    expect(eventDedupKey(at(30))).toBe('stale_task:T-1:d1');
  });

  it('main_red не залежить від кількості падінь у тому ж коміті', () => {
    expect(eventDedupKey({ kind: 'main_red', project: 'p', sha: 's', failed: 1 })).toBe(
      eventDedupKey({ kind: 'main_red', project: 'p', sha: 's', failed: 5, url: 'https://x' }),
    );
  });
});

describe('допоміжні', () => {
  it('escapeHtml екранує & < > "', () => {
    expect(escapeHtml(`a & <b> "c"`)).toBe('a &amp; &lt;b&gt; &quot;c&quot;');
    expect(escapeHtml('')).toBe('');
  });

  it('isTelegramConfigured вимагає токен і чат', () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'x');
    vi.stubEnv('TELEGRAM_CHAT_ID', '');
    expect(isTelegramConfigured()).toBe(false);
    vi.stubEnv('TELEGRAM_CHAT_ID', '-1');
    expect(isTelegramConfigured()).toBe(true);
  });

  it('конструктор вимагає токен і чат', () => {
    expect(() => new TelegramNotifier({ token: '', chatId: '1' })).toThrow(/TELEGRAM_BOT_TOKEN/);
    expect(() => new TelegramNotifier({ token: TOKEN, chatId: '' })).toThrow(/TELEGRAM_CHAT_ID/);
  });
});
