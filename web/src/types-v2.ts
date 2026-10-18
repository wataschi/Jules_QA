/**
 * Типи Jules 2.0 («QA направляє, агент робить») — дзеркало `src/registry/types.ts`
 * і відповідей маршрутів `src/server/routes/{tasks,inputs,ingest,reports,access}.ts`.
 */
import type { CasePriority, CaseKind, CaseStatus, Page } from './types';

export interface ProjectSettings {
  confluenceRoots: string[];
  figmaFiles: string[];
  jira?: { projectKey: string; issueType: string; assignee?: string; createBugs: boolean };
  telegram: { chatId?: string; enabled: boolean };
  thresholds: { staleTaskHours: number; leaseMinutes: number; mutationP1: number; flakeScore: number };
  codeowners?: string;
  levels?: Record<string, string[]>;
  dashboardUrl?: string;
}

/* ─────────────────────────────── задачі ───────────────────────────────── */

export type TaskKind =
  | 'add_test'
  | 'change_test'
  | 'remove_test'
  | 'plan_module'
  | 'read_asset'
  | 'triage'
  | 'stabilize'
  | 'question';
export type TaskState = 'new' | 'queued' | 'claimed' | 'needs_info' | 'review' | 'failed' | 'done' | 'rejected';
export type ActorKind = 'qa' | 'system' | 'agent' | 'dev';

export interface TaskAnchor {
  caseId?: string;
  blockId?: string;
  sectionId?: string;
  sourceId?: string;
  assetId?: string;
  testId?: string;
  file?: string;
  runId?: string;
}

export interface TaskReport {
  summary: string;
  checks: string[];
  tests: Array<{ file: string; name: string; caseIds: string[] }>;
  prUrl?: string;
  branch?: string;
}

export interface Task {
  id: string;
  projectId: string;
  kind: TaskKind;
  state: TaskState;
  title: string;
  text: string;
  author: string;
  authorKind: ActorKind;
  anchor: TaskAnchor;
  sectionId?: string;
  owners: string[];
  priority: CasePriority;
  parentId?: string;
  leaseHolder?: string;
  leaseUntil?: string;
  attempts: number;
  branch?: string;
  prUrl?: string;
  prNumber?: number;
  report?: TaskReport;
  qaConfirmedBy?: string;
  qaConfirmedAt?: string;
  mergedAt?: string;
  queuedAt: string;
  doneAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskListItem extends Task {
  ageHours: number;
  sectionName?: string;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  at: string;
  author: string;
  authorKind: ActorKind;
  type: 'question' | 'answer' | 'interpretation' | 'status' | 'comment';
  text: string;
  data: Record<string, unknown>;
}

export interface AgentJob {
  id: string;
  taskId: string;
  holder: string;
  agent?: string;
  model?: string;
  given: Array<{ kind: string; id: string }>;
  branch?: string;
  prUrl?: string;
  outcome?: string;
  startedAt: string;
  finishedAt?: string;
}

export type ReadingState = 'none' | 'needed' | 'proposed' | 'approved' | 'rejected';

export interface AssetView {
  id: string;
  kind: 'image' | 'diagram' | 'frame';
  name: string;
  diagramType?: string;
  text: string;
  readingState: ReadingState;
  fileUrl?: string;
}

export interface RequirementView {
  blockId: string;
  sourceId: string;
  sourceTitle: string;
  sourceKind: 'confluence' | 'figma' | 'file' | 'paste';
  url?: string;
  heading: string;
  text: string;
  changeState: 'same' | 'changed' | 'new' | 'removed';
  withheld: boolean;
  assets: AssetView[];
  screens: string[];
  nodeId?: string;
  route?: string;
}

export interface CodeTest {
  id: string;
  projectId: string;
  testKey: string;
  file: string;
  name: string;
  fullName: string;
  level: 'unit' | 'integration' | 'e2e' | 'visual';
  framework: string;
  author: 'agent' | 'human';
  state: 'active' | 'skipped' | 'quarantined' | 'removed';
  onMain: boolean;
  caseIds: string[];
  firstSeenSha?: string;
  lastSeenSha?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastResult?: { status: 'passed' | 'failed' | 'skipped'; at: string; sha?: string; runId: string };
}

export interface TaskContext {
  notice: string;
  module?: { id: string; name: string; path: string; paths: string[] };
  case?: { id: string; title: string; kind: CaseKind; priority: CasePriority; status: CaseStatus; preconditions: string; checks: string[] };
  requirements: RequirementView[];
  screens: RequirementView[];
  asset?: AssetView & { blockId?: string };
  tests: CodeTest[];
}

export interface TaskDetail {
  task: Task;
  events: TaskEvent[];
  jobs: AgentJob[];
  context: TaskContext;
}

export interface TaskQuery {
  projectId: string;
  state?: TaskState[];
  kind?: TaskKind[];
  sectionId?: string;
  mine?: boolean;
  q?: string;
  page?: number;
  limit?: number;
}

export interface TaskInput {
  projectId: string;
  kind: TaskKind;
  title: string;
  text?: string;
  anchor?: TaskAnchor;
  priority?: CasePriority;
}

/* ──────────────────────────────── входи ───────────────────────────────── */

export interface SourceNode {
  id: string;
  projectId: string;
  kind: 'confluence' | 'figma' | 'file' | 'paste';
  title: string;
  url?: string;
  externalId?: string;
  externalVersion?: string;
  parentId?: string;
  rootId?: string;
  depth: number;
  included: boolean;
  noAgents: boolean;
  sectionId?: string;
  lastError?: string;
  checkedAt?: string;
  importedAt: string;
  updatedAt: string;
  blockCount: number;
  gaps: number;
  children: SourceNode[];
}

export interface SourceView {
  source: SourceNode;
  blocks: RequirementView[];
}

export interface SyncResult {
  sourceId: string;
  title: string;
  unchanged: boolean;
  changed: number;
  added: number;
  removed: number;
  proposals: number;
  assets: number;
  readTasks: string[];
  assetErrors: Array<{ name: string; error: string }>;
}

export interface Asset {
  id: string;
  projectId: string;
  sourceId?: string;
  blockId?: string;
  kind: 'image' | 'diagram' | 'frame';
  name: string;
  diagramType?: string;
  mediaType?: string;
  sha256?: string;
  extractedText: string;
  reading?: string;
  readingBy?: string;
  readingState: ReadingState;
  readingDecidedBy?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/* ───────────────────────── дашборд і налаштування ─────────────────────── */

export interface HealthCheck {
  target: string;
  ok: boolean;
  checkedAt: string;
  since: string;
  error?: string;
  details: Record<string, unknown>;
}

export interface AgenticSummary {
  tasks: {
    byState: Record<TaskState, number>;
    stale: number;
    oldest: Array<{ id: string; title: string; ageHours: number }>;
    questions: number;
    acceptance: Array<{ model: string; reported: number; firstTime: number }>;
  };
  traceability: {
    blocks: number;
    blocksWithCases: number;
    frames: number;
    framesWithCases: number;
    approvedCases: number;
    casesWithTests: number;
    p1WithoutTests: number;
    readingsPending: number;
  };
  tests: { total: number; byLevel: Record<string, number>; withoutCase: number; byAgent: number; quarantined: number };
  main: null | { id: string; sha: string; branch: string; startedAt: string; runUrl?: string; failed: number; total: number; mutationScore: number | null };
  directPushes: number;
  health: HealthCheck[];
}

export interface Me {
  login: string;
  name?: string;
  role: 'admin' | 'qa' | 'dev' | 'ci';
  kind: 'person' | 'token' | 'local';
  author: string;
}

export interface User {
  login: string;
  name?: string;
  role: 'admin' | 'qa' | 'dev';
  createdAt: string;
  lastSeenAt: string;
}

export interface ApiTokenRecord {
  id: string;
  name: string;
  role: 'ci' | 'dev' | 'qa' | 'admin';
  projectId?: string;
  owner?: string;
  createdBy: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface HealthResponse {
  configured: Record<'confluence' | 'jira' | 'figma' | 'telegram', boolean>;
  checks: HealthCheck[];
}

export interface WeeklyPreview {
  week: string;
  summary: string;
  wikiMarkup: string;
  markdown: string;
  label: string;
  published: { key: string; url?: string } | null;
}

export interface NotificationItem {
  id: string;
  projectId?: string;
  kind: string;
  dedupKey: string;
  createdAt: string;
  sentAt?: string;
  error?: string;
  /** Скільки разів відправка не вдалася. */
  attempts?: number;
  /** Наступна спроба не раніше цього часу. */
  nextTryAt?: string;
  /** Закрито без відправки: вимкнено для проєкту або вичерпано спроби. */
  skippedReason?: 'disabled' | 'failed';
}

export interface PushCheck {
  id: string;
  sha: string;
  branch: string;
  viaPr: boolean;
  prNumbers: number[];
  author?: string;
  acknowledgedBy?: string;
  createdAt: string;
}

export interface TestQuery {
  projectId: string;
  caseId?: string;
  level?: CodeTest['level'];
  withoutCase?: boolean;
  status?: 'passed' | 'failed' | 'skipped';
  q?: string;
  page?: number;
  limit?: number;
}

export type TestPage = Page<CodeTest>;
