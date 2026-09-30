/**
 * HTTP-маршрути реєстру тест-кейсів (`/api/registry/**`).
 *
 * Тут і тільки тут сховища (`src/registry/*-store.ts`) зшиваються з AI-скілами
 * (`src/registry/skills/**`) та інтеграціями (`src/integrations/**`).
 * Скіли й інтеграції — чисті функції без доступу до бази: маршрут читає дані,
 * віддає їм, а результат кладе в чергу апрувів або в сховище.
 *
 * Пагінація, фільтри й сортування живуть у SQL (див. `src/registry/search.ts`),
 * а не в JS.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { ensureMigrated } from '../registry/db.js';
import {
  caseFilterSchema,
  caseInputSchema,
  bulkRequestSchema,
  projectInputSchema,
  proposalKindSchema,
  proposalStateSchema,
  selectionInputSchema,
  automationStatusSchema,
  defectSeveritySchema,
  defectStatusSchema,
  itemStatusSchema,
  runKindSchema,
  runStateSchema,
  skillNameSchema,
  testrailMappingSchema,
  type CaseFilter,
  type CaseKind,
  type CasePriority,
  type CaseStatus,
  type AutomationStatus,
  type TestrailMapping,
} from '../registry/types.js';
import {
  createProject,
  getProject,
  listProjects,
  requireProject,
  updateProject,
} from '../registry/projects-store.js';
import {
  createSection,
  deleteSection,
  sectionPathMap,
  sectionTree,
  updateSection,
} from '../registry/sections-store.js';
import {
  caseHistory,
  createCase,
  deleteCase,
  getCase,
  getCaseDetail,
  listAllCases,
  listCases,
  resolveCaseIds,
  setAutomation,
  setTestrailMeta,
  updateCase,
  type CasePatch,
} from '../registry/cases-store.js';
import { runBulk, undoBulk } from '../registry/bulk.js';
import {
  casesForBlocks,
  createSource,
  deleteSource,
  getBlocksByIds,
  getSource,
  listBlocks,
  listSources,
  refreshSource,
  requireSource,
  setSourceVersion,
  type RawBlockInput,
} from '../registry/sources-store.js';
import { coverageMatrix, linkCoverage, unlinkCoverage } from '../registry/coverage-store.js';
import {
  approveProposals,
  createProposal,
  deleteProposal,
  getProposal,
  listProposals,
  patchProposal,
  rejectProposals,
} from '../registry/proposals-store.js';
import {
  createSelection,
  deleteSelection,
  getSelection,
  listSelections,
  resolveSelection,
  updateSelection,
} from '../registry/selections-store.js';
import {
  attachAutoRun,
  createRun,
  listRunItems,
  listRuns,
  rerunFailed,
  runDetail,
  runEvents,
  setItemStatus,
  updateRun,
  type RunEvent,
} from '../registry/runs-store.js';
import { getDefect, listDefects, updateDefect, upsertDefect } from '../registry/defects-store.js';
import {
  createMapping,
  listMappings,
  requireMapping,
  updateMapping,
} from '../registry/mappings-store.js';
import { finishSkillRun, listSkillRuns, startSkillRun } from '../registry/skill-runs-store.js';
import { dashboard, driftCount } from '../registry/dashboard.js';
import { listCoverageForCase } from '../registry/coverage-store.js';
import { requestAuthor } from './auth.js';
import { startTestRun } from './test-runner.js';
import { settleRun, syncAutoResults, watchAutoResults } from './registry-bridge.js';
import {
  caseSyncHash,
  pullCases,
  pullResults,
  pushCases,
  type TestrailClientLike,
  type TestrailSyncCase,
} from '../registry/testrail-sync.js';

/* ──────────────── контракти чужих модулів (docs/module-contracts.md) ────── */

interface SkillUsage {
  promptTokens?: number;
  completionTokens?: number;
  model?: string;
  durationMs: number;
}

interface DraftCase {
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

interface WriteCasesModule {
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

interface ValidateCoverageModule {
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

interface ExportCase {
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

interface ConfluenceModule {
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

interface TestrailCsvModule {
  buildTestrailCsv: (cases: ExportCase[], mapping: TestrailMapping) => string;
}

interface TestrailXmlModule {
  buildTestrailXml: (cases: ExportCase[], mapping: TestrailMapping) => string;
}

interface TestrailApiModule {
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
const ROUTES_DIR = path.dirname(fileURLToPath(import.meta.url));

function moduleExists(specifier: string): boolean {
  const asJs = path.resolve(ROUTES_DIR, specifier);
  const asTs = asJs.replace(/\.js$/, '.ts');
  return fs.existsSync(asJs) || fs.existsSync(asTs);
}

async function loadModule<T>(specifier: string, human: string): Promise<T> {
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

class ModuleUnavailable extends Error {}

const SKILLS = {
  writeCases: '../registry/skills/write-cases.js',
  validateCoverage: '../registry/skills/validate-coverage.js',
};
const INTEGRATIONS = {
  confluence: '../integrations/confluence.js',
  testrailCsv: '../integrations/testrail-csv.js',
  testrailXml: '../integrations/testrail-xml.js',
  testrailApi: '../integrations/testrail-api.js',
};

/* ─────────────────────────── службові помічники ───────────────────────── */

function fail(res: Response, error: unknown, fallbackStatus = 400): void {
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

function asArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter(Boolean);
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value).toLowerCase();
  return text === '1' || text === 'true' || text === 'yes';
}

function asInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function requireProjectId(req: Request): string {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  if (!projectId) throw new Error('Параметр projectId обовʼязковий');
  return projectId;
}

/** Фільтр кейсів із query-параметрів. */
function filterFromQuery(req: Request): Partial<CaseFilter> {
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
function withBlockQuote<T extends { origin?: { blockId?: string } }>(
  proposal: T,
): T & { blockHeading?: string; blockText?: string } {
  const blockId = proposal.origin?.blockId;
  if (!blockId) return proposal;
  const [block] = getBlocksByIds([blockId]);
  if (!block) return proposal;
  return { ...proposal, blockHeading: block.heading, blockText: block.text.slice(0, 1200) };
}

/** Кейси для експорту/пушу: список ID або фільтр. */
function exportCases(projectId: string, body: { caseIds?: string[]; filter?: CaseFilter }): ExportCase[] {
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

/* ─────────────────────────────── маршрутизатор ─────────────────────────── */

export function createRegistryRouter(): Router {
  const router = express.Router();
  ensureMigrated();

  /* ───────────────────────────── проєкти ──────────────────────────────── */

  router.get('/projects', (_req, res) => {
    try {
      res.json(listProjects());
    } catch (error) {
      fail(res, error, 500);
    }
  });

  router.post('/projects', (req, res) => {
    try {
      res.status(201).json(createProject(projectInputSchema.parse(req.body)));
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/projects/:id', (req, res) => {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: `Проєкт «${req.params.id}» не знайдено` });
      return;
    }
    res.json(project);
  });

  router.patch('/projects/:id', (req, res) => {
    try {
      const patch = projectInputSchema.partial().parse(req.body);
      res.json(updateProject(req.params.id, patch));
    } catch (error) {
      fail(res, error);
    }
  });

  /* ───────────────────────────── секції ───────────────────────────────── */

  router.get('/sections', (req, res) => {
    try {
      const projectId = requireProjectId(req);
      requireProject(projectId);
      res.json(sectionTree(projectId));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/sections', (req, res) => {
    try {
      const body = z
        .object({
          projectId: z.string().min(1),
          name: z.string().min(1),
          parentId: z.string().nullable().optional(),
          code: z.string().optional(),
          position: z.number().int().nonnegative().optional(),
          testrailSectionId: z.number().int().positive().optional(),
        })
        .parse(req.body);
      res.status(201).json(createSection(body));
    } catch (error) {
      fail(res, error);
    }
  });

  router.patch('/sections/:id', (req, res) => {
    try {
      const body = z
        .object({
          name: z.string().min(1).optional(),
          parentId: z.string().nullable().optional(),
          position: z.number().int().nonnegative().optional(),
          testrailSectionId: z.number().int().positive().optional(),
        })
        .parse(req.body);
      res.json(updateSection(req.params.id, body));
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete('/sections/:id', (req, res) => {
    try {
      const moveCasesTo = typeof req.query.moveCasesTo === 'string' ? req.query.moveCasesTo : undefined;
      deleteSection(req.params.id, { moveCasesTo });
      res.json({ deleted: true });
    } catch (error) {
      fail(res, error, 409);
    }
  });

  /* ───────────────────────────── кейси ────────────────────────────────── */

  router.get('/cases', (req, res) => {
    try {
      const projectId = requireProjectId(req);
      requireProject(projectId);
      res.json(
        listCases({
          projectId,
          filter: filterFromQuery(req),
          sort: typeof req.query.sort === 'string' ? req.query.sort : undefined,
          page: asInt(req.query.page, 1),
          limit: asInt(req.query.limit, 50),
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/cases/bulk', (req, res) => {
    try {
      const body = bulkRequestSchema.parse({ ...req.body, author: req.body?.author ?? requestAuthor(req) });
      res.json(runBulk(body));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/cases/bulk/undo', (req, res) => {
    try {
      const body = z.object({ batchId: z.string().min(1) }).parse(req.body);
      res.json(undoBulk(body.batchId));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/cases', (req, res) => {
    try {
      const body = z.object({ projectId: z.string().min(1) }).passthrough().parse(req.body);
      const input = caseInputSchema.parse(body);
      res.status(201).json(
        createCase(body.projectId, input, {
          author: requestAuthor(req),
          reason: typeof req.body?.reason === 'string' ? req.body.reason : undefined,
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/cases/:id', (req, res) => {
    const detail = getCaseDetail(req.params.id);
    if (!detail) {
      res.status(404).json({ error: `Кейс «${req.params.id}» не знайдено` });
      return;
    }
    res.json(detail);
  });

  router.patch('/cases/:id', (req, res) => {
    try {
      const patch = caseInputSchema.partial().parse(req.body) as CasePatch;
      const updated = updateCase(req.params.id, patch, {
        author: requestAuthor(req),
        reason: typeof req.body?.reason === 'string' ? req.body.reason : undefined,
      });
      res.json(updated);
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete('/cases/:id', (req, res) => {
    try {
      deleteCase(req.params.id, { hard: asBool(req.query.hard, false) }, { author: requestAuthor(req) });
      res.json({ deleted: true, hard: asBool(req.query.hard, false) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/cases/:id/history', (req, res) => {
    if (!getCase(req.params.id)) {
      res.status(404).json({ error: `Кейс «${req.params.id}» не знайдено` });
      return;
    }
    res.json(caseHistory(req.params.id));
  });

  router.post('/cases/:id/automation', (req, res) => {
    try {
      const body = z
        .object({
          status: automationStatusSchema,
          scenarioPath: z.string().optional(),
          quarantineReason: z.string().optional(),
        })
        .parse(req.body);
      res.json(setAutomation(req.params.id, body, { author: requestAuthor(req) }));
    } catch (error) {
      fail(res, error);
    }
  });

  /* ─────────────────── джерела вимог і покриття ───────────────────────── */

  router.get('/sources', (req, res) => {
    try {
      const projectId = requireProjectId(req);
      res.json(
        listSources(projectId).map((source) => ({
          ...source,
          // Псевдонім і лічильник змінених блоків для інтерфейсу.
          gapCount: source.gaps,
          changed: listBlocks(source.id).filter((block) => block.changeState === 'changed').length,
        })),
      );
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/sources/import', async (req, res) => {
    try {
      const body = z
        .object({
          projectId: z.string().min(1),
          kind: z.enum(['confluence', 'file', 'paste']),
          url: z.string().optional(),
          externalId: z.string().optional(),
          text: z.string().optional(),
          html: z.string().optional(),
          title: z.string().optional(),
          /** Явний формат вмісту; без нього визначаємо самі (вставити можуть і HTML, і markdown). */
          format: z.enum(['html', 'text', 'markdown']).optional(),
        })
        .parse(req.body);
      requireProject(body.projectId);

      const confluence = await loadModule<ConfluenceModule>(INTEGRATIONS.confluence, 'src/integrations/confluence.ts');

      if (body.kind === 'confluence') {
        if (!confluence.isConfluenceConfigured()) {
          res.status(400).json({
            error: 'Confluence не налаштовано: потрібні CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN',
          });
          return;
        }
        const page = await confluence.fetchConfluencePage({ url: body.url, pageId: body.externalId });
        const blocks = confluence.splitIntoBlocks(page.html, { format: 'html' });
        const created = createSource({
          projectId: body.projectId,
          kind: 'confluence',
          title: body.title ?? page.title,
          url: page.url,
          externalId: page.externalId,
          externalVersion: page.version,
          blocks,
        });
        res.status(201).json(created);
        return;
      }

      const content = body.html ?? body.text ?? '';
      if (!content.trim()) {
        res.status(400).json({ error: 'Потрібен text або html' });
        return;
      }
      // Вставлений вміст буває будь-який: HTML зі Confluence, markdown або простий текст.
      const looksLikeHtml = /<(h[1-6]|p|div|table|ul|ol|section)\b/i.test(content);
      const format = body.format ?? (body.html || looksLikeHtml ? 'html' : 'markdown');
      const blocks = confluence.splitIntoBlocks(content, { format });
      const created = createSource({
        projectId: body.projectId,
        kind: body.kind,
        title: body.title ?? 'Без назви',
        url: body.url,
        blocks,
      });
      res.status(201).json(created);
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/sources/:id', (req, res) => {
    const source = getSource(req.params.id);
    if (!source) {
      res.status(404).json({ error: `Джерело «${req.params.id}» не знайдено` });
      return;
    }
    res.json({ ...source, blocks: listBlocks(source.id) });
  });

  router.post('/sources/:id/refresh', async (req, res) => {
    try {
      const source = requireSource(req.params.id);
      const confluence = await loadModule<ConfluenceModule>(INTEGRATIONS.confluence, 'src/integrations/confluence.ts');

      let blocks: RawBlockInput[];
      const body = z
        .object({ text: z.string().optional(), html: z.string().optional() })
        .parse(req.body ?? {});

      if (source.kind === 'confluence') {
        const page = await confluence.fetchConfluencePage({ url: source.url, pageId: source.externalId });
        blocks = confluence.splitIntoBlocks(page.html, { format: 'html' });
        setSourceVersion(source.id, page.version);
      } else {
        const content = body.html ?? body.text ?? '';
        if (!content.trim()) {
          res.status(400).json({ error: 'Для джерела цього типу передайте text або html' });
          return;
        }
        blocks = confluence.splitIntoBlocks(content, { format: body.html ? 'html' : 'markdown' });
      }

      const result = refreshSource(source.id, blocks);
      const touched = casesForBlocks([...result.changed, ...result.removed]);
      const proposals = touched.map((link) =>
        createProposal({
          projectId: source.projectId,
          kind: 'case_update',
          title: `Вимога змінилась — перевірте кейс ${link.caseId}`,
          rationale: 'Текст блоку вимоги змінився після переімпорту джерела',
          payload: { caseId: link.caseId, changes: {} },
          origin: { sourceId: source.id, blockId: link.blockId, caseId: link.caseId },
        }),
      );

      res.json({
        changed: result.changed.length,
        added: result.added.length,
        removed: result.removed.length,
        same: result.same.length,
        proposals,
      });
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete('/sources/:id', (req, res) => {
    try {
      deleteSource(req.params.id);
      res.json({ deleted: true, note: 'Звʼязки покриття лишилися як orphan' });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/coverage', (req, res) => {
    try {
      const projectId = requireProjectId(req);
      const sourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId : undefined;
      res.json(coverageMatrix(projectId, sourceId));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/coverage', (req, res) => {
    try {
      const body = z
        .object({
          blockId: z.string().min(1),
          caseId: z.string().min(1),
          kind: z.enum(['quote', 'derived']).default('quote'),
          confirmed: z.boolean().default(false),
          note: z.string().default(''),
        })
        .parse(req.body);
      res.status(201).json(linkCoverage(body));
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete('/coverage/:id', (req, res) => {
    const removed = unlinkCoverage(req.params.id);
    if (!removed) {
      res.status(404).json({ error: `Звʼязок «${req.params.id}» не знайдено` });
      return;
    }
    res.json({ deleted: true });
  });

  /* ──────────────────────── черга апрувів ────────────────────────────── */

  router.get('/proposals', (req, res) => {
    try {
      const page = listProposals({
        projectId: requireProjectId(req),
        state: typeof req.query.state === 'string' ? proposalStateSchema.parse(req.query.state) : undefined,
        kind: typeof req.query.kind === 'string' ? proposalKindSchema.parse(req.query.kind) : undefined,
        sourceId: typeof req.query.sourceId === 'string' ? req.query.sourceId : undefined,
        blockId: typeof req.query.blockId === 'string' ? req.query.blockId : undefined,
        page: asInt(req.query.page, 1),
        limit: asInt(req.query.limit, 50),
      });
      res.json({ ...page, items: page.items.map(withBlockQuote) });
    } catch (error) {
      fail(res, error);
    }
  });

  /**
   * Розширення контракту: ручне створення пропозиції. Потрібне UI (інженер
   * сам ставить правку в чергу) і тестам; скіли користуються тим самим шляхом.
   */
  router.post('/proposals', (req, res) => {
    try {
      const body = z
        .object({
          projectId: z.string().min(1),
          kind: proposalKindSchema,
          title: z.string().min(1),
          payload: z.unknown(),
          rationale: z.string().optional(),
          diff: z.record(z.string(), z.object({ before: z.unknown(), after: z.unknown() })).optional(),
          origin: z
            .object({
              skill: skillNameSchema.optional(),
              skillRunId: z.string().optional(),
              blockId: z.string().optional(),
              sourceId: z.string().optional(),
              runId: z.string().optional(),
              caseId: z.string().optional(),
            })
            .optional(),
          coverageKind: z.enum(['quote', 'derived']).optional(),
          note: z.string().optional(),
        })
        .parse(req.body);
      requireProject(body.projectId);
      res.status(201).json(createProposal({ ...body, payload: body.payload ?? null }));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/proposals/approve', (req, res) => {
    try {
      const body = z
        .object({ ids: z.array(z.string().min(1)).min(1), reviewer: z.string().optional() })
        .parse(req.body);
      res.json(approveProposals(body.ids, body.reviewer ?? requestAuthor(req)));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/proposals/reject', (req, res) => {
    try {
      const body = z
        .object({
          ids: z.array(z.string().min(1)).min(1),
          note: z.string().optional(),
          reviewer: z.string().optional(),
        })
        .parse(req.body);
      res.json(rejectProposals(body.ids, body.note, body.reviewer ?? requestAuthor(req)));
    } catch (error) {
      fail(res, error);
    }
  });

  router.patch('/proposals/:id', (req, res) => {
    try {
      const body = z
        .object({
          payload: z.unknown().optional(),
          title: z.string().min(1).optional(),
          rationale: z.string().optional(),
          note: z.string().optional(),
          diff: z.record(z.string(), z.object({ before: z.unknown(), after: z.unknown() })).optional(),
          coverageKind: z.enum(['quote', 'derived']).optional(),
        })
        .parse(req.body);
      res.json(patchProposal(req.params.id, body));
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete('/proposals/:id', (req, res) => {
    try {
      if (!getProposal(req.params.id)) {
        res.status(404).json({ error: `Пропозицію «${req.params.id}» не знайдено` });
        return;
      }
      deleteProposal(req.params.id);
      res.json({ deleted: true });
    } catch (error) {
      fail(res, error);
    }
  });

  /* ───────────────────────────── AI-скіли ────────────────────────────── */

  router.post('/skills/write-cases', async (req, res) => {
    const body = z
      .object({
        projectId: z.string().min(1),
        sectionId: z.string().min(1),
        blockIds: z.array(z.string()).optional(),
        text: z.string().optional(),
        style: z
          .object({ maxPerBlock: z.number().int().positive().optional(), includeDerived: z.boolean().optional() })
          .optional(),
      })
      .safeParse(req.body);
    if (!body.success) {
      fail(res, body.error);
      return;
    }

    let skillRunId: string | null = null;
    try {
      const project = requireProject(body.data.projectId);
      const paths = sectionPathMap(project.id);
      const blocks = (body.data.blockIds ?? []).length
        ? blocksForSkill(body.data.blockIds ?? [])
        : body.data.text
          ? [{ id: 'inline', heading: '', text: body.data.text }]
          : [];
      if (blocks.length === 0) {
        res.status(400).json({ error: 'Передайте blockIds або text' });
        return;
      }

      const { writeCases } = await loadModule<WriteCasesModule>(
        SKILLS.writeCases,
        'src/registry/skills/write-cases.ts',
      );
      const skillRun = startSkillRun(project.id, 'write-cases', body.data);
      skillRunId = skillRun.id;

      const result = await writeCases({
        blocks,
        sectionPath: paths.get(body.data.sectionId) ?? '',
        projectName: project.name,
        style: body.data.style,
      });

      const proposals = result.drafts.map((draft) =>
        createProposal({
          projectId: project.id,
          kind: 'case_create',
          title: draft.case.title,
          rationale: draft.rationale,
          payload: { ...draft.case, sectionId: body.data.sectionId },
          coverageKind: draft.coverageKind,
          origin: { skill: 'write-cases', skillRunId: skillRun.id, blockId: draft.blockId },
        }),
      );

      const finished = finishSkillRun(skillRun.id, {
        state: 'done',
        output: { warnings: result.warnings, drafts: result.drafts.length },
        model: result.usage.model,
        proposalCount: proposals.length,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        durationMs: result.usage.durationMs,
      });
      res.json({ skillRun: finished, proposals, warnings: result.warnings });
    } catch (error) {
      if (skillRunId) {
        finishSkillRun(skillRunId, {
          state: 'failed',
          error: error instanceof Error ? error.message : 'невідома помилка',
        });
      }
      fail(res, error, 502);
    }
  });

  router.post('/skills/validate-coverage', async (req, res) => {
    const body = z
      .object({
        projectId: z.string().min(1),
        sourceId: z.string().optional(),
        blockIds: z.array(z.string()).optional(),
        sectionId: z.string().optional(),
      })
      .safeParse(req.body);
    if (!body.success) {
      fail(res, body.error);
      return;
    }

    let skillRunId: string | null = null;
    try {
      const project = requireProject(body.data.projectId);
      const blocks = body.data.blockIds?.length
        ? blocksForSkill(body.data.blockIds)
        : body.data.sourceId
          ? listBlocks(body.data.sourceId).map((b) => ({ id: b.id, heading: b.heading, text: b.text }))
          : [];
      const cases = listAllCases(
        project.id,
        body.data.sectionId ? { sectionIds: [body.data.sectionId], includeSubsections: true } : {},
      ).map((c) => ({ id: c.id, title: c.title, checks: c.checks, kind: c.kind }));

      const { validateCoverage } = await loadModule<ValidateCoverageModule>(
        SKILLS.validateCoverage,
        'src/registry/skills/validate-coverage.ts',
      );
      const skillRun = startSkillRun(project.id, 'validate-coverage', body.data);
      skillRunId = skillRun.id;

      const result = await validateCoverage({
        blocks,
        cases,
        sectionPath: body.data.sectionId ? (sectionPathMap(project.id).get(body.data.sectionId) ?? '') : '',
      });

      const proposals = result.report.gaps.map((gap) =>
        createProposal({
          projectId: project.id,
          kind: 'case_create',
          title: gap.suggestion.title,
          rationale: `Прогалина покриття: ${gap.fragment}`,
          payload: { ...gap.suggestion, sectionId: body.data.sectionId ?? '' },
          coverageKind: 'quote',
          origin: { skill: 'validate-coverage', skillRunId: skillRun.id, blockId: gap.blockId },
        }),
      );

      const finished = finishSkillRun(skillRun.id, {
        state: 'done',
        output: result.report,
        model: result.usage.model,
        proposalCount: proposals.length,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        durationMs: result.usage.durationMs,
      });
      res.json({ skillRun: finished, report: result.report, proposals, warnings: result.warnings });
    } catch (error) {
      if (skillRunId) {
        finishSkillRun(skillRunId, {
          state: 'failed',
          error: error instanceof Error ? error.message : 'невідома помилка',
        });
      }
      fail(res, error, 502);
    }
  });

  router.post('/skills/format-export', async (req, res) => {
    try {
      const body = z
        .object({
          projectId: z.string().min(1),
          caseIds: z.array(z.string()).optional(),
          filter: caseFilterSchema.partial().optional(),
          mappingId: z.string().min(1),
          target: z.enum(['csv', 'xml', 'api']),
          dryRun: z.boolean().default(true),
        })
        .parse(req.body);
      requireProject(body.projectId);
      const mapping = requireMapping(body.mappingId);
      const cases = exportCases(body.projectId, {
        caseIds: body.caseIds,
        filter: body.filter as CaseFilter | undefined,
      });

      const skillRun = startSkillRun(body.projectId, 'format-export', body);
      const started = Date.now();
      let preview = '';
      if (body.target === 'csv') {
        const mod = await loadModule<TestrailCsvModule>(INTEGRATIONS.testrailCsv, 'src/integrations/testrail-csv.ts');
        preview = mod.buildTestrailCsv(cases, mapping);
      } else if (body.target === 'xml') {
        const mod = await loadModule<TestrailXmlModule>(INTEGRATIONS.testrailXml, 'src/integrations/testrail-xml.ts');
        preview = mod.buildTestrailXml(cases, mapping);
      } else {
        preview = JSON.stringify(cases, null, 2);
      }

      const finished = finishSkillRun(skillRun.id, {
        state: 'done',
        output: { cases: cases.length, target: body.target },
        durationMs: Date.now() - started,
      });
      res.json({
        skillRun: finished,
        preview: preview.slice(0, 200_000),
        fileUrl:
          body.target === 'api'
            ? undefined
            : `/api/registry/export/testrail.${body.target}?projectId=${encodeURIComponent(body.projectId)}&mappingId=${encodeURIComponent(mapping.id)}`,
      });
    } catch (error) {
      fail(res, error, 502);
    }
  });

  router.get('/skills/runs', (req, res) => {
    try {
      res.json(
        listSkillRuns({
          projectId: requireProjectId(req),
          skill: typeof req.query.skill === 'string' ? skillNameSchema.parse(req.query.skill) : undefined,
          page: asInt(req.query.page, 1),
          limit: asInt(req.query.limit, 50),
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  });

  /* ───────────────────────────── вибірки ─────────────────────────────── */

  router.get('/selections', (req, res) => {
    try {
      res.json(listSelections(requireProjectId(req)));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/selections', (req, res) => {
    try {
      const body = selectionInputSchema.parse(req.body);
      res.status(201).json(createSelection(body));
    } catch (error) {
      fail(res, error);
    }
  });

  router.patch('/selections/:id', (req, res) => {
    try {
      const body = z
        .object({
          name: z.string().min(1).optional(),
          description: z.string().optional(),
          mode: z.enum(['static', 'filter']).optional(),
          caseIds: z.array(z.string()).optional(),
          filter: caseFilterSchema.nullable().optional(),
          stopOnFailure: z.boolean().optional(),
        })
        .parse(req.body);
      res.json(updateSelection(req.params.id, body));
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete('/selections/:id', (req, res) => {
    try {
      deleteSelection(req.params.id);
      res.json({ deleted: true });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/selections/:id/resolve', (req, res) => {
    try {
      if (!getSelection(req.params.id)) {
        res.status(404).json({ error: `Вибірку «${req.params.id}» не знайдено` });
        return;
      }
      res.json(resolveSelection(req.params.id));
    } catch (error) {
      fail(res, error);
    }
  });

  /* ───────────────────────────── прогони ─────────────────────────────── */

  router.get('/runs', (req, res) => {
    try {
      res.json(
        listRuns({
          projectId: requireProjectId(req),
          kind: typeof req.query.kind === 'string' ? runKindSchema.parse(req.query.kind) : undefined,
          state: typeof req.query.state === 'string' ? runStateSchema.parse(req.query.state) : undefined,
          page: asInt(req.query.page, 1),
          limit: asInt(req.query.limit, 50),
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/runs', (req, res) => {
    try {
      const body = z
        .object({
          projectId: z.string().min(1),
          kind: runKindSchema.default('manual'),
          title: z.string().optional(),
          selectionId: z.string().optional(),
          caseIds: z.array(z.string()).optional(),
          env: z
            .object({
              baseUrl: z.string().optional(),
              mode: z.enum(['warm-up', 'regression']).optional(),
              label: z.string().optional(),
            })
            .optional(),
          note: z.string().optional(),
        })
        .refine((data) => Boolean(data.selectionId || (data.caseIds && data.caseIds.length > 0)), {
          message: 'Передайте selectionId або caseIds',
        })
        .parse(req.body);
      res.status(201).json(createRun({ ...body, executor: requestAuthor(req) }));
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/runs/:id', (req, res) => {
    const detail = runDetail(req.params.id);
    if (!detail) {
      res.status(404).json({ error: `Прогін «${req.params.id}» не знайдено` });
      return;
    }
    res.json(detail);
  });

  router.patch('/runs/:id', (req, res) => {
    try {
      const body = z
        .object({
          state: runStateSchema.optional(),
          title: z.string().min(1).optional(),
          note: z.string().optional(),
        })
        .parse(req.body);
      const run = updateRun(req.params.id, body);
      if (body.state === 'completed') settleRun(run.id);
      res.json(run);
    } catch (error) {
      fail(res, error);
    }
  });

  router.put('/runs/:id/items/:caseId', (req, res) => {
    try {
      const body = z
        .object({
          status: itemStatusSchema,
          comment: z.string().optional(),
          evidence: z.array(z.string()).optional(),
          durationMs: z.number().int().nonnegative().optional(),
          defect: z
            .object({
              title: z.string().min(1),
              severity: defectSeveritySchema.optional(),
              details: z.string().optional(),
            })
            .optional(),
        })
        .parse(req.body);
      res.json(
        setItemStatus(req.params.id, req.params.caseId, { ...body, updatedBy: requestAuthor(req) }),
      );
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/runs/:id/rerun-failed', (req, res) => {
    try {
      res.status(201).json(rerunFailed(req.params.id, requestAuthor(req)));
    } catch (error) {
      fail(res, error);
    }
  });

  /**
   * Ставить у чергу прогони рушія для автоматизованих кейсів.
   * `startTestRun` — єдиний виклик у бік старого світу тест-раннера.
   */
  router.post('/runs/:id/auto', async (req, res) => {
    try {
      const detail = runDetail(req.params.id);
      if (!detail) {
        res.status(404).json({ error: `Прогін «${req.params.id}» не знайдено` });
        return;
      }
      const only = new Set(z.object({ caseIds: z.array(z.string()).optional() }).parse(req.body ?? {}).caseIds ?? []);
      const queued: Array<{ caseId: string; autoRunId: string; scenarioPath: string }> = [];
      const skipped: Array<{ caseId: string; reason: string }> = [];

      for (const item of detail.items) {
        if (only.size > 0 && !only.has(item.caseId)) continue;
        const automation = item.case.automation;
        if (automation.status !== 'automated') {
          skipped.push({ caseId: item.caseId, reason: 'кейс не автоматизований' });
          continue;
        }
        if (!automation.scenarioPath) {
          skipped.push({ caseId: item.caseId, reason: 'не заданий scenarioPath' });
          continue;
        }
        try {
          const engineRun = await startTestRun(
            {
              qaScenarioPath: automation.scenarioPath,
              ...(detail.env.baseUrl ? { qaTargetUrl: detail.env.baseUrl } : {}),
              ...(detail.env.mode ? { qaMode: detail.env.mode } : {}),
            },
            // Ціль закріплюємо лише тоді, коли її задали для цього прогону:
            // дефолт проєкту не має відбирати у сценарію його власну адресу.
            { pinTargetUrl: Boolean(detail.env.baseUrlPinned && detail.env.baseUrl) },
          );
          attachAutoRun(detail.id, item.caseId, engineRun.id);
          queued.push({ caseId: item.caseId, autoRunId: engineRun.id, scenarioPath: automation.scenarioPath });
        } catch (error) {
          skipped.push({
            caseId: item.caseId,
            reason: error instanceof Error ? error.message : 'не вдалося запустити',
          });
        }
      }

      // Мостик донесе результати рушія в елементи прогону й історію кейсів.
      if (queued.length > 0) watchAutoResults(detail.id);
      res.json({ queued, skipped, total: detail.items.length });
    } catch (error) {
      fail(res, error, 502);
    }
  });

  /** Ручна синхронізація результатів рушія — напр. після перезапуску сервера. */
  router.post('/runs/:id/sync-auto', async (req, res) => {
    try {
      const detail = runDetail(req.params.id);
      if (!detail) {
        res.status(404).json({ error: `Прогін «${req.params.id}» не знайдено` });
        return;
      }
      const outcome = await syncAutoResults(detail.id);
      if (outcome.pending === 0) settleRun(detail.id);
      else watchAutoResults(detail.id);
      res.json(outcome);
    } catch (error) {
      fail(res, error, 502);
    }
  });

  router.get('/runs/:id/stream', (req, res) => {
    const runId = req.params.id;
    if (!runDetail(runId)) {
      res.status(404).json({ error: `Прогін «${runId}» не знайдено` });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let eventId = asInt(req.get('last-event-id') ?? req.query.lastEventId, 0);
    const send = (event: string, data: unknown): void => {
      eventId += 1;
      res.write(`id: ${eventId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('snapshot', { runId, items: listRunItems(runId) });

    const onEvent = (event: RunEvent): void => {
      if (event.runId !== runId) return;
      send(event.type, event.payload);
    };
    runEvents.on('event', onEvent);

    // Heartbeat кожні 15 с — інакше проксі рубає простій.
    const heartbeat = setInterval(() => {
      res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
    }, 15_000);

    const close = (): void => {
      clearInterval(heartbeat);
      runEvents.off('event', onEvent);
    };
    req.on('close', close);
    res.on('close', close);
  });

  /* ───────────────────────────── дефекти ─────────────────────────────── */

  router.get('/defects', (req, res) => {
    try {
      res.json(
        listDefects({
          projectId: requireProjectId(req),
          status: typeof req.query.status === 'string' ? defectStatusSchema.parse(req.query.status) : undefined,
          caseId: typeof req.query.caseId === 'string' ? req.query.caseId : undefined,
          page: asInt(req.query.page, 1),
          limit: asInt(req.query.limit, 50),
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/defects', (req, res) => {
    try {
      const body = z
        .object({
          projectId: z.string().min(1),
          title: z.string().min(1),
          details: z.string().optional(),
          severity: defectSeveritySchema.optional(),
          status: defectStatusSchema.optional(),
          caseId: z.string().optional(),
          runItemId: z.string().optional(),
        })
        .parse(req.body);
      requireProject(body.projectId);
      res.status(201).json(upsertDefect(body));
    } catch (error) {
      fail(res, error);
    }
  });

  router.patch('/defects/:id', (req, res) => {
    try {
      if (!getDefect(req.params.id)) {
        res.status(404).json({ error: `Дефект «${req.params.id}» не знайдено` });
        return;
      }
      const body = z
        .object({
          title: z.string().min(1).optional(),
          details: z.string().optional(),
          severity: defectSeveritySchema.optional(),
          status: defectStatusSchema.optional(),
          externalKey: z.string().optional(),
          externalUrl: z.string().optional(),
        })
        .parse(req.body);
      res.json(updateDefect(req.params.id, body));
    } catch (error) {
      fail(res, error);
    }
  });

  /* ───────────────────────────── TestRail ────────────────────────────── */

  router.get('/testrail/mappings', (req, res) => {
    try {
      res.json(listMappings(requireProjectId(req)));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/testrail/mappings', (req, res) => {
    try {
      const body = testrailMappingSchema.omit({ id: true, createdAt: true, updatedAt: true }).parse(req.body);
      requireProject(body.projectId);
      res.status(201).json(createMapping(body));
    } catch (error) {
      fail(res, error);
    }
  });

  router.patch('/testrail/mappings/:id', (req, res) => {
    try {
      const body = testrailMappingSchema
        .omit({ id: true, projectId: true, createdAt: true, updatedAt: true })
        .partial()
        .parse(req.body);
      res.json(updateMapping(req.params.id, body));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/testrail/push', async (req, res) => {
    try {
      const body = z
        .object({
          projectId: z.string().min(1),
          caseIds: z.array(z.string()).optional(),
          filter: caseFilterSchema.partial().optional(),
          mappingId: z.string().min(1),
          dryRun: z.boolean().default(true),
          /** Оновити навіть ті кейси, чий хеш синхронізації не змінився. */
          force: z.boolean().default(false),
        })
        .parse(req.body);
      const project = requireProject(body.projectId);
      const mapping = requireMapping(body.mappingId);
      const api = await loadModule<TestrailApiModule>(INTEGRATIONS.testrailApi, 'src/integrations/testrail-api.ts');
      if (!api.isTestrailConfigured()) {
        res.status(400).json({
          error:
            'TestRail не налаштовано: задайте TESTRAIL_BASE_URL, TESTRAIL_USER, TESTRAIL_API_KEY. Без них доступні лише CSV/XML.',
        });
        return;
      }
      if (!project.testrailProjectId) {
        res.status(400).json({ error: 'У проєкті не заданий testrailProjectId' });
        return;
      }

      const syncCases: TestrailSyncCase[] = exportCases(project.id, {
        caseIds: body.caseIds,
        filter: body.filter as CaseFilter | undefined,
      }).map((item) => {
        const stored = getCase(item.id)?.testrail;
        return { ...item, ...(stored?.syncHash ? { syncHash: stored.syncHash } : {}) };
      });
      const projectRef = {
        testrailProjectId: project.testrailProjectId,
        ...(project.testrailSuiteId ? { testrailSuiteId: project.testrailSuiteId } : {}),
      };

      if (body.dryRun) {
        const willCreate: string[] = [];
        const willUpdate: string[] = [];
        const unchanged: string[] = [];
        for (const item of syncCases) {
          if (!item.testrailCaseId) willCreate.push(item.id);
          else if (!body.force && item.syncHash === caseSyncHash(item, mapping)) unchanged.push(item.id);
          else willUpdate.push(item.id);
        }
        res.json({
          applied: false,
          willCreate,
          willUpdate,
          unchanged,
          sections: Array.from(new Set(syncCases.map((item) => item.sectionPath).filter(Boolean))),
          errors: [],
        });
        return;
      }

      const client = new api.TestrailClient({
        baseUrl: process.env.TESTRAIL_BASE_URL as string,
        user: process.env.TESTRAIL_USER as string,
        apiKey: process.env.TESTRAIL_API_KEY as string,
      }) as unknown as TestrailClientLike;

      const pushed = await pushCases({
        client,
        project: projectRef,
        mapping,
        cases: syncCases,
        onSynced: (caseId, patch) => setTestrailMeta(caseId, patch),
        force: body.force,
      });

      res.json({
        applied: true,
        created: pushed.created,
        updated: pushed.updated,
        unchanged: pushed.unchanged,
        sectionsCreated: pushed.sectionsCreated,
        errors: pushed.errors,
        mapping: mapping.id,
      });
    } catch (error) {
      fail(res, error, 502);
    }
  });

  router.post('/testrail/pull', async (req, res) => {
    try {
      const body = z
        .object({
          projectId: z.string().min(1),
          mappingId: z.string().min(1),
          scope: z.enum(['cases', 'results']),
          /** Конкретний ран TestRail; без нього беремо найсвіжіший. */
          runId: z.number().int().positive().optional(),
          /** Записати знайдені `testrailCaseId` у реєстр. */
          adopt: z.boolean().default(true),
        })
        .parse(req.body);
      const project = requireProject(body.projectId);
      const mapping = requireMapping(body.mappingId);
      const api = await loadModule<TestrailApiModule>(INTEGRATIONS.testrailApi, 'src/integrations/testrail-api.ts');
      if (!api.isTestrailConfigured()) {
        res.status(400).json({
          error:
            'TestRail не налаштовано: задайте TESTRAIL_BASE_URL, TESTRAIL_USER, TESTRAIL_API_KEY. Без них доступні лише CSV/XML.',
        });
        return;
      }
      if (!project.testrailProjectId) {
        res.status(400).json({ error: 'У проєкті не заданий testrailProjectId' });
        return;
      }

      const client = new api.TestrailClient({
        baseUrl: process.env.TESTRAIL_BASE_URL as string,
        user: process.env.TESTRAIL_USER as string,
        apiKey: process.env.TESTRAIL_API_KEY as string,
      }) as unknown as TestrailClientLike;
      const projectRef = {
        testrailProjectId: project.testrailProjectId,
        ...(project.testrailSuiteId ? { testrailSuiteId: project.testrailSuiteId } : {}),
      };

      if (body.scope === 'cases') {
        const ours: TestrailSyncCase[] = exportCases(project.id, {}).map((item) => {
          const stored = getCase(item.id)?.testrail;
          return { ...item, ...(stored?.syncHash ? { syncHash: stored.syncHash } : {}) };
        });
        const pulled = await pullCases({ client, project: projectRef, mapping, ours });
        if (body.adopt) {
          const syncedAt = new Date().toISOString();
          for (const row of pulled.adopted) {
            setTestrailMeta(row.caseId, { caseId: row.testrailCaseId, syncedAt });
          }
        }
        res.json({
          scope: 'cases',
          imported: pulled.total,
          adopted: pulled.adopted,
          drift: pulled.drift,
          unknown: pulled.unknown.slice(0, 100),
          unknownTotal: pulled.unknown.length,
        });
        return;
      }

      // scope === 'results': ран TestRail стає прогоном реєстру з історією по кейсах.
      const pulled = await pullResults({
        client,
        project: projectRef,
        ...(body.runId ? { runId: body.runId } : {}),
      });
      const byTestrailId = new Map<number, string>();
      for (const item of listAllCases(project.id)) {
        if (item.testrail?.caseId) byTestrailId.set(item.testrail.caseId, item.id);
      }
      const matched = pulled.results.filter((row) => byTestrailId.has(row.testrailCaseId));
      const unmatched = pulled.results.length - matched.length;

      if (!pulled.run || matched.length === 0) {
        res.json({
          scope: 'results',
          imported: 0,
          unmatched,
          run: pulled.run ?? null,
          note:
            unmatched > 0
              ? 'Результати є, але жоден кейс TestRail не пов’язаний із реєстром — спершу зробіть pull зі scope=cases'
              : 'У TestRail немає результатів для імпорту',
        });
        return;
      }

      const run = createRun({
        projectId: project.id,
        kind: 'manual',
        title: `TestRail: ${pulled.run.name}`,
        caseIds: matched.map((row) => byTestrailId.get(row.testrailCaseId) as string),
        executor: 'testrail',
        note: `Імпортовано з TestRail run ${pulled.run.id}`,
      });
      for (const row of matched) {
        setItemStatus(run.id, byTestrailId.get(row.testrailCaseId) as string, {
          status: row.status,
          comment: row.comment.slice(0, 2000),
          updatedBy: 'testrail',
        });
      }
      updateRun(run.id, { state: 'completed' });

      res.json({
        scope: 'results',
        imported: matched.length,
        unmatched,
        run: pulled.run,
        registryRunId: run.id,
      });
    } catch (error) {
      fail(res, error, 502);
    }
  });

  router.get('/testrail/drift', (req, res) => {
    try {
      const projectId = requireProjectId(req);
      const mappingId = typeof req.query.mappingId === 'string' ? req.query.mappingId : undefined;
      const mapping = mappingId ? requireMapping(mappingId) : listMappings(projectId)[0];

      const rows: Array<{
        caseId: string;
        title: string;
        fields: string[];
        ours: string;
        theirs: string;
      }> = [];

      for (const item of exportCases(projectId, {})) {
        const caseRow = getCase(item.id);
        const stored = caseRow?.testrail;
        if (!stored?.caseId) continue;

        if (!mapping) {
          // Без профілю мапінгу хеш не порахувати — лишається порівняння часу.
          if (!stored.syncedAt || (caseRow && caseRow.updatedAt > stored.syncedAt)) {
            rows.push({
              caseId: item.id,
              title: item.title,
              fields: ['updatedAt'],
              ours: caseRow?.updatedAt ?? '',
              theirs: stored.syncedAt ?? 'ніколи не синхронізовано',
            });
          }
          continue;
        }

        const current = caseSyncHash(item, mapping);
        if (stored.syncHash === current) continue;
        rows.push({
          caseId: item.id,
          title: item.title,
          fields: stored.syncHash ? ['заголовок або перевірки'] : ['ніколи не синхронізовано'],
          ours: current,
          theirs: stored.syncHash ?? '—',
        });
      }

      res.json(rows);
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/export/testrail.csv', async (req, res) => {
    try {
      const projectId = requireProjectId(req);
      const mapping = requireMapping(String(req.query.mappingId ?? ''));
      const cases = exportCases(projectId, { filter: filterFromQuery(req) as CaseFilter });
      const mod = await loadModule<TestrailCsvModule>(INTEGRATIONS.testrailCsv, 'src/integrations/testrail-csv.ts');
      const csv = mod.buildTestrailCsv(cases, mapping);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="testrail-${projectId}.csv"`);
      res.send(csv);
    } catch (error) {
      fail(res, error, 502);
    }
  });

  router.get('/export/testrail.xml', async (req, res) => {
    try {
      const projectId = requireProjectId(req);
      const mapping = requireMapping(String(req.query.mappingId ?? ''));
      const cases = exportCases(projectId, { filter: filterFromQuery(req) as CaseFilter });
      const mod = await loadModule<TestrailXmlModule>(INTEGRATIONS.testrailXml, 'src/integrations/testrail-xml.ts');
      const xml = mod.buildTestrailXml(cases, mapping);
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="testrail-${projectId}.xml"`);
      res.send(xml);
    } catch (error) {
      fail(res, error, 502);
    }
  });

  /* ───────────────────────────── дашборд ─────────────────────────────── */

  router.get('/dashboard', (req, res) => {
    try {
      res.json(dashboard(requireProjectId(req)));
    } catch (error) {
      fail(res, error);
    }
  });

  /* ──────────────────────── діагностика інтеграцій ───────────────────── */

  /**
   * Стан усіх зовнішніх залежностей по ролях.
   *
   * Модель у Jules налаштовується трьома різними адресами (виконання, планування,
   * критик), і коли одна з них лежить, скіл падає з загальним «модель недоступна».
   * Цей маршрут показує, яка саме адреса не відповідає.
   */
  router.get('/integrations/health', async (_req, res) => {
    const roles: Array<{ role: string; label: string; baseUrl?: string; model?: string; key?: string }> = [
      {
        role: 'execution',
        label: 'Виконання сценаріїв (Midscene)',
        baseUrl: process.env.MIDSCENE_MODEL_BASE_URL,
        model: process.env.MIDSCENE_MODEL_NAME,
        key: process.env.MIDSCENE_MODEL_API_KEY,
      },
      {
        role: 'planning',
        label: 'Генерація кейсів (planner)',
        baseUrl: process.env.PLANNER_MODEL_BASE_URL ?? process.env.MIDSCENE_MODEL_BASE_URL,
        model: process.env.PLANNER_MODEL_NAME ?? process.env.MIDSCENE_MODEL_NAME,
        key: process.env.PLANNER_MODEL_API_KEY ?? process.env.MIDSCENE_MODEL_API_KEY,
      },
      {
        role: 'critic',
        label: 'Перевірка згенерованого (critic)',
        baseUrl: process.env.CRITIC_MODEL_BASE_URL ?? process.env.MIDSCENE_MODEL_BASE_URL,
        model: process.env.CRITIC_MODEL_NAME ?? process.env.MIDSCENE_MODEL_NAME,
        key: process.env.CRITIC_MODEL_API_KEY ?? process.env.MIDSCENE_MODEL_API_KEY,
      },
    ];

    const models = await Promise.all(
      roles.map(async (role) => {
        if (!role.baseUrl) {
          return { role: role.role, label: role.label, configured: false, ok: false, error: 'адресу не задано' };
        }
        const started = Date.now();
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8_000);
          const response = await fetch(`${role.baseUrl.replace(/\/$/, '')}/models`, {
            headers: role.key ? { Authorization: `Bearer ${role.key}` } : {},
            signal: controller.signal,
          });
          clearTimeout(timer);
          const payload = (await response.json().catch(() => ({}))) as { data?: Array<{ id?: string }> };
          const available = (payload.data ?? []).map((entry) => entry.id).filter(Boolean) as string[];
          return {
            role: role.role,
            label: role.label,
            configured: true,
            baseUrl: role.baseUrl,
            model: role.model,
            ok: response.ok,
            status: response.status,
            durationMs: Date.now() - started,
            // Найчастіша прихована помилка: адреса жива, але моделі з .env там немає.
            modelAvailable: role.model ? available.includes(role.model) : undefined,
            models: available.slice(0, 20),
            ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
          };
        } catch (error) {
          const cause = (error as { cause?: { code?: string } })?.cause?.code;
          return {
            role: role.role,
            label: role.label,
            configured: true,
            baseUrl: role.baseUrl,
            model: role.model,
            ok: false,
            durationMs: Date.now() - started,
            error: cause ?? (error instanceof Error ? error.message : 'невідома помилка'),
          };
        }
      }),
    );

    let confluence = { configured: false };
    let testrail = { configured: false };
    try {
      const mod = await loadModule<ConfluenceModule>(INTEGRATIONS.confluence, 'src/integrations/confluence.ts');
      confluence = { configured: mod.isConfluenceConfigured() };
    } catch {
      /* модуль недоступний — лишаємо configured: false */
    }
    try {
      const mod = await loadModule<TestrailApiModule>(INTEGRATIONS.testrailApi, 'src/integrations/testrail-api.ts');
      testrail = { configured: mod.isTestrailConfigured() };
    } catch {
      /* те саме */
    }

    res.json({
      models,
      confluence: { ...confluence, baseUrl: process.env.CONFLUENCE_BASE_URL },
      testrail: { ...testrail, baseUrl: process.env.TESTRAIL_BASE_URL },
      registry: { db: process.env.REGISTRY_DB ?? 'data/registry.db', node: process.versions.node },
    });
  });

  return router;
}

/** Блоки для скіла у формі, яку очікує контракт: `{ id, heading, text }`. */
function blocksForSkill(ids: readonly string[]): Array<{ id: string; heading: string; text: string }> {
  return getBlocksByIds(ids).map((block) => ({
    id: block.id,
    heading: block.heading,
    text: block.text,
  }));
}
