/**
 * Точка входу для всього UI: `import { api } from '../api'`.
 *
 * За замовчуванням — справжній HTTP-клієнт. Якщо увімкнено режим фікстур
 * (`?mock=1` або `localStorage.julesMock='1'`) — підміняється на `mockApi`.
 * Вибір робиться один раз під час завантаження модуля, щоб у межах сесії
 * клієнт не змінювався під ногами.
 */

import { httpApi, type JulesApi } from './client';
import { mockApi, mockEnabled } from './mock';

export const isMock = mockEnabled();

export const api: JulesApi = isMock ? mockApi : httpApi;

export type { JulesApi, CaseQuery, ProposalQuery, RunQuery } from './client';
export {
  ApiError,
  isAbort,
  getApiToken,
  setApiToken,
  getUserName,
  setUserName,
  withToken,
  qs,
  REGISTRY_BASE,
} from './client';
