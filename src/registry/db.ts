/**
 * Підключення до SQLite-бази реєстру через вбудований `node:sqlite`.
 *
 * Жодних зовнішніх залежностей: `DatabaseSync` є в Node 22+ (за прапорцем
 * `--experimental-sqlite`) і в Node 24 без прапорця. З'єднання — синглтон,
 * прив'язаний до шляху з `data-paths.ts`; якщо шлях змінився (тести з
 * `REGISTRY_DB=<tmp>`), старе з'єднання закривається й відкривається нове.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync, StatementResultingChanges } from 'node:sqlite';
import { getRegistryDbPath } from '../server/data-paths.js';
import { migrate } from './migrations.js';

/** Те, що SQLite приймає як параметр запиту. */
export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, unknown>;

const nodeRequire = createRequire(import.meta.url);

interface SqliteModule {
  DatabaseSync: new (filePath: string, options?: { open?: boolean }) => DatabaseSync;
}

const NO_SQLITE =
  'Реєстр потребує Node 22+ (--experimental-sqlite) або Node 24: модуль «node:sqlite» недоступний у цьому середовищі.';

function loadSqlite(): SqliteModule {
  try {
    const mod = nodeRequire('node:sqlite') as Partial<SqliteModule>;
    if (typeof mod?.DatabaseSync !== 'function') throw new Error('DatabaseSync відсутній');
    return mod as SqliteModule;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${NO_SQLITE} (${reason})`);
  }
}

interface Handle {
  db: DatabaseSync;
  file: string;
}

let handle: Handle | null = null;
let txDepth = 0;

/**
 * Відкриває (або повертає вже відкрите) з'єднання й проганяє міграції.
 * Ідемпотентно: повторний виклик не робить нічого зайвого.
 */
export function getDb(): DatabaseSync {
  const file = path.resolve(getRegistryDbPath());
  if (handle && handle.file === file) return handle.db;
  if (handle) closeDb();

  const { DatabaseSync: Ctor } = loadSqlite();
  if (!file.endsWith(':memory:')) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Ctor(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  handle = { db, file };
  try {
    migrate(db);
  } catch (error) {
    closeDb();
    throw error;
  }
  return db;
}

/** Закриває з'єднання (тести, завершення процесу). */
export function closeDb(): void {
  if (!handle) return;
  try {
    handle.db.close();
  } catch {
    /* вже закрите */
  }
  handle = null;
  txDepth = 0;
}

/** Явний прогін міграцій — для `scripts/registry-migrate.ts` і старту сервера. */
export function ensureMigrated(): void {
  getDb();
}

function normalizeParams(params: readonly unknown[]): SqlValue[] {
  return params.map((value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') return value;
    if (value instanceof Uint8Array) return value;
    return JSON.stringify(value);
  });
}

export function query<T = Row>(sql: string, params: readonly unknown[] = []): T[] {
  const stmt = getDb().prepare(sql);
  return stmt.all(...normalizeParams(params)) as unknown as T[];
}

export function queryOne<T = Row>(sql: string, params: readonly unknown[] = []): T | undefined {
  const stmt = getDb().prepare(sql);
  return stmt.get(...normalizeParams(params)) as unknown as T | undefined;
}

export function execute(sql: string, params: readonly unknown[] = []): StatementResultingChanges {
  const stmt = getDb().prepare(sql);
  return stmt.run(...normalizeParams(params));
}

/** Скалярне значення першої колонки першого рядка. */
export function scalar<T = unknown>(sql: string, params: readonly unknown[] = []): T | undefined {
  const row = queryOne<Row>(sql, params);
  if (!row) return undefined;
  const first = Object.values(row)[0];
  return first as T;
}

/**
 * Транзакція. Вкладені виклики використовують SAVEPOINT, тому сховища можна
 * вільно комбінувати (наприклад bulk усередині апруву пропозиції).
 */
export function tx<T>(fn: () => T): T {
  const db = getDb();
  const savepoint = `sp_${txDepth}`;
  const nested = txDepth > 0;
  db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  txDepth += 1;
  try {
    const result = fn();
    txDepth -= 1;
    db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
    return result;
  } catch (error) {
    txDepth -= 1;
    try {
      db.exec(nested ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK');
      if (nested) db.exec(`RELEASE ${savepoint}`);
    } catch {
      /* транзакція вже відкотилася */
    }
    throw error;
  }
}

/** Розпакувати TEXT-колонку з JSON. Порожнє/зламане значення → `fallback`. */
export function fromJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    const parsed = JSON.parse(value) as T;
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/** Запакувати значення в TEXT-колонку JSON. */
export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** `?, ?, ?` для `IN (...)`. */
export function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}
