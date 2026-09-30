/**
 * Контракт реєстру тест-кейсів.
 *
 * Це єдине джерело істини для схем даних: сервер, сховище, скіли й UI
 * спираються на ці типи. Усі сутності зберігаються в SQLite
 * (`data/registry.db`), але форма об'єктів у API така сама, як тут.
 *
 * Цикл, який обслуговує реєстр:
 *   документація (source → block) → кейс (case) → верифікація (proposal)
 *   → автоматизація (case.automation + scenarioPath) → прогін (run → runItem)
 *   → дашборд (агрегати) → назад у кейс (історія, flakeScore).
 */
import { z } from 'zod';

/* ────────────────────────────── перелічення ───────────────────────────── */

export const caseKindSchema = z.enum([
  'positive',
  'negative',
  'neutral',
  'security',
  'a11y',
  'performance',
]);
export type CaseKind = z.infer<typeof caseKindSchema>;

export const casePrioritySchema = z.enum(['P1', 'P2', 'P3', 'P4']);
export type CasePriority = z.infer<typeof casePrioritySchema>;

export const caseStatusSchema = z.enum(['draft', 'in_review', 'approved', 'deprecated']);
export type CaseStatus = z.infer<typeof caseStatusSchema>;

/** Стан автоматизації кейса. `quarantined` — нестабільний автотест, виключений із наборів. */
export const automationStatusSchema = z.enum(['manual', 'candidate', 'automated', 'quarantined']);
export type AutomationStatus = z.infer<typeof automationStatusSchema>;

export const sourceKindSchema = z.enum(['confluence', 'file', 'paste']);
export type SourceKind = z.infer<typeof sourceKindSchema>;

/** `quote` — кейс прямо покриває текст вимоги; `derived` — домисел AI (негативні, безпекові тощо). */
export const coverageKindSchema = z.enum(['quote', 'derived']);
export type CoverageKind = z.infer<typeof coverageKindSchema>;

export const runKindSchema = z.enum(['manual', 'auto', 'mixed']);
export type RunKind = z.infer<typeof runKindSchema>;

export const runStateSchema = z.enum(['open', 'completed', 'cancelled']);
export type RunState = z.infer<typeof runStateSchema>;

export const itemStatusSchema = z.enum(['untested', 'passed', 'failed', 'blocked', 'skipped']);
export type ItemStatus = z.infer<typeof itemStatusSchema>;

export const proposalKindSchema = z.enum([
  'case_create',
  'case_update',
  'case_delete',
  'bulk_edit',
  'locator_update',
]);
export type ProposalKind = z.infer<typeof proposalKindSchema>;

export const proposalStateSchema = z.enum(['pending', 'approved', 'rejected']);
export type ProposalState = z.infer<typeof proposalStateSchema>;

export const defectSeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export const defectStatusSchema = z.enum(['open', 'triaged', 'fixed', 'wontfix', 'duplicate']);

export const skillNameSchema = z.enum(['write-cases', 'validate-coverage', 'format-export']);
export type SkillName = z.infer<typeof skillNameSchema>;

/* ─────────────────────────────── проєкт ───────────────────────────────── */

export const projectSchema = z.object({
  /** Слаг-ідентифікатор, латиниця: `cyber`. */
  id: z.string().min(1),
  /** Префікс для ID кейсів, великими: `CYBER`. */
  key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/),
  name: z.string().min(1),
  description: z.string().default(''),
  /** Базовий URL застосунку під тест — дефолт для прогонів. */
  baseUrl: z.string().url().optional(),
  confluenceSpace: z.string().optional(),
  testrailProjectId: z.number().int().positive().optional(),
  testrailSuiteId: z.number().int().positive().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof projectSchema>;
export const projectInputSchema = projectSchema
  .omit({ createdAt: true, updatedAt: true })
  .partial({ id: true, description: true });
export type ProjectInput = z.infer<typeof projectInputSchema>;

/* ─────────────────────────── секція (модуль) ──────────────────────────── */

export const sectionSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  parentId: z.string().nullable().default(null),
  name: z.string().min(1),
  /** Короткий код для ID кейсів: `REG`. Унікальний у межах проєкту. */
  code: z.string().regex(/^[A-Z][A-Z0-9]{1,7}$/),
  position: z.number().int().nonnegative().default(0),
  testrailSectionId: z.number().int().positive().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Section = z.infer<typeof sectionSchema>;
export const sectionInputSchema = sectionSchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .partial({ code: true, position: true, parentId: true });
export type SectionInput = z.infer<typeof sectionInputSchema>;

/** Вузол дерева з лічильниками — те, що віддає `GET /api/registry/sections`. */
export interface SectionNode extends Section {
  path: string;
  /** Кейси безпосередньо в цій секції. */
  caseCount: number;
  /** Кейси в цій секції та всіх дочірніх. */
  caseCountDeep: number;
  children: SectionNode[];
}

/* ──────────────────────────────── кейс ───────────────────────────────── */

/** Класичний шаблон «крок → очікуваний результат». Використовується, коли команді треба детальніше за чек-лист. */
export const caseStepSchema = z.object({
  action: z.string().min(1),
  expected: z.string().default(''),
});
export type CaseStep = z.infer<typeof caseStepSchema>;

export const caseAutomationSchema = z.object({
  status: automationStatusSchema.default('manual'),
  /** Шлях YAML-сценарію рушія, напр. `scenarios/appl-submit.yaml`. */
  scenarioPath: z.string().optional(),
  /** ID останнього прогону рушія (`data/runs/<uuid>.json`). */
  lastAutoRunId: z.string().optional(),
  lastAutoStatus: z.enum(['passed', 'failed', 'cancelled', 'running']).optional(),
  lastAutoAt: z.string().optional(),
  /** 0..1 — частка падінь/лікувань за останні прогони. Рахує дашборд. */
  flakeScore: z.number().min(0).max(1).optional(),
  /** Причина карантину, якщо `status === 'quarantined'`. */
  quarantineReason: z.string().optional(),
});
export type CaseAutomation = z.infer<typeof caseAutomationSchema>;

export const caseTestrailSchema = z.object({
  caseId: z.number().int().positive().optional(),
  sectionId: z.number().int().positive().optional(),
  syncedAt: z.string().optional(),
  /** Хеш полів на момент синхронізації — для виявлення дрейфу. */
  syncHash: z.string().optional(),
});
export type CaseTestrail = z.infer<typeof caseTestrailSchema>;

export const caseSchema = z.object({
  /** Стабільний людський ID: `CYBER-REG-014`. Не змінюється при перейменуванні чи переміщенні. */
  id: z.string().regex(/^[A-Z][A-Z0-9]{1,9}-[A-Z][A-Z0-9]{1,7}-\d{3,}$/),
  projectId: z.string().min(1),
  sectionId: z.string().min(1),
  title: z.string().min(1),
  kind: caseKindSchema.default('positive'),
  priority: casePrioritySchema.default('P2'),
  status: caseStatusSchema.default('draft'),
  preconditions: z.string().default(''),
  /** Основний шаблон команди: чек-лист перевірок. */
  checks: z.array(z.string().min(1)).default([]),
  /** Опційний класичний шаблон. Якщо заповнений — експортується як steps_separated. */
  steps: z.array(caseStepSchema).default([]),
  tags: z.array(z.string().min(1)).default([]),
  owner: z.string().optional(),
  automation: caseAutomationSchema.default({ status: 'manual' }),
  testrail: caseTestrailSchema.default({}),
  /** Інкрементується на кожну збережену зміну; кожна зміна дає `revision`. */
  version: z.number().int().positive().default(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string().optional(),
  updatedBy: z.string().optional(),
});
export type Case = z.infer<typeof caseSchema>;

/** Тіло для створення/оновлення кейса через API. ID і версію проставляє сервер. */
export const caseInputSchema = caseSchema
  .omit({ id: true, version: true, createdAt: true, updatedAt: true, projectId: true })
  .partial({
    kind: true,
    priority: true,
    status: true,
    preconditions: true,
    checks: true,
    steps: true,
    tags: true,
    owner: true,
    automation: true,
    testrail: true,
    createdBy: true,
    updatedBy: true,
  });
export type CaseInput = z.infer<typeof caseInputSchema>;

/** Кейс із похідними полями для списку: шлях секції, покриття, останній результат. */
export interface CaseListItem extends Case {
  sectionPath: string;
  coverage: { quote: number; derived: number };
  lastResult?: { status: ItemStatus; at: string; runId: string };
}

/* ─────────────────────── ревізії (історія кейса) ──────────────────────── */

export const revisionSchema = z.object({
  id: z.string().min(1),
  caseId: z.string().min(1),
  version: z.number().int().positive(),
  at: z.string(),
  author: z.string().default('system'),
  /** Чому змінилось: «write-cases за блоком 4», «масова заміна акти→договір», «правка вручну». */
  reason: z.string().default(''),
  /** Змінені поля: before/after лише для того, що справді змінилось. */
  patch: z.record(z.string(), z.object({ before: z.unknown(), after: z.unknown() })).default({}),
});
export type Revision = z.infer<typeof revisionSchema>;

/* ──────────────────── джерела вимог і блоки тексту ────────────────────── */

export const sourceSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  kind: sourceKindSchema,
  title: z.string().min(1),
  url: z.string().optional(),
  /** Для Confluence: ID сторінки і версія, щоб бачити оновлення. */
  externalId: z.string().optional(),
  externalVersion: z.string().optional(),
  /** Хеш усього тексту — швидка перевірка «чи змінилось». */
  contentHash: z.string(),
  importedAt: z.string(),
  updatedAt: z.string(),
});
export type Source = z.infer<typeof sourceSchema>;

export const blockSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  position: z.number().int().nonnegative(),
  /** Заголовок розділу документа, якщо є. */
  heading: z.string().default(''),
  /** Anchor для посилання назад у Confluence. */
  anchor: z.string().optional(),
  text: z.string().min(1),
  /** Хеш тексту блоку — основа для «що змінилось у вимогах». */
  hash: z.string(),
  /** Стан блоку після переімпорту: `same` | `changed` | `new` | `removed`. */
  changeState: z.enum(['same', 'changed', 'new', 'removed']).default('new'),
});
export type Block = z.infer<typeof blockSchema>;

export const coverageSchema = z.object({
  id: z.string().min(1),
  blockId: z.string().min(1),
  caseId: z.string().min(1),
  kind: coverageKindSchema.default('quote'),
  /** Підтвердив інженер (а не лише AI). */
  confirmed: z.boolean().default(false),
  note: z.string().default(''),
  createdAt: z.string(),
});
export type Coverage = z.infer<typeof coverageSchema>;

/** Рядок матриці покриття для екрана «Покриття». */
export interface CoverageRow {
  block: Block;
  cases: Array<{ caseId: string; title: string; kind: CoverageKind; confirmed: boolean }>;
  /** Блок без жодного кейса — прогалина. */
  gap: boolean;
}

/* ──────────────────── черга апрувів (proposals) ───────────────────────── */

export const proposalSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  kind: proposalKindSchema,
  state: proposalStateSchema.default('pending'),
  title: z.string().min(1),
  /** Коротке пояснення, чому AI це пропонує. */
  rationale: z.string().default(''),
  /** Для `case_create` — CaseInput; для `case_update` — {caseId, changes}; для `bulk_edit` — операція; для `locator_update` — {caseId, scenarioPath, before, after}. */
  payload: z.unknown(),
  /** Готовий до показу diff: поле → before/after. */
  diff: z.record(z.string(), z.object({ before: z.unknown(), after: z.unknown() })).default({}),
  /** Звідки взялося: скіл, блок вимоги, прогін. */
  origin: z
    .object({
      skill: skillNameSchema.optional(),
      skillRunId: z.string().optional(),
      blockId: z.string().optional(),
      sourceId: z.string().optional(),
      runId: z.string().optional(),
      caseId: z.string().optional(),
    })
    .default({}),
  /** `derived` позначає домисел AI, якого немає у вимозі. */
  coverageKind: coverageKindSchema.optional(),
  reviewer: z.string().optional(),
  note: z.string().default(''),
  createdAt: z.string(),
  decidedAt: z.string().optional(),
});
export type Proposal = z.infer<typeof proposalSchema>;

/* ───────────────────── вибірки (заміна «наборів») ─────────────────────── */

export const caseFilterSchema = z.object({
  sectionIds: z.array(z.string()).optional(),
  includeSubsections: z.boolean().default(true),
  tags: z.array(z.string()).optional(),
  kinds: z.array(caseKindSchema).optional(),
  priorities: z.array(casePrioritySchema).optional(),
  statuses: z.array(caseStatusSchema).optional(),
  automation: z.array(automationStatusSchema).optional(),
  q: z.string().optional(),
});
export type CaseFilter = z.infer<typeof caseFilterSchema>;

export const selectionSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  mode: z.enum(['static', 'filter']).default('filter'),
  /** Для `static` — упорядкований список ID кейсів. */
  caseIds: z.array(z.string()).default([]),
  /** Для `filter` — збережений фільтр. */
  filter: caseFilterSchema.optional(),
  stopOnFailure: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Selection = z.infer<typeof selectionSchema>;
export const selectionInputSchema = selectionSchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .partial({ description: true, caseIds: true, filter: true, stopOnFailure: true, mode: true });

/* ───────────────────────── прогони і результати ───────────────────────── */

export const runSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  untested: z.number().int().nonnegative(),
});
export type RunSummary = z.infer<typeof runSummarySchema>;

export const registryRunSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  kind: runKindSchema,
  title: z.string().min(1),
  selectionId: z.string().optional(),
  /** Середовище прогону: URL і режим рушія для авточастини. */
  env: z
    .object({
      baseUrl: z.string().optional(),
      /**
       * `true` — URL задали саме для цього прогону, тож він перекриває
       * `target_url` сценарію (прогін на стейджі). Успадкований дефолт проєкту
       * не закріплюється: він лише підстраховує сценарії без власної цілі.
       */
      baseUrlPinned: z.boolean().optional(),
      mode: z.enum(['warm-up', 'regression']).optional(),
      label: z.string().optional(),
    })
    .default({}),
  state: runStateSchema.default('open'),
  executor: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  summary: runSummarySchema,
  note: z.string().default(''),
});
export type RegistryRun = z.infer<typeof registryRunSchema>;

export const runItemSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  caseId: z.string().min(1),
  position: z.number().int().nonnegative().default(0),
  status: itemStatusSchema.default('untested'),
  comment: z.string().default(''),
  /** Шляхи доказів: скріни, відео, посилання на звіти рушія. */
  evidence: z.array(z.string()).default([]),
  defectId: z.string().optional(),
  /** Якщо кейс проходив автотест — ID прогону рушія. */
  autoRunId: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  updatedAt: z.string(),
  updatedBy: z.string().optional(),
});
export type RunItem = z.infer<typeof runItemSchema>;

/** Прогін із кейсами — те, що віддає `GET /api/registry/runs/:id`. */
export interface RunDetail extends RegistryRun {
  items: Array<
    RunItem & {
      case: Pick<Case, 'id' | 'title' | 'kind' | 'priority' | 'checks' | 'preconditions' | 'automation'> & {
        sectionPath: string;
      };
    }
  >;
}

/* ──────────────────────────────── дефекти ────────────────────────────── */

export const defectSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  details: z.string().default(''),
  severity: defectSeveritySchema.default('medium'),
  status: defectStatusSchema.default('open'),
  caseId: z.string().optional(),
  runItemId: z.string().optional(),
  /** Ключ дедуплікації: той самий дефект не множиться на кожному прогоні. */
  dedupKey: z.string(),
  seenCount: z.number().int().positive().default(1),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  externalKey: z.string().optional(),
  externalUrl: z.string().optional(),
});
export type Defect = z.infer<typeof defectSchema>;

/* ───────────────────── запуски AI-скілів (лог і вартість) ─────────────── */

export const skillRunSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  skill: skillNameSchema,
  state: z.enum(['running', 'done', 'failed']).default('running'),
  input: z.unknown(),
  output: z.unknown().optional(),
  model: z.string().optional(),
  /** Скільки пропозицій створив запуск. */
  proposalCount: z.number().int().nonnegative().default(0),
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
});
export type SkillRun = z.infer<typeof skillRunSchema>;

/* ─────────────────────── профіль мапінгу TestRail ────────────────────── */

export const testrailMappingSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1),
  /** `checklist` — усі перевірки в одне текстове поле; `steps_separated` — окремими кроками. */
  template: z.enum(['checklist', 'steps_separated']).default('checklist'),
  /** Наше поле → назва колонки/поля TestRail. */
  fields: z.record(z.string(), z.string()).default({}),
  /** `kind` → `type_id`. */
  typeMap: z.record(z.string(), z.number().int()).default({}),
  /** `priority` → `priority_id`. */
  priorityMap: z.record(z.string(), z.number().int()).default({}),
  /** Кастомне поле, у яке кладемо наш ID для round-trip. */
  idField: z.string().default('custom_tc_id'),
  delimiter: z.string().default(','),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TestrailMapping = z.infer<typeof testrailMappingSchema>;

/* ───────────────────────── дашборд (агрегати) ────────────────────────── */

export interface DashboardData {
  project: Project;
  cases: {
    total: number;
    byStatus: Record<CaseStatus, number>;
    byAutomation: Record<AutomationStatus, number>;
    byPriority: Record<CasePriority, number>;
  };
  coverage: {
    blocks: number;
    coveredBlocks: number;
    gaps: number;
    derivedShare: number;
    casesWithSource: number;
  };
  runs: {
    last7d: number;
    last30d: number;
    passRate7d: number | null;
    open: number;
    recent: Array<Pick<RegistryRun, 'id' | 'title' | 'kind' | 'state' | 'startedAt' | 'summary'>>;
  };
  /** Топ нестабільних кейсів за flakeScore. */
  flaky: Array<{ caseId: string; title: string; flakeScore: number; lastResult?: ItemStatus }>;
  /** Зведення за модулями першого рівня. */
  modules: Array<{
    sectionId: string;
    name: string;
    cases: number;
    automated: number;
    passRate: number | null;
    gaps: number;
  }>;
  pending: { proposals: number; drift: number; openDefects: number };
}

/* ────────────────────────── службові типи API ────────────────────────── */

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

export const bulkOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('replace-text'),
    find: z.string().min(1),
    replace: z.string(),
    fields: z.array(z.enum(['title', 'checks', 'preconditions', 'steps'])).min(1),
    regex: z.boolean().default(false),
    caseSensitive: z.boolean().default(false),
  }),
  z.object({
    op: z.literal('set-field'),
    field: z.enum(['kind', 'priority', 'status', 'owner']),
    value: z.string(),
  }),
  z.object({ op: z.literal('add-tag'), tags: z.array(z.string().min(1)).min(1) }),
  z.object({ op: z.literal('remove-tag'), tags: z.array(z.string().min(1)).min(1) }),
  z.object({ op: z.literal('move'), sectionId: z.string().min(1) }),
  z.object({ op: z.literal('set-automation'), status: automationStatusSchema }),
  z.object({ op: z.literal('delete'), hard: z.boolean().default(false) }),
]);
export type BulkOp = z.infer<typeof bulkOpSchema>;

export const bulkRequestSchema = z.object({
  projectId: z.string().min(1),
  caseIds: z.array(z.string()).optional(),
  filter: caseFilterSchema.optional(),
  operation: bulkOpSchema,
  dryRun: z.boolean().default(true),
  reason: z.string().default(''),
  author: z.string().optional(),
});
export type BulkRequest = z.infer<typeof bulkRequestSchema>;

export interface BulkPreviewRow {
  caseId: string;
  title: string;
  field: string;
  before: string;
  after: string;
  occurrences: number;
}

export interface BulkResult {
  affected: number;
  occurrences: number;
  preview: BulkPreviewRow[];
  applied: boolean;
  /** Ідентифікатор пакета для відкату (`POST /api/registry/cases/bulk/undo`). */
  batchId?: string;
}
