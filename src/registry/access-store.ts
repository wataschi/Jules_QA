/**
 * Люди й токени доступу.
 *
 * Людей Jules бачить через Tailscale Serve (заголовок `Tailscale-User-Login`):
 * перший запит створює запис із роллю за замовчуванням, далі роль міняє
 * адміністратор. Машини (CI репо продукту) і запасні персональні токени —
 * у `api_tokens`; у базі лежить лише sha256 токена, сам токен показується
 * один раз під час видачі.
 */
import { createHash, randomBytes } from 'node:crypto';
import { execute, nowIso, query, queryOne, type Row } from './db.js';
import { newId } from './ids.js';
import type { TokenRole, UserRole } from './types.js';

export interface User {
  login: string;
  name?: string;
  role: UserRole;
  createdAt: string;
  lastSeenAt: string;
}

export interface ApiToken {
  id: string;
  name: string;
  role: TokenRole;
  projectId?: string;
  owner?: string;
  createdBy: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

function rowToUser(row: Row): User {
  return {
    login: String(row.login),
    name: (row.name as string | null) ?? undefined,
    role: row.role as UserRole,
    createdAt: String(row.created_at),
    lastSeenAt: String(row.last_seen_at),
  };
}

function rowToToken(row: Row): ApiToken {
  return {
    id: String(row.id),
    name: String(row.name),
    role: row.role as TokenRole,
    projectId: (row.project_id as string | null) ?? undefined,
    owner: (row.owner as string | null) ?? undefined,
    createdBy: String(row.created_by),
    createdAt: String(row.created_at),
    lastUsedAt: (row.last_used_at as string | null) ?? undefined,
    revokedAt: (row.revoked_at as string | null) ?? undefined,
  };
}

function listFromEnv(name: string): Set<string> {
  return new Set(
    (process.env[name] ?? '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Роль нового користувача: списки з `.env` задають перших адмінів і QA. */
function initialRole(login: string): UserRole {
  const key = login.toLowerCase();
  if (listFromEnv('JULES_ADMINS').has(key)) return 'admin';
  if (listFromEnv('JULES_QA_USERS').has(key)) return 'qa';
  return 'dev';
}

/** Запис користувача з Tailscale: створює при першому вході, оновлює час. */
export function touchUser(login: string, name?: string): User {
  const at = nowIso();
  const existing = queryOne<Row>('SELECT * FROM users WHERE login = ?', [login]);
  if (existing) {
    execute('UPDATE users SET last_seen_at = ?, name = COALESCE(?, name) WHERE login = ?', [at, name ?? null, login]);
    return rowToUser({ ...existing, last_seen_at: at, name: name ?? existing.name });
  }
  execute('INSERT INTO users (login, name, role, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)', [
    login,
    name ?? null,
    initialRole(login),
    at,
    at,
  ]);
  return rowToUser(queryOne<Row>('SELECT * FROM users WHERE login = ?', [login]) as Row);
}

export function listUsers(): User[] {
  return query<Row>('SELECT * FROM users ORDER BY login').map(rowToUser);
}

export function setUserRole(login: string, role: UserRole): User {
  const result = execute('UPDATE users SET role = ? WHERE login = ?', [role, login]);
  if (Number(result.changes) === 0) throw new Error(`Користувача «${login}» не знайдено`);
  return rowToUser(queryOne<Row>('SELECT * FROM users WHERE login = ?', [login]) as Row);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface IssueTokenInput {
  name: string;
  role: TokenRole;
  projectId?: string;
  owner?: string;
  createdBy: string;
}

/** Видає токен. Значення повертається лише тут — у базі тільки хеш. */
export function issueToken(input: IssueTokenInput): { token: string; record: ApiToken } {
  if (input.role === 'ci' && !input.projectId) {
    throw new Error('Токен CI має бути прив’язаний до проєкту');
  }
  const token = `jqa_${randomBytes(24).toString('base64url')}`;
  const id = newId('tok');
  execute(
    `INSERT INTO api_tokens (id, name, token_hash, role, project_id, owner, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.name, hashToken(token), input.role, input.projectId ?? null, input.owner ?? null, input.createdBy, nowIso()],
  );
  return { token, record: rowToToken(queryOne<Row>('SELECT * FROM api_tokens WHERE id = ?', [id]) as Row) };
}

/** Активний токен за значенням або `null`. Оновлює час останнього використання. */
export function findActiveToken(token: string): ApiToken | null {
  const row = queryOne<Row>('SELECT * FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL', [hashToken(token)]);
  if (!row) return null;
  execute('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', [nowIso(), row.id]);
  return rowToToken(row);
}

export function listTokens(projectId?: string): ApiToken[] {
  const rows = projectId
    ? query<Row>('SELECT * FROM api_tokens WHERE project_id = ? ORDER BY created_at DESC', [projectId])
    : query<Row>('SELECT * FROM api_tokens ORDER BY created_at DESC');
  return rows.map(rowToToken);
}

export function revokeToken(id: string): void {
  const result = execute('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [nowIso(), id]);
  if (Number(result.changes) === 0) throw new Error(`Токен «${id}» не знайдено або вже відкликано`);
}
