/**
 * Черга сповіщень із дедуплікацією. Подія потрапляє сюди один раз за ключем
 * (`eventDedupKey`), а фонова задача відправляє ненадіслані в Telegram.
 */
import { execute, fromJson, nowIso, query, toJson, type Row } from './db.js';
import { newId } from './ids.js';
import { eventDedupKey, type NotifyEvent } from '../notify/telegram.js';

export interface QueuedNotification {
  id: string;
  projectId?: string;
  kind: NotifyEvent['kind'];
  dedupKey: string;
  event: NotifyEvent;
  createdAt: string;
  sentAt?: string;
  error?: string;
  /** Скільки разів відправка не вдалася. */
  attempts: number;
  /** Не раніше якого часу пробувати знову (пауза після невдачі). */
  nextTryAt?: string;
  /** Чому сповіщення закрито без відправки: `disabled` — вимкнено для проєкту, `failed` — вичерпано спроби. */
  skippedReason?: NotificationSkipReason;
}

export type NotificationSkipReason = 'disabled' | 'failed';

/** Після стількох невдалих спроб сповіщення закривається як `failed`. */
export const MAX_NOTIFICATION_ATTEMPTS = 8;
const MAX_BACKOFF_MINUTES = 60;

function rowToNotification(row: Row): QueuedNotification {
  return {
    id: String(row.id),
    projectId: (row.project_id as string | null) ?? undefined,
    kind: row.kind as NotifyEvent['kind'],
    dedupKey: String(row.dedup_key),
    event: fromJson<NotifyEvent>(row.payload, { kind: 'source_up', source: '', downMinutes: 0 }),
    createdAt: String(row.created_at),
    sentAt: (row.sent_at as string | null) ?? undefined,
    error: (row.error as string | null) ?? undefined,
    attempts: Number(row.attempts ?? 0),
    nextTryAt: (row.next_try_at as string | null) ?? undefined,
    skippedReason: (row.skipped_reason as NotificationSkipReason | null) ?? undefined,
  };
}

/** Ставить подію в чергу. `false` — така подія вже була. */
export function enqueueNotification(event: NotifyEvent, projectId?: string): boolean {
  const key = eventDedupKey(event);
  const result = execute(
    `INSERT OR IGNORE INTO notifications (id, project_id, kind, dedup_key, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [newId('ntf'), projectId ?? null, event.kind, key, toJson(event), nowIso()],
  );
  return Number(result.changes) > 0;
}

/** Ненадіслані, у яких минула пауза після невдачі, — найстаріші першими. */
export function pendingNotifications(limit = 20, now = new Date()): QueuedNotification[] {
  return query<Row>(
    `SELECT * FROM notifications WHERE sent_at IS NULL AND (next_try_at IS NULL OR next_try_at <= ?)
     ORDER BY created_at LIMIT ?`,
    [now.toISOString(), limit],
  ).map(rowToNotification);
}

export function markNotification(id: string, outcome: { sent: boolean; error?: string }): void {
  execute('UPDATE notifications SET sent_at = ?, error = ? WHERE id = ?', [outcome.sent ? nowIso() : null, outcome.error ?? null, id]);
}

/** Закриває сповіщення без відправки (лишається в журналі з причиною). */
export function skipNotification(id: string, reason: NotificationSkipReason, error?: string): void {
  execute('UPDATE notifications SET sent_at = ?, skipped_reason = ?, error = ?, next_try_at = NULL WHERE id = ?', [
    nowIso(),
    reason,
    error ?? null,
    id,
  ]);
}

/**
 * Невдала відправка: наступна спроба через 1, 2, 4… хвилин (не більше години),
 * після `MAX_NOTIFICATION_ATTEMPTS` спроб — закриваємо як `failed`.
 */
export function failNotification(id: string, error: string, now = new Date()): void {
  const row = query<Row>('SELECT attempts FROM notifications WHERE id = ?', [id])[0];
  const attempts = Number(row?.attempts ?? 0) + 1;
  if (attempts >= MAX_NOTIFICATION_ATTEMPTS) {
    execute('UPDATE notifications SET attempts = ?, error = ?, sent_at = ?, skipped_reason = ?, next_try_at = NULL WHERE id = ?', [
      attempts,
      error,
      now.toISOString(),
      'failed',
      id,
    ]);
    return;
  }
  const delayMinutes = Math.min(2 ** (attempts - 1), MAX_BACKOFF_MINUTES);
  execute('UPDATE notifications SET attempts = ?, error = ?, next_try_at = ? WHERE id = ?', [
    attempts,
    error,
    new Date(now.getTime() + delayMinutes * 60_000).toISOString(),
    id,
  ]);
}

export function recentNotifications(limit = 50): QueuedNotification[] {
  return query<Row>('SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?', [limit]).map(rowToNotification);
}
