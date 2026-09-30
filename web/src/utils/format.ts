/** Форматування для показу: дати, відсотки, тривалість, числа. */

import { S } from '../strings';

const LOCALE = 'uk-UA';

export function formatDateTime(iso?: string): string {
  if (!iso) return S.common.none;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return S.common.none;
  return date.toLocaleString(LOCALE, {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDate(iso?: string): string {
  if (!iso) return S.common.none;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return S.common.none;
  return date.toLocaleDateString(LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** «3 хв тому», «2 год тому» — для стовпця «Оновлено». */
export function formatAgo(iso?: string): string {
  if (!iso) return S.common.none;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return S.common.none;
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'щойно';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} хв тому`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} год тому`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days} дн тому`;
  return formatDate(iso);
}

export function formatPercent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return S.common.none;
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatDuration(ms?: number): string {
  if (ms === undefined || ms === null) return S.common.none;
  if (ms < 1000) return `${ms} мс`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} с`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} хв ${Math.round(seconds % 60)} с`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return S.common.none;
  return value.toLocaleString(LOCALE);
}

export function formatTokens(prompt?: number, completion?: number): string {
  if (prompt === undefined && completion === undefined) return S.common.none;
  return `${formatNumber(prompt ?? 0)} + ${formatNumber(completion ?? 0)}`;
}

/** Показ довільного значення з diff-у: масиви — по рядках, об'єкти — JSON. */
export function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => `• ${stringifyValue(item)}`).join('\n');
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function linesToArray(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function parseTags(text: string): string[] {
  return text
    .split(/[,\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/** Частка нестабільності → тон чипа. */
export function flakeTone(score: number): 'good' | 'warn' | 'bad' {
  if (score >= 0.3) return 'bad';
  if (score >= 0.1) return 'warn';
  return 'good';
}

export function passRateTone(rate: number | null): 'good' | 'warn' | 'bad' | undefined {
  if (rate === null) return undefined;
  if (rate >= 0.9) return 'good';
  if (rate >= 0.7) return 'warn';
  return 'bad';
}
