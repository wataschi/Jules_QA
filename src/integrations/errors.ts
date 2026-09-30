/**
 * Помилки зовнішніх інтеграцій (Confluence, TestRail).
 *
 * Правила:
 *  - жоден секрет (API-ключ, токен, Basic-заголовок) не потрапляє ні в текст
 *    помилки, ні в лог — усе, що йде назовні, проходить через `redactSecrets`;
 *  - повідомлення українською, бо їх видно в UI черги апрувів і в логах скілів;
 *  - `status` — HTTP-код зовнішнього API, щоб маршрути могли віддати 502/400.
 */

/** Базовий клас для помилок інтеграцій. */
export class IntegrationError extends Error {
  readonly status?: number;
  readonly details?: unknown;

  constructor(message: string, options?: { status?: number; details?: unknown; cause?: unknown }) {
    super(redactSecrets(message));
    this.name = 'IntegrationError';
    this.status = options?.status;
    this.details = options?.details;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Помилка Confluence Cloud REST. */
export class ConfluenceError extends IntegrationError {
  constructor(message: string, options?: { status?: number; details?: unknown; cause?: unknown }) {
    super(message, options);
    this.name = 'ConfluenceError';
  }
}

/** Помилка TestRail API. `status` — код відповіді (429, 400, 401...). */
export class TestrailError extends IntegrationError {
  constructor(message: string, options?: { status?: number; details?: unknown; cause?: unknown }) {
    super(message, options);
    this.name = 'TestrailError';
  }
}

/**
 * Секрети, які треба вирізати з будь-якого тексту помилки. Реєструються
 * клієнтами при створенні: клієнт знає свій ключ, помилка — ні.
 */
const knownSecrets = new Set<string>();

/** Реєструє секрет, щоб він ніколи не потрапив у текст помилки чи лог. */
export function registerSecret(secret: string | undefined): void {
  if (!secret) return;
  // Надто короткі рядки могли б вирізати корисний текст.
  if (secret.length < 6) return;
  knownSecrets.add(secret);
}

/** Тільки для тестів: очищає реєстр секретів. */
export function resetSecrets(): void {
  knownSecrets.clear();
}

const BASIC_AUTH_RE = /\b(Basic|Bearer)\s+[A-Za-z0-9+/=._-]{8,}/gi;
const AUTH_HEADER_RE = /("?(?:authorization|x-api-key|api[_-]?key|token)"?\s*[:=]\s*)("?)[^"\s,}]+\2/gi;

/** Вирізає з тексту відомі секрети й типові заголовки авторизації. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const secret of knownSecrets) {
    out = out.split(secret).join('***');
  }
  out = out.replace(BASIC_AUTH_RE, (_m, scheme: string) => `${scheme} ***`);
  out = out.replace(AUTH_HEADER_RE, (_m, prefix: string) => `${prefix}***`);
  return out;
}

/** Обрізає тіло відповіді до розумної довжини для повідомлення про помилку. */
export function shortBody(body: string, limit = 300): string {
  const clean = redactSecrets(body.replace(/\s+/g, ' ').trim());
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

/** Людське повідомлення з довільної помилки (для warnings у скілах). */
export function describeError(error: unknown): string {
  if (error instanceof Error) return redactSecrets(error.message);
  return redactSecrets(String(error));
}
