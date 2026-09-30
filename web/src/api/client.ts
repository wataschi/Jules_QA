/**
 * Єдиний типізований клієнт API.
 *
 * Усе, що ходить по HTTP, іде через `request()`:
 *   - `AbortController` на кожен запит (хуки скасовують при розмонтуванні);
 *   - помилки HTTP → людські повідомлення українською (`ApiError.message`);
 *   - заголовок `X-Jules-User` і `Authorization: Bearer …` з localStorage.
 *
 * Маршрути — строго за `docs/registry-api.md`. Префікс реєстру — `/api/registry`.
 * Старі ендпоінти рушія (`/api/runs/:id`, `/api/settings`, `/api/scenarios`,
 * `/api/llm/check`) лишаються під `legacy*`.
 */

import { S } from '../strings';
import type {
  ApproveResult,
  AutomationStatus,
  BulkRequest,
  BulkResult,
  Case,
  CaseDetail,
  CaseFilter,
  CaseInput,
  CaseKind,
  CaseListItem,
  CasePriority,
  CaseStatus,
  CoverageResponse,
  DashboardData,
  Defect,
  FormatExportResult,
  LegacyRun,
  LegacyScenarioMeta,
  LegacySettings,
  LlmCheck,
  Page,
  Project,
  Proposal,
  ProposalKind,
  ProposalState,
  RegistryRun,
  RejectResult,
  Revision,
  RunCreateInput,
  RunDetail,
  RunItem,
  RunItemInput,
  RunKind,
  RunState,
  SectionInput,
  SectionNode,
  Selection,
  SkillRun,
  Source,
  SourceDetail,
  SourceImportResult,
  SourceKind,
  SourceRefreshResult,
  TestrailDriftRow,
  IntegrationsHealth,
  TestrailMapping,
  ValidateCoverageResult,
  WriteCasesResult,
} from '../types';

export const REGISTRY_BASE = '/api/registry';

/* ───────────────────────── локальні налаштування ─────────────────────── */

const LS_TOKEN = 'julesApiToken';
const LS_USER = 'julesUser';

/** localStorage може бути недоступний (приватний режим, заблоковані cookies). */
function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function lsSet(key: string, value: string | null): void {
  try {
    if (value === null || value === '') localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* нічого не робимо: налаштування просто не переживе перезавантаження */
  }
}

export function getApiToken(): string {
  return lsGet(LS_TOKEN) ?? '';
}
export function setApiToken(token: string): void {
  lsSet(LS_TOKEN, token.trim() || null);
}
export function getUserName(): string {
  return lsGet(LS_USER) ?? '';
}
export function setUserName(name: string): void {
  lsSet(LS_USER, name.trim() || null);
}

/** Токен у query — для SSE і посилань на файли (EventSource не вміє заголовків). */
export function withToken(url: string): string {
  const token = getApiToken();
  if (!token) return url;
  return url + (url.includes('?') ? '&' : '?') + `token=${encodeURIComponent(token)}`;
}

/* ─────────────────────────────── помилки ─────────────────────────────── */

export class ApiError extends Error {
  readonly status: number;
  readonly details?: unknown;
  readonly url: string;

  constructor(message: string, status: number, url: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.url = url;
    this.details = details;
  }

  /** Ендпоінт ще не реалізований на бекенді — окремий випадок для UI. */
  get isMissingEndpoint(): boolean {
    return this.status === 404;
  }
}

export function isAbort(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function humanMessage(status: number, serverError?: string): string {
  if (serverError && serverError.trim()) return serverError.trim();
  if (status === 400) return S.errors.badRequest;
  if (status === 401 || status === 403) return S.errors.unauthorized;
  if (status === 404) return S.errors.notFound;
  if (status === 409) return S.errors.conflict;
  if (status === 502) return S.errors.upstream;
  if (status >= 500) return S.errors.server;
  if (status === 0) return S.errors.network;
  return S.errors.generic;
}

/* ───────────────────────────── базовий запит ─────────────────────────── */

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Для завантаження файлів експорту — не парсимо JSON. */
  raw?: boolean;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal } = options;
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const token = getApiToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const user = getUserName();
  if (user) headers['X-Jules-User'] = user;

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new ApiError(S.errors.network, 0, path, error);
  }

  if (!response.ok) {
    let serverError: string | undefined;
    let details: unknown;
    try {
      const parsed = (await response.json()) as { error?: string; details?: unknown };
      serverError = parsed?.error;
      details = parsed?.details;
    } catch {
      /* тіло не JSON — лишаємо стандартне повідомлення */
    }
    throw new ApiError(humanMessage(response.status, serverError), response.status, path, details);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(S.errors.parse, response.status, path);
  }
}

/* ──────────────────────────── query-хелпери ──────────────────────────── */

export type QueryValue = string | number | boolean | undefined | null | string[];

export function qs(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item) search.append(key, item);
      continue;
    }
    if (typeof value === 'boolean') {
      if (value) search.set(key, '1');
      continue;
    }
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/* ─────────────────────── параметри списку кейсів ─────────────────────── */

export interface CaseQuery {
  projectId: string;
  sectionId?: string;
  includeSubsections?: boolean;
  tag?: string[];
  kind?: CaseKind;
  priority?: CasePriority;
  status?: CaseStatus;
  automation?: AutomationStatus;
  q?: string;
  sort?: string;
  page?: number;
  limit?: number;
}

export interface ProposalQuery {
  projectId: string;
  state?: ProposalState;
  kind?: ProposalKind;
  sourceId?: string;
  page?: number;
  limit?: number;
}

export interface RunQuery {
  projectId: string;
  kind?: RunKind;
  state?: RunState;
  page?: number;
  limit?: number;
}

/* ───────────────────────────── клієнт API ────────────────────────────── */

export interface JulesApi {
  /* проєкти */
  listProjects(signal?: AbortSignal): Promise<Project[]>;
  getProject(id: string, signal?: AbortSignal): Promise<Project>;
  patchProject(id: string, patch: Partial<Project>, signal?: AbortSignal): Promise<Project>;

  /* дашборд */
  getDashboard(projectId: string, signal?: AbortSignal): Promise<DashboardData>;

  /* секції */
  listSections(projectId: string, signal?: AbortSignal): Promise<SectionNode[]>;
  createSection(input: SectionInput, signal?: AbortSignal): Promise<SectionNode>;

  /* кейси */
  listCases(query: CaseQuery, signal?: AbortSignal): Promise<Page<CaseListItem>>;
  getCase(id: string, signal?: AbortSignal): Promise<CaseDetail>;
  patchCase(id: string, patch: Partial<CaseInput>, signal?: AbortSignal): Promise<Case>;
  getCaseHistory(
    id: string,
    signal?: AbortSignal,
  ): Promise<{ revisions: Revision[]; results: RunItem[] }>;
  setAutomation(
    id: string,
    input: { status: AutomationStatus; scenarioPath?: string; quarantineReason?: string },
    signal?: AbortSignal,
  ): Promise<Case>;
  bulk(input: BulkRequest, signal?: AbortSignal): Promise<BulkResult>;
  bulkUndo(batchId: string, signal?: AbortSignal): Promise<{ reverted: number }>;

  /* пропозиції */
  listProposals(query: ProposalQuery, signal?: AbortSignal): Promise<Page<Proposal>>;
  approveProposals(ids: string[], signal?: AbortSignal): Promise<ApproveResult>;
  rejectProposals(ids: string[], note?: string, signal?: AbortSignal): Promise<RejectResult>;
  patchProposal(id: string, patch: { payload?: unknown; note?: string }, signal?: AbortSignal): Promise<Proposal>;
  deleteProposal(id: string, signal?: AbortSignal): Promise<void>;

  /* джерела вимог і покриття */
  listSources(projectId: string, signal?: AbortSignal): Promise<Source[]>;
  getSource(id: string, signal?: AbortSignal): Promise<SourceDetail>;
  importSource(
    input: { projectId: string; kind: SourceKind; url?: string; text?: string; html?: string; title?: string },
    signal?: AbortSignal,
  ): Promise<SourceImportResult>;
  refreshSource(id: string, signal?: AbortSignal): Promise<SourceRefreshResult>;
  deleteSource(id: string, signal?: AbortSignal): Promise<void>;
  getCoverage(
    query: { projectId: string; sourceId?: string },
    signal?: AbortSignal,
  ): Promise<CoverageResponse>;
  linkCoverage(
    input: { blockId: string; caseId: string; kind: 'quote' | 'derived'; confirmed: boolean },
    signal?: AbortSignal,
  ): Promise<void>;
  unlinkCoverage(id: string, signal?: AbortSignal): Promise<void>;

  /* скіли */
  writeCases(
    input: {
      projectId: string;
      sectionId: string;
      blockIds?: string[];
      text?: string;
      style?: { maxPerBlock?: number; includeDerived?: boolean };
    },
    signal?: AbortSignal,
  ): Promise<WriteCasesResult>;
  validateCoverage(
    input: { projectId: string; sourceId?: string; blockIds?: string[]; sectionId?: string },
    signal?: AbortSignal,
  ): Promise<ValidateCoverageResult>;
  formatExport(
    input: {
      projectId: string;
      caseIds?: string[];
      filter?: CaseFilter;
      mappingId: string;
      target: 'csv' | 'xml' | 'api';
      dryRun?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<FormatExportResult>;
  listSkillRuns(
    query: { projectId: string; skill?: string; page?: number; limit?: number },
    signal?: AbortSignal,
  ): Promise<Page<SkillRun>>;

  /* вибірки */
  listSelections(projectId: string, signal?: AbortSignal): Promise<Selection[]>;

  /* прогони */
  listRuns(query: RunQuery, signal?: AbortSignal): Promise<Page<RegistryRun>>;
  createRun(input: RunCreateInput, signal?: AbortSignal): Promise<RegistryRun>;
  getRun(id: string, signal?: AbortSignal): Promise<RunDetail>;
  patchRun(
    id: string,
    patch: { state?: RunState; title?: string; note?: string },
    signal?: AbortSignal,
  ): Promise<RegistryRun>;
  setRunItem(runId: string, caseId: string, input: RunItemInput, signal?: AbortSignal): Promise<RunItem>;
  startAuto(runId: string, caseIds?: string[], signal?: AbortSignal): Promise<{ queued: number }>;
  rerunFailed(runId: string, signal?: AbortSignal): Promise<RegistryRun>;

  /* дефекти */
  listDefects(
    query: { projectId: string; status?: string; caseId?: string; page?: number; limit?: number },
    signal?: AbortSignal,
  ): Promise<Page<Defect>>;
  patchDefect(id: string, patch: Partial<Defect>, signal?: AbortSignal): Promise<Defect>;

  /* TestRail */
  listMappings(projectId: string, signal?: AbortSignal): Promise<TestrailMapping[]>;
  createMapping(input: Partial<TestrailMapping> & { projectId: string; name: string }, signal?: AbortSignal): Promise<TestrailMapping>;
  patchMapping(id: string, patch: Partial<TestrailMapping>, signal?: AbortSignal): Promise<TestrailMapping>;
  getDrift(projectId: string, signal?: AbortSignal): Promise<TestrailDriftRow[]>;
  exportUrl(target: 'csv' | 'xml', params: Record<string, QueryValue>): string;
  /** Стан моделей по ролях, Confluence і TestRail — для екрана налаштувань. */
  getIntegrationsHealth(signal?: AbortSignal): Promise<IntegrationsHealth>;

  /* старий світ рушія */
  legacyGetRun(id: string, signal?: AbortSignal): Promise<LegacyRun>;
  legacyStreamUrl(id: string): string;
  legacyListScenarios(signal?: AbortSignal): Promise<LegacyScenarioMeta[]>;
  legacyGetSettings(signal?: AbortSignal): Promise<LegacySettings>;
  legacySaveSettings(settings: LegacySettings, signal?: AbortSignal): Promise<LegacySettings>;
  legacyCheckLlm(signal?: AbortSignal): Promise<LlmCheck>;
}

const R = REGISTRY_BASE;

export const httpApi: JulesApi = {
  /* ── проєкти ── */
  listProjects: (signal) => request<Project[]>(`${R}/projects`, { signal }),
  getProject: (id, signal) => request<Project>(`${R}/projects/${encodeURIComponent(id)}`, { signal }),
  patchProject: (id, patch, signal) =>
    request<Project>(`${R}/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch, signal }),

  /* ── дашборд ── */
  getDashboard: (projectId, signal) =>
    request<DashboardData>(`${R}/dashboard${qs({ projectId })}`, { signal }),

  /* ── секції ── */
  listSections: (projectId, signal) =>
    request<SectionNode[]>(`${R}/sections${qs({ projectId })}`, { signal }),
  createSection: (input, signal) => request<SectionNode>(`${R}/sections`, { method: 'POST', body: input, signal }),

  /* ── кейси ── */
  listCases: (query, signal) =>
    request<Page<CaseListItem>>(
      `${R}/cases${qs({
        projectId: query.projectId,
        sectionId: query.sectionId,
        includeSubsections: query.includeSubsections,
        tag: query.tag,
        kind: query.kind,
        priority: query.priority,
        status: query.status,
        automation: query.automation,
        q: query.q,
        sort: query.sort,
        page: query.page,
        limit: query.limit,
      })}`,
      { signal },
    ),
  getCase: (id, signal) => request<CaseDetail>(`${R}/cases/${encodeURIComponent(id)}`, { signal }),
  patchCase: (id, patch, signal) =>
    request<Case>(`${R}/cases/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch, signal }),
  getCaseHistory: (id, signal) =>
    request<{ revisions: Revision[]; results: RunItem[] }>(
      `${R}/cases/${encodeURIComponent(id)}/history`,
      { signal },
    ),
  setAutomation: (id, input, signal) =>
    request<Case>(`${R}/cases/${encodeURIComponent(id)}/automation`, {
      method: 'POST',
      body: input,
      signal,
    }),
  bulk: (input, signal) => request<BulkResult>(`${R}/cases/bulk`, { method: 'POST', body: input, signal }),
  bulkUndo: (batchId, signal) =>
    request<{ reverted: number }>(`${R}/cases/bulk/undo`, { method: 'POST', body: { batchId }, signal }),

  /* ── пропозиції ── */
  listProposals: (query, signal) => request<Page<Proposal>>(`${R}/proposals${qs({ ...query })}`, { signal }),
  approveProposals: (ids, signal) =>
    request<ApproveResult>(`${R}/proposals/approve`, { method: 'POST', body: { ids }, signal }),
  rejectProposals: (ids, note, signal) =>
    request<RejectResult>(`${R}/proposals/reject`, { method: 'POST', body: { ids, note }, signal }),
  patchProposal: (id, patch, signal) =>
    request<Proposal>(`${R}/proposals/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch, signal }),
  deleteProposal: (id, signal) =>
    request<void>(`${R}/proposals/${encodeURIComponent(id)}`, { method: 'DELETE', signal }),

  /* ── джерела вимог і покриття ── */
  listSources: (projectId, signal) => request<Source[]>(`${R}/sources${qs({ projectId })}`, { signal }),
  getSource: (id, signal) => request<SourceDetail>(`${R}/sources/${encodeURIComponent(id)}`, { signal }),
  importSource: (input, signal) =>
    request<SourceImportResult>(`${R}/sources/import`, { method: 'POST', body: input, signal }),
  refreshSource: (id, signal) =>
    request<SourceRefreshResult>(`${R}/sources/${encodeURIComponent(id)}/refresh`, {
      method: 'POST',
      signal,
    }),
  deleteSource: (id, signal) =>
    request<void>(`${R}/sources/${encodeURIComponent(id)}`, { method: 'DELETE', signal }),
  getCoverage: (query, signal) => request<CoverageResponse>(`${R}/coverage${qs({ ...query })}`, { signal }),
  linkCoverage: (input, signal) => request<void>(`${R}/coverage`, { method: 'POST', body: input, signal }),
  unlinkCoverage: (id, signal) =>
    request<void>(`${R}/coverage/${encodeURIComponent(id)}`, { method: 'DELETE', signal }),

  /* ── скіли ── */
  writeCases: (input, signal) =>
    request<WriteCasesResult>(`${R}/skills/write-cases`, { method: 'POST', body: input, signal }),
  validateCoverage: (input, signal) =>
    request<ValidateCoverageResult>(`${R}/skills/validate-coverage`, {
      method: 'POST',
      body: input,
      signal,
    }),
  formatExport: (input, signal) =>
    request<FormatExportResult>(`${R}/skills/format-export`, { method: 'POST', body: input, signal }),
  listSkillRuns: (query, signal) => request<Page<SkillRun>>(`${R}/skills/runs${qs({ ...query })}`, { signal }),

  /* ── вибірки ── */
  listSelections: (projectId, signal) => request<Selection[]>(`${R}/selections${qs({ projectId })}`, { signal }),

  /* ── прогони ── */
  listRuns: (query, signal) => request<Page<RegistryRun>>(`${R}/runs${qs({ ...query })}`, { signal }),
  createRun: (input, signal) => request<RegistryRun>(`${R}/runs`, { method: 'POST', body: input, signal }),
  getRun: (id, signal) => request<RunDetail>(`${R}/runs/${encodeURIComponent(id)}`, { signal }),
  patchRun: (id, patch, signal) =>
    request<RegistryRun>(`${R}/runs/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch, signal }),
  setRunItem: (runId, caseId, input, signal) =>
    request<RunItem>(
      `${R}/runs/${encodeURIComponent(runId)}/items/${encodeURIComponent(caseId)}`,
      { method: 'PUT', body: input, signal },
    ),
  startAuto: (runId, caseIds, signal) =>
    request<{ queued: number }>(`${R}/runs/${encodeURIComponent(runId)}/auto`, {
      method: 'POST',
      body: caseIds ? { caseIds } : {},
      signal,
    }),
  rerunFailed: (runId, signal) =>
    request<RegistryRun>(`${R}/runs/${encodeURIComponent(runId)}/rerun-failed`, { method: 'POST', signal }),

  /* ── дефекти ── */
  listDefects: (query, signal) => request<Page<Defect>>(`${R}/defects${qs({ ...query })}`, { signal }),
  patchDefect: (id, patch, signal) =>
    request<Defect>(`${R}/defects/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch, signal }),

  /* ── TestRail ── */
  listMappings: (projectId, signal) =>
    request<TestrailMapping[]>(`${R}/testrail/mappings${qs({ projectId })}`, { signal }),
  createMapping: (input, signal) =>
    request<TestrailMapping>(`${R}/testrail/mappings`, { method: 'POST', body: input, signal }),
  patchMapping: (id, patch, signal) =>
    request<TestrailMapping>(`${R}/testrail/mappings/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: patch,
      signal,
    }),
  getDrift: (projectId, signal) =>
    request<TestrailDriftRow[]>(`${R}/testrail/drift${qs({ projectId })}`, { signal }),
  exportUrl: (target, params) => withToken(`${R}/export/testrail.${target}${qs(params)}`),
  getIntegrationsHealth: (signal) => request<IntegrationsHealth>(`${R}/integrations/health`, { signal }),

  /* ── старий світ рушія ── */
  legacyGetRun: (id, signal) => request<LegacyRun>(`/api/runs/${encodeURIComponent(id)}`, { signal }),
  legacyStreamUrl: (id) => withToken(`/api/runs/${encodeURIComponent(id)}/stream`),
  legacyListScenarios: (signal) => request<LegacyScenarioMeta[]>('/api/scenarios', { signal }),
  legacyGetSettings: (signal) => request<LegacySettings>('/api/settings', { signal }),
  legacySaveSettings: (settings, signal) =>
    request<LegacySettings>('/api/settings', { method: 'PUT', body: settings, signal }),
  legacyCheckLlm: (signal) => request<LlmCheck>('/api/llm/check', { signal }),
};
