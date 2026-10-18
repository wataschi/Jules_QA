/**
 * Стан зовнішніх систем: Confluence (за VPN Mac Studio), Jira, Figma, Telegram.
 * Результат пишеться в `health_checks`; перехід «працює → лежить» і назад
 * стає подією для сповіщень — саме так розрив VPN видно одразу.
 */
import { execute, nowIso, query, queryOne, toJson, fromJson, type Row } from '../registry/db.js';
import { enqueueNotification } from '../registry/notifications-store.js';
import { isConfluenceConfigured, readConfluenceConfig, resolveConfluenceRef } from '../integrations/confluence.js';
import { createJiraClientFromEnv, isJiraConfigured } from '../integrations/jira.js';
import { isFigmaConfigured } from '../integrations/figma.js';
import { isTelegramConfigured } from '../notify/telegram.js';
import type { HealthCheck } from '../registry/types.js';

export const HEALTH_TARGETS = ['confluence', 'jira', 'figma'] as const;
export type HealthTarget = (typeof HEALTH_TARGETS)[number];

const LABELS: Record<HealthTarget, string> = { confluence: 'Confluence', jira: 'Jira', figma: 'Figma' };

function rowToHealth(row: Row): HealthCheck {
  return {
    target: String(row.target),
    ok: Boolean(row.ok),
    checkedAt: String(row.checked_at),
    since: String(row.since),
    error: (row.error as string | null) ?? undefined,
    details: fromJson<Record<string, unknown>>(row.details, {}),
  };
}

export function listHealth(): HealthCheck[] {
  return query<Row>('SELECT * FROM health_checks ORDER BY target').map(rowToHealth);
}

/** Записує результат і, якщо стан змінився, ставить подію в чергу сповіщень. */
export function recordHealth(target: string, ok: boolean, error?: string, details: Record<string, unknown> = {}): HealthCheck {
  const at = nowIso();
  const previous = queryOne<Row>('SELECT * FROM health_checks WHERE target = ?', [target]);
  const changed = !previous || Boolean(previous.ok) !== ok;
  const since = changed ? at : String(previous?.since ?? at);
  execute(
    `INSERT INTO health_checks (target, ok, checked_at, since, error, details) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(target) DO UPDATE SET ok = excluded.ok, checked_at = excluded.checked_at, since = excluded.since,
       error = excluded.error, details = excluded.details`,
    [target, ok ? 1 : 0, at, since, error ?? null, toJson(details)],
  );
  const label = LABELS[target as HealthTarget] ?? target;
  if (changed && previous && !ok) enqueueNotification({ kind: 'source_down', source: label, since, error });
  if (changed && previous && ok) {
    const downMinutes = Math.round((Date.parse(at) - Date.parse(String(previous.since))) / 60_000);
    enqueueNotification({ kind: 'source_up', source: label, downMinutes });
  }
  return rowToHealth(queryOne<Row>('SELECT * FROM health_checks WHERE target = ?', [target]) as Row);
}

async function probe(target: HealthTarget, fetchImpl?: typeof fetch): Promise<{ ok: boolean; error?: string; details?: Record<string, unknown> }> {
  if (target === 'confluence') {
    if (!isConfluenceConfigured()) return { ok: false, error: 'не налаштовано' };
    const config = readConfluenceConfig();
    // Дешевий запит, що вимагає входу: простір «~» не існує, але 404 означає, що VPN і токен живі.
    try {
      await resolveConfluenceRef({ kind: 'title', spaceKey: '~jules-health', title: 'health' }, { fetch: fetchImpl });
      return { ok: true, details: { baseUrl: config.baseUrl, flavor: config.flavor } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/не знайдено/i.test(message)) return { ok: true, details: { baseUrl: config.baseUrl, flavor: config.flavor } };
      return { ok: false, error: message, details: { baseUrl: config.baseUrl } };
    }
  }
  if (target === 'jira') {
    if (!isJiraConfigured()) return { ok: false, error: 'не налаштовано' };
    try {
      const info = await createJiraClientFromEnv({ fetch: fetchImpl }).serverInfo();
      return { ok: true, details: { version: info.version, baseUrl: info.baseUrl } };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (!isFigmaConfigured()) return { ok: false, error: 'не налаштовано' };
  try {
    const response = await (fetchImpl ?? fetch)('https://api.figma.com/v1/me', {
      headers: { 'X-Figma-Token': process.env.FIGMA_TOKEN ?? '' },
      signal: AbortSignal.timeout(15_000),
    });
    return response.ok ? { ok: true } : { ok: false, error: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Перевіряє налаштовані системи; ненастроєні лише позначає, без сповіщень. */
export async function runHealthChecks(fetchImpl?: typeof fetch): Promise<HealthCheck[]> {
  const results: HealthCheck[] = [];
  for (const target of HEALTH_TARGETS) {
    const configured =
      target === 'confluence' ? isConfluenceConfigured() : target === 'jira' ? isJiraConfigured() : isFigmaConfigured();
    if (!configured) {
      execute('DELETE FROM health_checks WHERE target = ?', [target]);
      continue;
    }
    const result = await probe(target, fetchImpl);
    results.push(recordHealth(target, result.ok, result.error, result.details));
  }
  return results;
}

export function integrationsConfigured(): Record<string, boolean> {
  return {
    confluence: isConfluenceConfigured(),
    jira: isJiraConfigured(),
    figma: isFigmaConfigured(),
    telegram: isTelegramConfigured(),
  };
}
