/**
 * Асинхронні дані: один спосіб завантаження на весь застосунок.
 *
 *   useAsync   — одноразове завантаження з `AbortController` і `reload()`.
 *   usePolling — ЄДИНИЙ таймер опитування: зупиняється, коли вкладка неактивна
 *                (`document.hidden`), скасовує запит при розмонтуванні й
 *                не накладає виклики один на одного.
 *   useResource — useAsync + необов'язкове тихе оновлення через usePolling.
 *
 * Правило проєкту: логи прогону приходять ЛИШЕ через SSE, списки — ЛИШЕ через
 * опитування. Жодних гонок між ними.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, isAbort } from '../api';
import { S } from '../strings';

export interface AsyncState<T> {
  data: T | undefined;
  error: string | null;
  /** Перше завантаження: показуємо скелетон, а не «немає даних». */
  loading: boolean;
  /** Оновлення поверх наявних даних: показуємо ненав'язливий індикатор. */
  refreshing: boolean;
  status: number | null;
  reload: () => void;
  setData: (next: T | undefined) => void;
}

export function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message || S.errors.generic;
  return S.errors.generic;
}

function statusOf(error: unknown): number | null {
  return error instanceof ApiError ? error.status : null;
}

/**
 * @param loader   отримує `AbortSignal`; має віддати дані
 * @param deps     як у `useEffect`: зміна перезавантажує
 * @param enabled  `false` — не завантажувати (немає ще projectId тощо)
 */
export function useAsync<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  enabled = true,
): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [nonce, setNonce] = useState(0);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const hasData = useRef(false);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let alive = true;

    if (hasData.current) setRefreshing(true);
    else setLoading(true);

    loaderRef
      .current(controller.signal)
      .then((result) => {
        if (!alive) return;
        hasData.current = true;
        setData(result);
        setError(null);
        setStatus(null);
      })
      .catch((cause: unknown) => {
        if (!alive || isAbort(cause)) return;
        setError(messageOf(cause));
        setStatus(statusOf(cause));
      })
      .finally(() => {
        if (!alive) return;
        setLoading(false);
        setRefreshing(false);
      });

    return () => {
      alive = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, error, loading, refreshing, status, reload, setData };
}

export interface PollingOptions {
  enabled?: boolean;
  /** Виконати одразу при монтуванні (за замовчуванням — ні: перший запит робить useAsync). */
  immediate?: boolean;
}

/**
 * Єдиний таймер опитування. Ніяких `setInterval` по компонентах.
 */
export function usePolling(
  fn: (signal: AbortSignal) => void | Promise<void>,
  ms: number,
  options: PollingOptions = {},
): void {
  const { enabled = true, immediate = false } = options;
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled || ms <= 0) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let running = false;

    const tick = async () => {
      if (stopped || running) return;
      // Вкладка неактивна — не тратимо запити й не грієм бекенд.
      if (typeof document !== 'undefined' && document.hidden) return;
      running = true;
      controller = new AbortController();
      try {
        await fnRef.current(controller.signal);
      } catch (error) {
        if (!isAbort(error)) {
          /* помилка опитування не має ламати екран: її покаже reload/useAsync */
        }
      } finally {
        running = false;
      }
    };

    const schedule = () => {
      timer = setTimeout(async () => {
        await tick();
        if (!stopped) schedule();
      }, ms);
    };

    const onVisibility = () => {
      if (typeof document === 'undefined') return;
      if (document.hidden) {
        controller?.abort();
        if (timer) clearTimeout(timer);
        timer = undefined;
      } else if (!timer && !stopped) {
        void tick();
        schedule();
      }
    };

    if (immediate) void tick();
    schedule();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [ms, enabled, immediate]);
}

/**
 * Дані + тихе періодичне оновлення. `pollMs = 0` — без опитування.
 */
export function useResource<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  options: { enabled?: boolean; pollMs?: number } = {},
): AsyncState<T> {
  const { enabled = true, pollMs = 0 } = options;
  const state = useAsync(loader, deps, enabled);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const setDataRef = useRef(state.setData);
  setDataRef.current = state.setData;

  usePolling(
    async (signal) => {
      const result = await loaderRef.current(signal);
      setDataRef.current(result);
    },
    pollMs,
    { enabled: enabled && pollMs > 0 && !state.loading && !state.error },
  );

  return state;
}
