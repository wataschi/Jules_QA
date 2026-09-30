/**
 * Авторизація HTTP API і захист вихідних запитів до LLM.
 *
 *  - якщо задано `JULES_API_TOKEN`, кожен запит до `/api/**` мусить мати
 *    `Authorization: Bearer <token>` або `?token=<token>` (другий варіант —
 *    для SSE й посилань на файли, де заголовок не поставити);
 *  - виняток лише один: `GET /api/health` (для healthcheck Docker);
 *  - без змінної сервер працює як раніше, але пише попередження при старті.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

const BEARER = /^Bearer\s+(.+)$/i;

export function getApiToken(): string | undefined {
  const token = process.env.JULES_API_TOKEN?.trim();
  return token ? token : undefined;
}

function extractToken(req: Request): string | undefined {
  const header = req.get('authorization');
  const match = header ? BEARER.exec(header.trim()) : null;
  if (match?.[1]) return match[1].trim();

  const queryToken = req.query?.token;
  if (typeof queryToken === 'string' && queryToken) return queryToken;

  const headerToken = req.get('x-jules-token');
  return headerToken ? headerToken.trim() : undefined;
}

/** `X-Jules-User` → автор змін; без заголовка — `'local'`. */
export function requestAuthor(req: Request): string {
  const user = req.get('x-jules-user');
  return user && user.trim() ? user.trim() : 'local';
}

/** Порівняння без ранніх виходів — щоб не було часового каналу. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function isPublicPath(req: Request): boolean {
  const path = req.path.replace(/\/+$/, '') || '/';
  if (!path.startsWith('/api')) return true;
  return req.method === 'GET' && path === '/api/health';
}

export function createAuthMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const expected = getApiToken();
    if (!expected || isPublicPath(req)) {
      next();
      return;
    }

    const provided = extractToken(req);
    if (!provided || !safeEqual(provided, expected)) {
      res.status(401).json({ error: 'Потрібен токен: Authorization: Bearer <JULES_API_TOKEN> або ?token=' });
      return;
    }
    next();
  };
}

/** Попередження при старті, якщо API відкритий. */
export function warnIfApiUnprotected(log: (message: string) => void = console.warn): void {
  if (getApiToken()) return;
  log(
    '[auth] JULES_API_TOKEN не задано — API відкритий без авторизації. ' +
      'Для захисту задайте JULES_API_TOKEN у .env.',
  );
}

/* ───────────────── allowlist для вихідних запитів до LLM ───────────────── */

const LLM_ENV_KEYS = [
  'MIDSCENE_MODEL_BASE_URL',
  'PLANNER_MODEL_BASE_URL',
  'CRITIC_MODEL_BASE_URL',
] as const;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal']);

function hostOf(raw: string): string | null {
  try {
    return new URL(raw).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Хости, на які дозволено ходити з `GET /api/llm/check`. */
export function allowedLlmHosts(): string[] {
  const hosts = new Set<string>();
  for (const key of LLM_ENV_KEYS) {
    const value = process.env[key];
    if (!value) continue;
    const host = hostOf(value);
    if (host) hosts.add(host);
  }
  return Array.from(hosts);
}

/**
 * Пускає лише налаштовані в середовищі базові URL моделей і локальні адреси.
 * Це закриває канал витоку ключа: інакше користувацький `llmBaseUrl`
 * із налаштувань міг відправити `MIDSCENE_MODEL_API_KEY` на чужий сервер.
 */
export function isLlmBaseUrlAllowed(raw: string): boolean {
  const host = hostOf(raw);
  if (!host) return false;
  const hostname = host.replace(/:\d+$/, '');
  if (LOCAL_HOSTS.has(hostname) || LOCAL_HOSTS.has(host)) return true;
  return allowedLlmHosts().some((allowed) => allowed === host || allowed.replace(/:\d+$/, '') === hostname);
}
