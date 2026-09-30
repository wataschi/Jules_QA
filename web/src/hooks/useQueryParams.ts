/**
 * Фільтри й сортування живуть в адресі сторінки — щоб посилання можна було
 * переслати колезі й воно відкрило рівно той самий вид.
 */

import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

export type ParamPatch = Record<string, string | number | boolean | string[] | null | undefined>;

export interface QueryParams {
  get(key: string): string;
  getOr(key: string, fallback: string): string;
  getNum(key: string, fallback: number): number;
  getBool(key: string, fallback?: boolean): boolean;
  getList(key: string): string[];
  has(key: string): boolean;
  /** Оновити параметри; `null` прибирає ключ. `replace` — без запису в історію. */
  set(patch: ParamPatch, replace?: boolean): void;
  clear(keys: string[]): void;
  raw: URLSearchParams;
}

export function useQueryParams(): QueryParams {
  const [search, setSearch] = useSearchParams();

  const set = useCallback(
    (patch: ParamPatch, replace = false) => {
      const next = new URLSearchParams(search);
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === undefined || value === '' || value === false) {
          next.delete(key);
          continue;
        }
        if (Array.isArray(value)) {
          next.delete(key);
          for (const item of value) if (item) next.append(key, item);
          continue;
        }
        next.set(key, value === true ? '1' : String(value));
      }
      setSearch(next, { replace });
    },
    [search, setSearch],
  );

  const clear = useCallback(
    (keys: string[]) => {
      const next = new URLSearchParams(search);
      for (const key of keys) next.delete(key);
      setSearch(next, { replace: true });
    },
    [search, setSearch],
  );

  return useMemo<QueryParams>(
    () => ({
      get: (key) => search.get(key) ?? '',
      getOr: (key, fallback) => search.get(key) || fallback,
      getNum: (key, fallback) => {
        const raw = Number(search.get(key));
        return Number.isFinite(raw) && raw > 0 ? raw : fallback;
      },
      getBool: (key, fallback = false) => {
        const raw = search.get(key);
        if (raw === null) return fallback;
        return raw === '1' || raw === 'true';
      },
      getList: (key) => search.getAll(key).filter(Boolean),
      has: (key) => search.has(key),
      set,
      clear,
      raw: search,
    }),
    [search, set, clear],
  );
}
