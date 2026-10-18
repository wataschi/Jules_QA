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
}

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

export function pendingNotifications(limit = 20): QueuedNotification[] {
  return query<Row>('SELECT * FROM notifications WHERE sent_at IS NULL ORDER BY created_at LIMIT ?', [limit]).map(rowToNotification);
}

export function markNotification(id: string, outcome: { sent: boolean; error?: string }): void {
  execute('UPDATE notifications SET sent_at = ?, error = ? WHERE id = ?', [outcome.sent ? nowIso() : null, outcome.error ?? null, id]);
}

export function recentNotifications(limit = 50): QueuedNotification[] {
  return query<Row>('SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?', [limit]).map(rowToNotification);
}
