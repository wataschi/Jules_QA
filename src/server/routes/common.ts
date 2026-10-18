/**
 * Спільні помічники маршрутів реєстру: розбір параметрів, відповіді з помилками,
 * динамічне завантаження модулів за контрактом і перетворення даних для скілів.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Request, type Response } from 'express';
import { z } from 'zod';
import { HttpError } from '../auth.js';
import { type CaseFilter, type CaseKind, type CasePriority, type CaseStatus, type AutomationStatus, type TestrailMapping } from '../../registry/types.js';
import { sectionPathMap } from '../../registry/sections-store.js';
import { listAllCases, resolveCaseIds } from '../../registry/cases-store.js';
import { getBlocksByIds, type RawBlockInput } from '../../registry/sources-store.js';
import { listCoverageForCase } from '../../registry/coverage-store.js';

/* ──────────────── контракти чужих модулів (docs/module-contracts.md) ────── */

export interface SkillUsage {
  promptTokens?: number;
  completionTokens?: number;
  model?: string;
  durationMs: number;
}

export interface DraftCase {
  blockId: string;
  coverageKind: 'quote' | 'derived';
  rationale: string;
  case: {
    title: string;
    kind: CaseKind;
    priority: CasePriority;
    preconditions: string;
    checks: string[];
    tags: string[];
  };
}

export interface WriteCasesModule {
  writeCases: (input: {
    blocks: Array<{ id: string; heading: string; text: string }>;
    sectionPath: string;
    projectName: string;
    style?: {
      maxPerBlock?: number;
      includeDerived?: boolean;
      examples?: Array<{ title: string; checks: string[] }>;
      language?: string;
    };
  }) => Promise<{ drafts: DraftCase[]; usage: SkillUsage; warnings: string[] }>;
}

export interface ValidateCoverageModule {
  validateCoverage: (input: {
    blocks: Array<{ id: string; heading: string; text: string }>;
    cases: Array<{ id: string; title: string; checks: string[]; kind: CaseKind }>;
    sectionPath: string;
  }) => Promise<{
    report: {
      gaps: Array<{ blockId: string; fragment: string; suggestion: DraftCase['case'] }>;
      duplicates: Array<{ caseIds: string[]; reason: string }>;
      untestable: Array<{ caseId: string; reason: string }>;
      contradictions: Array<{ caseId: string; blockId: string; reason: string }>;
    };
    usage: SkillUsage;
    warnings: string[];
  }>;
}

export interface ExportCase {
  id: string;
  title: string;
  sectionPath: string;
  kind: CaseKind;
  priority: CasePriority;
  preconditions: string;
  checks: string[];
  steps: Array<{ action: string; expected: string }>;
  tags: string[];
  refs: string[];
  testrailCaseId?: number;
}

export interface ConfluenceModule {
  fetchConfluencePage: (ref: { url?: string; pageId?: string }) => Promise<{
    externalId: string;
    title: string;
    version: string;
    html: string;
    url: string;
  }>;
  isConfluenceConfigured: () => boolean;
  splitIntoBlocks: (
    content: string,
    opts?: { format?: 'html' | 'text' | 'markdown'; maxChars?: number },
  ) => RawBlockInput[];
  hashBlock: (text: string) => string;
}

export interface TestrailCsvModule {
  buildTestrailCsv: (cases: ExportCase[], mapping: TestrailMapping) => string;
}

export interface TestrailXmlModule {
  buildTestrailXml: (cases: ExportCase[], mapping: TestrailMapping) => string;
}

export interface TestrailApiModule {
  TestrailClient: new (opts: { baseUrl: string; user: string; apiKey: string }) => {
    getSections: (projectId: number, suiteId?: number) => Promise<Array<{ id: number; name: string; parent_id: number | null }>>;
    addSection: (projectId: number, name: string, parentId?: number, suiteId?: number) => Promise<{ id: number }>;
    getCases: (projectId: number, suiteId?: number, sectionId?: number) => Promise<Array<Record<string, unknown>>>;
    addCase: (sectionId: number, payload: Record<string, unknown>) => Promise<{ id: number }>;
    updateCase: (caseId: number, payload: Record<string, unknown>) => Promise<void>;
    updateCases: (suiteId: number, caseIds: number[], payload: Record<string, unknown>) => Promise<void>;
    getRuns: (projectId: number) => Promise<Array<Record<string, unknown>>>;
    getResultsForRun: (runId: number) => Promise<Array<Record<string, unknown>>>;
  };
  isTestrailConfigured: () => boolean;
}

/**
 * Динамічне завантаження модуля за контрактом. Специфікатор — не літерал,
 * тому TypeScript не вимагає наявності файлу на момент компіляції: ці модули
 * пише інший агент, а маршрут уже готовий їх викликати.
 *
 * Наявність файлу перевіряється до `import()`: у dev працює `.ts` (tsx/vitest),
 * у зібраному вигляді — `.js` із `dist`.
 */
export const ROUTES_DIR = path.dirname(fileURLToPath(import.meta.url));

export function moduleExists(specifier: string): boolean {
  const asJs = path.resolve(ROUTES_DIR, specifier);
  const asTs = asJs.replace(/\.js$/, '.ts');
  return fs.existsSync(asJs) || fs.existsSync(asTs);
}

export async function loadModule<T>(specifier: string, human: string): Promise<T> {
  if (!moduleExists(specifier)) {
    throw new ModuleUnavailable(`Модуль ${human} ще не підключено`);
  }
  try {
    return (await import(specifier)) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ModuleUnavailable(`Модуль ${human} не завантажився: ${reason}`);
  }
}

export class ModuleUnavailable extends Error {}

export const SKILLS = {
  writeCases: '../../registry/skills/write-cases.js',
  validateCoverage: '../../registry/skills/validate-coverage.js',
};
export const INTEGRATIONS = {
  confluence: '../../integrations/confluence.js',
  testrailCsv: '../../integrations/testrail-csv.js',
  testrailXml: '../../integrations/testrail-xml.js',
  testrailApi: '../../integrations/testrail-api.js',
};

/* ─────────────────────────── службові помічники ───────────────────────── */

export function fail(res: Response, error: unknown, fallbackStatus = 400): void {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: 'Невалідне тіло запиту', details: error.issues });
    return;
  }
  if (error instanceof ModuleUnavailable) {
    res.status(501).json({ error: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : 'Невідома помилка';
  let status = fallbackStatus;
  if (/не знайдено/i.test(message)) status = 404;
  else if (/(вже|уже) (існує|використано|в стані)|містить кейси|дочірні секції|не входить/i.test(message))
    status = 409;
  res.status(status).json({ error: message });
}

export function asArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter(Boolean);
}

export function asBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value).toLowerCase();
  return text === '1' || text === 'true' || text === 'yes';
}

export function asInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function requireProjectId(req: Request): string {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  if (!projectId) throw new Error('Параметр projectId обовʼязковий');
  return projectId;
}

/** Фільтр кейсів із query-параметрів. */
export function filterFromQuery(req: Request): Partial<CaseFilter> {
  const sectionIds = asArray(req.query.sectionId ?? req.query.sectionIds);
  return {
    sectionIds: sectionIds.length > 0 ? sectionIds : undefined,
    includeSubsections: asBool(req.query.includeSubsections, true),
    tags: asArray(req.query.tag ?? req.query.tags).length > 0 ? asArray(req.query.tag ?? req.query.tags) : undefined,
    kinds: asArray(req.query.kind).length > 0 ? (asArray(req.query.kind) as CaseKind[]) : undefined,
    priorities: asArray(req.query.priority).length > 0 ? (asArray(req.query.priority) as CasePriority[]) : undefined,
    statuses: asArray(req.query.status).length > 0 ? (asArray(req.query.status) as CaseStatus[]) : undefined,
    automation:
      asArray(req.query.automation).length > 0 ? (asArray(req.query.automation) as AutomationStatus[]) : undefined,
    q: typeof req.query.q === 'string' && req.query.q ? req.query.q : undefined,
  };
}

/**
 * Додає до пропозиції сам текст блоку вимоги.
 * Без нього в черзі апрувів неможливо відрізнити цитату вимоги від домислу AI,
 * а це головне правило перевірки згенерованих кейсів.
 */
export function withBlockQuote<T extends { origin?: { blockId?: string } }>(
  proposal: T,
): T & { blockHeading?: string; blockText?: string } {
  const blockId = proposal.origin?.blockId;
  if (!blockId) return proposal;
  const [block] = getBlocksByIds([blockId]);
  if (!block) return proposal;
  return { ...proposal, blockHeading: block.heading, blockText: block.text.slice(0, 1200) };
}

/** Кейси для експорту/пушу: список ID або фільтр. */
export function exportCases(projectId: string, body: { caseIds?: string[]; filter?: CaseFilter }): ExportCase[] {
  const ids =
    body.caseIds && body.caseIds.length > 0
      ? body.caseIds
      : resolveCaseIds(projectId, body.filter ?? {});
  const items = listAllCases(projectId, body.filter ?? {});
  const byId = new Map(items.map((item) => [item.id, item]));
  const paths = sectionPathMap(projectId);

  return ids
    .map((id) => byId.get(id) ?? null)
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .map((item) => ({
      id: item.id,
      title: item.title,
      sectionPath: paths.get(item.sectionId) ?? item.sectionPath,
      kind: item.kind,
      priority: item.priority,
      preconditions: item.preconditions,
      checks: item.checks,
      steps: item.steps,
      tags: item.tags,
      refs: listCoverageForCase(item.id).map((link) => link.blockId),
      testrailCaseId: item.testrail?.caseId,
    }));
}



/** Блоки для скіла у формі, яку очікує контракт: `{ id, heading, text }`. */
export function blocksForSkill(ids: readonly string[]): Array<{ id: string; heading: string; text: string }> {
  return getBlocksByIds(ids).map((block) => ({
    id: block.id,
    heading: block.heading,
    text: block.text,
  }));
}
