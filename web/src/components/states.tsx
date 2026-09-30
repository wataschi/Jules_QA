/**
 * Один набір станів на весь застосунок.
 *
 *   <Loading/>    — скелетон. Під час ПЕРШОГО завантаження показуємо його,
 *                   а не «немає даних».
 *   <Empty/>      — порожньо + підказка, що робити далі.
 *   <ErrorState/> — помилка + кнопка «Спробувати ще».
 *
 * Бекенд `/api/registry/**` може бути ще не готовий: тоді 404 показуємо
 * окремою підказкою, а не як «щось зламалося».
 */

import type { ReactNode } from 'react';
import { S } from '../strings';

export function Loading({ rows = 4, label = S.common.loading }: { rows?: number; label?: string }) {
  return (
    <div className="skeleton-stack" role="status" aria-live="polite" aria-busy="true">
      <span className="visually-hidden">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <span
          key={i}
          className="skeleton"
          style={{ width: `${[100, 82, 91, 68, 76, 88][i % 6]}%`, height: i === 0 ? 16 : 12 }}
        />
      ))}
    </div>
  );
}

export function Empty({
  title,
  hint,
  action,
  glyph = '○',
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  glyph?: string;
}) {
  return (
    <div className="state">
      <span className="state-glyph" aria-hidden="true">
        {glyph}
      </span>
      <p className="state-title">{title}</p>
      {hint && <p className="state-hint">{hint}</p>}
      {action}
    </div>
  );
}

export function ErrorState({
  message,
  status,
  onRetry,
  compact = false,
}: {
  message: string;
  status?: number | null;
  onRetry?: () => void;
  compact?: boolean;
}) {
  const missing = status === 404;
  return (
    <div className={`state bad${compact ? ' compact' : ''}`} role="alert">
      <span className="state-glyph" aria-hidden="true">
        ⚠
      </span>
      <p className="state-title">{S.errors.title}</p>
      <p className="state-hint">{message}</p>
      {missing && <p className="state-hint">{S.errors.notFound}</p>}
      {onRetry && (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          {S.common.retry}
        </button>
      )}
    </div>
  );
}

/**
 * Обгортка «завантаження / помилка / порожньо / дані» — щоб у сторінках не
 * дублювалися три однакові `if`.
 */
export function Async<T>({
  state,
  empty,
  children,
  skeletonRows,
}: {
  state: {
    data: T | undefined;
    loading: boolean;
    error: string | null;
    status?: number | null;
    reload: () => void;
  };
  empty?: { title: string; hint?: string; action?: ReactNode } | null;
  children: (data: T) => ReactNode;
  skeletonRows?: number;
}) {
  if (state.loading && state.data === undefined) return <Loading rows={skeletonRows} />;
  if (state.error && state.data === undefined) {
    return <ErrorState message={state.error} status={state.status} onRetry={state.reload} />;
  }
  if (state.data === undefined) return <Loading rows={skeletonRows} />;

  const list = state.data as unknown;
  const isEmptyArray = Array.isArray(list) && list.length === 0;
  const isEmptyPage =
    !!list &&
    typeof list === 'object' &&
    'items' in (list as Record<string, unknown>) &&
    Array.isArray((list as { items: unknown[] }).items) &&
    (list as { items: unknown[] }).items.length === 0;

  if (empty && (isEmptyArray || isEmptyPage)) {
    return <Empty title={empty.title} hint={empty.hint} action={empty.action} />;
  }
  return <>{children(state.data)}</>;
}
