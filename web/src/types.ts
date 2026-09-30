/**
 * ⚠️ ДЗЕРКАЛО `src/registry/types.ts` — тримати синхронно вручну.
 *
 * Веб не імпортує серверні типи напряму: там zod і Node-залежності, а тут
 * потрібні лише форми даних. Якщо змінюється `src/registry/types.ts`
 * (або `docs/registry-api.md`) — правити цей файл у тій самій зміні.
 *
 * Правила відповідності:
 *   - `z.enum([...])` → union строкових літералів;
 *   - поля з `.default(...)` на сервері приходять завжди → тут не optional;
 *   - поля з `.optional()` → `?`.
 */

/* ────────────────────────────── перелічення ───────────────────────────── */

export const CASE_KINDS = ['positive', 'negative', 'neutral', 'security', 'a11y', 'performance'] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

export const CASE_PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type CasePriority = (typeof CASE_PRIORITIES)[number];

export const CASE_STATUSES = ['draft', 'in_review', 'approved', 'deprecated'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const AUTOMATION_STATUSES = ['manual', 'candidate', 'automated', 'quarantined'] as const;
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

export const SOURCE_KINDS = ['confluence', 'file', 'paste'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const COVERAGE_KINDS = ['quote', 'derived'] as const;
export type CoverageKind = (typeof COVERAGE_KINDS)[number];

export const RUN_KINDS = ['manual', 'auto', 'mixed'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const RUN_STATES = ['open', 'completed', 'cancelled'] as const;
export type RunState = (typeof RUN_STATES)[number];

export const ITEM_STATUSES = ['untested', 'passed', 'failed', 'blocked', 'skipped'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const PROPOSAL_KINDS = [
  'case_create',
  'case_update',
  'case_delete',
  'bulk_edit',
  'locator_update',
] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export const PROPOSAL_STATES = ['pending', 'approved', 'rejected'] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];

export const DEFECT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type DefectSeverity = (typeof DEFECT_SEVERITIES)[number];

export const DEFECT_STATUSES = ['open', 'triaged', 'fixed', 'wontfix', 'duplicate'] as const;
export type DefectStatus = (typeof DEFECT_STATUSES)[number];

export const SKILL_NAMES = ['write-cases', 'validate-coverage', 'format-export'] as const;
export type SkillName = (typeof SKILL_NAMES)[number];

export const BULK_TEXT_FIELDS = ['title', 'checks', 'preconditions', 'steps'] as const;
export type BulkTextField = (typeof BULK_TEXT_FIELDS)[number];

/* ─────────────────────────────── проєкт ───────────────────────────────── */

export interface Project {
  id: string;
  key: string;
  name: string;
  description: string;
  baseUrl?: string;
  confluenceSpace?: string;
  testrailProjectId?: number;
  testrailSuiteId?: number;
  createdAt: string;
  updatedAt: string;
}

export type ProjectInput = Partial<Pick<Project, 'id' | 'description'>> &
  Pick<Project, 'key' | 'name'> &
  Partial<Pick<Project, 'baseUrl' | 'confluenceSpace' | 'testrailProjectId' | 'testrailSuiteId'>>;

/* ─────────────────────────── секція (модуль) ──────────────────────────── */

export interface Section {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
  code: string;
  position: number;
  testrailSectionId?: number;
  createdAt: string;
  updatedAt: string;
}

export interface SectionNode extends Section {
  path: string;
  caseCount: number;
  caseCountDeep: number;
  children: SectionNode[];
}

export interface SectionInput {
  projectId: string;
  name: string;
  parentId?: string | null;
  code?: string;
  position?: number;
}

/* ──────────────────────────────── кейс ───────────────────────────────── */

export interface CaseStep {
  action: string;
  expected: string;
}

export interface CaseAutomation {
  status: AutomationStatus;
  scenarioPath?: string;
  lastAutoRunId?: string;
  lastAutoStatus?: 'passed' | 'failed' | 'cancelled' | 'running';
  lastAutoAt?: string;
  flakeScore?: number;
  quarantineReason?: string;
}

export interface CaseTestrail {
  caseId?: number;
  sectionId?: number;
  syncedAt?: string;
  syncHash?: string;
}

export interface Case {
  id: string;
  projectId: string;
  sectionId: string;
  title: string;
  kind: CaseKind;
  priority: CasePriority;
  status: CaseStatus;
  preconditions: string;
  checks: string[];
  steps: CaseStep[];
  tags: string[];
  owner?: string;
  automation: CaseAutomation;
  testrail: CaseTestrail;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
}

export type CaseInput = Partial<Omit<Case, 'id' | 'projectId' | 'version' | 'createdAt' | 'updatedAt'>> &
  Pick<Case, 'sectionId' | 'title'>;

export interface CaseListItem extends Case {
  sectionPath: string;
  coverage: { quote: number; derived: number };
  lastResult?: { status: ItemStatus; at: string; runId: string };
}

/** `GET /cases/:id` — кейс із похідними полями. */
export interface CaseDetail extends CaseListItem {}

/* ─────────────────────── ревізії (історія кейса) ──────────────────────── */

export type PatchMap = Record<string, { before: unknown; after: unknown }>;

export interface Revision {
  id: string;
  caseId: string;
  version: number;
  at: string;
  author: string;
  reason: string;
  patch: PatchMap;
}

/* ──────────────────── джерела вимог і блоки тексту ────────────────────── */

export interface Source {
  id: string;
  projectId: string;
  kind: SourceKind;
  title: string;
  url?: string;
  externalId?: string;
  externalVersion?: string;
  contentHash: string;
  importedAt: string;
  updatedAt: string;
  /** Похідні лічильники в `GET /sources` (контракт: «з кількістю блоків і прогалин»). */
  blockCount?: number;
  gapCount?: number;
  /** Скільки блоків змінилось у джерелі після останнього `refresh` (не прапорець). */
  changed?: number;
}

export type BlockChangeState = 'same' | 'changed' | 'new' | 'removed';

export interface Block {
  id: string;
  sourceId: string;
  position: number;
  heading: string;
  anchor?: string;
  text: string;
  hash: string;
  changeState: BlockChangeState;
}

export interface Coverage {
  id: string;
  blockId: string;
  caseId: string;
  kind: CoverageKind;
  confirmed: boolean;
  note: string;
  createdAt: string;
}

export interface CoverageRow {
  block: Block;
  cases: Array<{ caseId: string; title: string; kind: CoverageKind; confirmed: boolean }>;
  gap: boolean;
}

export interface CoverageStats {
  blocks: number;
  coveredBlocks: number;
  gaps: number;
  derivedShare: number;
  casesWithSource?: number;
}

export interface CoverageResponse {
  rows: CoverageRow[];
  stats: CoverageStats;
}

export interface SourceDetail extends Source {
  blocks: Block[];
}

export interface SourceImportResult {
  source: Source;
  blocks: Block[];
}

export interface SourceRefreshResult {
  changed: number;
  added: number;
  removed: number;
  proposals: number;
}

/* ──────────────────── черга апрувів (proposals) ───────────────────────── */

export interface ProposalOrigin {
  skill?: SkillName;
  skillRunId?: string;
  blockId?: string;
  sourceId?: string;
  runId?: string;
  caseId?: string;
}

export interface Proposal {
  id: string;
  projectId: string;
  kind: ProposalKind;
  state: ProposalState;
  title: string;
  rationale: string;
  payload: unknown;
  diff: PatchMap;
  origin: ProposalOrigin;
  coverageKind?: CoverageKind;
  reviewer?: string;
  note: string;
  createdAt: string;
  decidedAt?: string;
  /** Необов'язкове: сервер може докласти текст блоку вимоги для показу цитати. */
  blockText?: string;
  blockHeading?: string;
}

/** Форма `payload` для `kind='case_create'`. */
export interface ProposalCasePayload {
  sectionId?: string;
  title?: string;
  kind?: CaseKind;
  priority?: CasePriority;
  preconditions?: string;
  checks?: string[];
  tags?: string[];
  [k: string]: unknown;
}

export interface ApproveResult {
  approved: number;
  created: number;
  updated: number;
  errors: Array<{ id: string; error: string }>;
}

export interface RejectResult {
  rejected: number;
  errors?: Array<{ id: string; error: string }>;
}

/* ───────────────────── вибірки (заміна «наборів») ─────────────────────── */

export interface CaseFilter {
  sectionIds?: string[];
  includeSubsections?: boolean;
  tags?: string[];
  kinds?: CaseKind[];
  priorities?: CasePriority[];
  statuses?: CaseStatus[];
  automation?: AutomationStatus[];
  q?: string;
}

export interface Selection {
  id: string;
  projectId: string;
  name: string;
  description: string;
  mode: 'static' | 'filter';
  caseIds: string[];
  filter?: CaseFilter;
  stopOnFailure: boolean;
  createdAt: string;
  updatedAt: string;
}

/* ───────────────────────── прогони і результати ───────────────────────── */

export interface RunSummary {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  untested: number;
}

export interface RunEnv {
  baseUrl?: string;
  /**
   * `true` — адресу задали саме для цього прогону, тож вона перекриває ціль
   * кожного сценарію. Успадкована від проєкту адреса цього не робить, і
   * показувати її як «куди йшов прогін» не можна.
   */
  baseUrlPinned?: boolean;
  mode?: 'warm-up' | 'regression';
  label?: string;
}

export interface RegistryRun {
  id: string;
  projectId: string;
  kind: RunKind;
  title: string;
  selectionId?: string;
  env: RunEnv;
  state: RunState;
  executor?: string;
  startedAt: string;
  finishedAt?: string;
  summary: RunSummary;
  note: string;
}

export interface RunItem {
  id: string;
  runId: string;
  caseId: string;
  position: number;
  status: ItemStatus;
  comment: string;
  evidence: string[];
  defectId?: string;
  autoRunId?: string;
  durationMs?: number;
  updatedAt: string;
  updatedBy?: string;
}

export type RunItemCase = Pick<
  Case,
  'id' | 'title' | 'kind' | 'priority' | 'checks' | 'preconditions' | 'automation'
> & { sectionPath: string };

export interface RunDetail extends RegistryRun {
  items: Array<RunItem & { case: RunItemCase }>;
}

export interface RunCreateInput {
  projectId: string;
  kind: RunKind;
  title?: string;
  selectionId?: string;
  caseIds?: string[];
  env?: RunEnv;
}

export interface RunItemInput {
  status: ItemStatus;
  comment?: string;
  evidence?: string[];
  defect?: { title: string; severity: DefectSeverity };
}

/* ──────────────────────────────── дефекти ────────────────────────────── */

export interface Defect {
  id: string;
  projectId: string;
  title: string;
  details: string;
  severity: DefectSeverity;
  status: DefectStatus;
  caseId?: string;
  runItemId?: string;
  dedupKey: string;
  seenCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  externalKey?: string;
  externalUrl?: string;
}

/* ───────────────────── запуски AI-скілів (лог і вартість) ─────────────── */

export interface SkillRun {
  id: string;
  projectId: string;
  skill: SkillName;
  state: 'running' | 'done' | 'failed';
  input: unknown;
  output?: unknown;
  model?: string;
  proposalCount: number;
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface WriteCasesResult {
  skillRun: SkillRun;
  proposals: Proposal[];
}

export interface ValidateCoverageResult {
  skillRun: SkillRun;
  report: {
    gaps: Array<{ blockId: string; heading?: string; text?: string; reason?: string }>;
    duplicates: Array<{ caseIds: string[]; reason?: string }>;
    untestable: Array<{ blockId: string; reason?: string }>;
    contradictions: Array<{ blockIds?: string[]; reason?: string }>;
  };
  proposals: Proposal[];
}

export interface FormatExportResult {
  skillRun: SkillRun;
  preview: unknown;
  fileUrl?: string;
}

/* ─────────────────────── профіль мапінгу TestRail ────────────────────── */

export interface TestrailMapping {
  id: string;
  projectId: string;
  name: string;
  template: 'checklist' | 'steps_separated';
  fields: Record<string, string>;
  typeMap: Record<string, number>;
  priorityMap: Record<string, number>;
  idField: string;
  delimiter: string;
  createdAt: string;
  updatedAt: string;
}

/** Діагностика зовнішніх залежностей: `GET /api/registry/integrations/health`. */
export interface ModelRoleHealth {
  role: 'execution' | 'planning' | 'critic';
  label: string;
  configured: boolean;
  ok: boolean;
  baseUrl?: string;
  model?: string;
  status?: number;
  durationMs?: number;
  modelAvailable?: boolean;
  models?: string[];
  error?: string;
}

export interface IntegrationsHealth {
  models: ModelRoleHealth[];
  confluence: { configured: boolean; baseUrl?: string };
  testrail: { configured: boolean; baseUrl?: string };
  registry: { db: string; node: string };
}

export interface TestrailDriftRow {
  caseId: string;
  title?: string;
  ours: unknown;
  theirs: unknown;
  fields: string[];
}

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
  flaky: Array<{ caseId: string; title: string; flakeScore: number; lastResult?: ItemStatus }>;
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

export type BulkOp =
  | {
      op: 'replace-text';
      find: string;
      replace: string;
      fields: BulkTextField[];
      regex: boolean;
      caseSensitive: boolean;
    }
  | { op: 'set-field'; field: 'kind' | 'priority' | 'status' | 'owner'; value: string }
  | { op: 'add-tag'; tags: string[] }
  | { op: 'remove-tag'; tags: string[] }
  | { op: 'move'; sectionId: string }
  | { op: 'set-automation'; status: AutomationStatus }
  | { op: 'delete'; hard: boolean };

export interface BulkRequest {
  projectId: string;
  caseIds?: string[];
  filter?: CaseFilter;
  operation: BulkOp;
  dryRun: boolean;
  reason?: string;
  author?: string;
}

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
  batchId?: string;
}

/* ─────────────── старий світ рушія (потрібен для логів автопрогону) ──── */

export interface LegacyRunStepResult {
  index: number;
  kind: 'step' | 'assertion';
  instruction: string;
  status: 'passed' | 'failed' | 'healed' | 'skipped';
  attempts: number;
  healed: boolean;
  handledBy: string;
  durationMs: number;
  /** Скільки звернень до моделі забрав крок; `undefined` — невідомо. */
  modelCalls?: number;
  error?: string;
  errorClass?: string;
  thought?: string;
}

/** Дефект, який рушій вивів із проваленої перевірки. */
export interface LegacyBugReport {
  id: string;
  assertion: string;
  severity: 'low' | 'medium' | 'high';
  thought?: string;
  rootCauseHypothesis?: string;
  /** `unconfirmed` — вердикт без пояснення або спростований подальшими кроками. */
  confidence?: 'confirmed' | 'unconfirmed';
  checkpointAfterStep?: number;
  contradictedBy?: string;
  reportPath?: string;
}

export interface LegacyRun {
  id: string;
  status: string;
  qaTargetUrl: string;
  qaScenarioPath: string;
  qaMode: string;
  scenarioName?: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  errorSummary?: string;
  hitlReason?: string;
  active: boolean;
  logs: string[];
  /** Момент постановки в чергу: `startedAt` — це вже реальний старт. */
  queuedAt?: string;
  /** Витіснена адреса: ціль сценарію або глобальний дефолт, що програли вибір. */
  requestedTargetUrl?: string;
  stepResults?: LegacyRunStepResult[];
  evidence?: {
    summary?: {
      total: number;
      passed: number;
      failed: number;
      healed: number;
      skipped?: number;
      modelCalls?: number;
    };
    bugReports?: LegacyBugReport[];
    generatedSpec?: string;
  };
  reportPaths?: {
    aggregate?: string;
    playwright?: string;
    midscene?: string[];
    videos?: string[];
    plans?: string[];
  };
}

export interface LegacyScenarioMeta {
  path: string;
  name: string;
  goal: string;
  targetUrl?: string;
  tags?: string[];
  group?: string;
  updatedAt?: string;
}

export interface LegacySettings {
  qaTargetUrl: string;
  qaMode: 'warm-up' | 'regression';
  qaScenarioPath: string;
  debugCache: boolean;
  llmBaseUrl?: string;
  llmModelName?: string;
}

export interface LlmCheck {
  ok: boolean;
  models?: string[];
  error?: string;
}
