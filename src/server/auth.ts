/**
 * Авторизація HTTP API і захист вихідних запитів до LLM.
 *
 * Хто є хто (перше, що спрацює):
 *  1. Людина через Tailscale Serve: заголовок `Tailscale-User-Login`. Йому
 *     довіряємо ЛИШЕ для з'єднань із loopback — саме так приходить проксі
 *     `tailscale serve`, тому сервер на Mac Studio слухає `127.0.0.1`.
 *  2. `Authorization: Bearer <JULES_API_TOKEN>` — адмін-токен із `.env`.
 *  3. `Authorization: Bearer <токен з api_tokens>` — CI репо продукту
 *     (лише інжест і статус свого проєкту) або запасний персональний токен.
 *  4. Без облікових даних: якщо ні `JULES_API_TOKEN`, ні `JULES_REQUIRE_AUTH=1`
 *     не задано — локальний режим без авторизації, як раніше (розробка, тести).
 *
 * Публічні без авторизації: `GET /api/health`, `GET /cli/jules-qa.mjs` і статика UI.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { findActiveToken, listUsers, touchUser } from '../registry/access-store.js';
import type { UserRole } from '../registry/types.js';

const BEARER = /^Bearer\s+(.+)$/i;

export type PrincipalRole = UserRole | 'ci';

export interface Principal {
  login: string;
  name?: string;
  role: PrincipalRole;
  kind: 'person' | 'token' | 'local';
  /** Для токена CI — проєкт, до якого він прив'язаний. */
  projectId?: string;
  tokenId?: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    principal?: Principal;
  }
}

/** Помилка з HTTP-статусом: маршрути віддають її як є. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function getApiToken(): string | undefined {
  const token = process.env.JULES_API_TOKEN?.trim();
  return token ? token : undefined;
}

function authRequired(): boolean {
  return Boolean(getApiToken()) || process.env.JULES_REQUIRE_AUTH === '1';
}

function trustTailscale(): boolean {
  return process.env.JULES_TRUST_TAILSCALE !== '0';
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

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopback(req: Request): boolean {
  return LOOPBACK.has(req.socket?.remoteAddress ?? '');
}

/** Автор змін: людина з Tailscale, власник токена або `X-Jules-User` у локальному режимі. */
export function requestAuthor(req: Request): string {
  if (req.principal && req.principal.kind !== 'local') return req.principal.login;
  const user = req.get('x-jules-user');
  return user && user.trim() ? user.trim() : (req.principal?.login ?? 'local');
}

/** Кидає 403, якщо роль запиту не з переліку. Адмін і локальний режим проходять завжди. */
export function requireRole(req: Request, ...roles: PrincipalRole[]): Principal {
  const principal = req.principal;
  if (!principal) throw new HttpError(401, 'Потрібна авторизація');
  if (principal.role === 'admin' || roles.includes(principal.role)) return principal;
  throw new HttpError(403, `Недостатньо прав: потрібна роль ${roles.join(' або ')}`);
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

/**
 * Шлях у тому вигляді, в якому його зіставляє Express: без урахування регістру,
 * з декодованими символами й без зайвих скісних рисок. Інакше `/API/...`
 * пройшов би повз перевірку, а маршрут однаково спрацював би.
 */
export function normalizedPath(req: Request): string {
  let path = req.path;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Некоректне кодування лишаємо як є: такий шлях однаково не знайде маршруту.
  }
  return path.toLowerCase().replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
}

function isProtectedPath(path: string): boolean {
  return path === '/mcp' || path.startsWith('/mcp/') || path === '/api' || path.startsWith('/api/');
}

export function isPublicPath(req: Request): boolean {
  const path = normalizedPath(req);
  if (!isProtectedPath(path)) return true;
  return req.method === 'GET' && path === '/api/health';
}

/** Маршрути, доступні токену CI: інжест, статус, резервування ID і читання свого проєкту. */
const CI_ALLOWED: Array<{ method?: string; pattern: RegExp }> = [
  { method: 'POST', pattern: /^\/api\/registry\/ingest\// },
  { method: 'GET', pattern: /^\/api\/registry\/status(\.md)?$/ },
  { method: 'GET', pattern: /^\/api\/registry\/pr-comment\.md$/ },
  { method: 'POST', pattern: /^\/api\/registry\/cases\/reserve$/ },
  { method: 'GET', pattern: /^\/api\/registry\/projects\/[^/]+$/ },
];

function ciAllowed(req: Request, principal: Principal): boolean {
  const path = normalizedPath(req);
  const allowed = CI_ALLOWED.some((rule) => (!rule.method || rule.method === req.method) && rule.pattern.test(path));
  if (!allowed) return false;
  const ownProject = /^\/api\/registry\/projects\/([^/]+)$/.exec(path);
  return !ownProject || ownProject[1] === principal.projectId?.toLowerCase();
}

const ROLE_RANK: Record<UserRole, number> = { dev: 0, qa: 1, admin: 2 };

/** Персональний токен не дає більше, ніж власник має зараз: зниження ролі діє одразу. */
function personalTokenRole(role: PrincipalRole, owner?: string): PrincipalRole {
  if (role === 'ci' || !owner) return role;
  const current = listUsers().find((user) => user.login === owner)?.role;
  if (!current) return role;
  return ROLE_RANK[current] < ROLE_RANK[role] ? current : role;
}

function resolvePrincipal(req: Request): Principal | 'invalid' | null {
  const login = req.get('tailscale-user-login')?.trim();
  if (login && trustTailscale() && isLoopback(req)) {
    const user = touchUser(login, req.get('tailscale-user-name')?.trim() || undefined);
    return { login: user.login, name: user.name, role: user.role, kind: 'person' };
  }

  const provided = extractToken(req);
  if (provided) {
    const envToken = getApiToken();
    if (envToken && safeEqual(provided, envToken)) {
      return { login: req.get('x-jules-user')?.trim() || 'admin', role: 'admin', kind: 'token' };
    }
    const token = findActiveToken(provided);
    if (!token) return 'invalid';
    return {
      login: token.owner ?? token.name,
      role: personalTokenRole(token.role, token.owner),
      kind: 'token',
      projectId: token.projectId,
      tokenId: token.id,
    };
  }
  return null;
}

export function createAuthMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isPublicPath(req)) {
      next();
      return;
    }

    let principal: Principal | 'invalid' | null;
    try {
      principal = resolvePrincipal(req);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: `Не вдалося перевірити доступ: ${reason}` });
      return;
    }

    if (principal === 'invalid') {
      res.status(401).json({ error: 'Токен недійсний або відкликаний' });
      return;
    }
    if (!principal) {
      if (authRequired()) {
        res.status(401).json({
          error: 'Потрібна авторизація: зайдіть через Tailscale або передайте Authorization: Bearer <токен>',
        });
        return;
      }
      principal = { login: req.get('x-jules-user')?.trim() || 'local', role: 'admin', kind: 'local' };
    }

    if (principal.role === 'ci') {
      if (!ciAllowed(req, principal)) {
        res.status(403).json({ error: 'Токен CI має доступ лише до інжесту й статусу свого проєкту' });
        return;
      }
    }

    req.principal = principal;
    next();
  };
}

/** Попередження при старті, якщо API відкритий. */
export function warnIfApiUnprotected(log: (message: string) => void = console.warn): void {
  if (authRequired()) return;
  log(
    '[auth] Авторизацію вимкнено: задайте JULES_REQUIRE_AUTH=1 (вхід через Tailscale і токени) ' +
      'або JULES_API_TOKEN у .env. Без цього API відкритий для всіх, хто бачить порт.',
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
