/**
 * Методи API Jules 2.0: задачі для агентів, входи (Confluence, Figma),
 * вкладення й прочитання, тести в коді, доступ, стан інтеграцій, звіти.
 * Маршрути — `src/server/routes/{tasks,inputs,ingest,reports,access}.ts`.
 */
import type {
  AgenticSummary,
  ApiTokenRecord,
  Asset,
  CodeTest,
  HealthResponse,
  Me,
  NotificationItem,
  Page,
  Project,
  PushCheck,
  ReadingState,
  RequirementView,
  SourceNode,
  SourceView,
  SyncResult,
  Task,
  TaskDetail,
  TaskEvent,
  TaskInput,
  TaskListItem,
  TaskQuery,
  TestQuery,
  User,
  WeeklyPreview,
} from '../types';
import { qs, request, withToken } from './client';

const R = '/api/registry';
const enc = encodeURIComponent;

export interface V2Api {
  me(signal?: AbortSignal): Promise<Me>;
  listUsers(signal?: AbortSignal): Promise<User[]>;
  setUserRole(login: string, role: User['role'], signal?: AbortSignal): Promise<User>;
  listTokens(projectId?: string, signal?: AbortSignal): Promise<ApiTokenRecord[]>;
  issueToken(input: { name: string; role: ApiTokenRecord['role']; projectId?: string }, signal?: AbortSignal): Promise<{ token: string; record: ApiTokenRecord }>;
  revokeToken(id: string, signal?: AbortSignal): Promise<void>;

  listTasks(query: TaskQuery, signal?: AbortSignal): Promise<Page<TaskListItem>>;
  getTask(id: string, signal?: AbortSignal): Promise<TaskDetail>;
  createTask(input: TaskInput, signal?: AbortSignal): Promise<Task>;
  answerTask(id: string, text: string, signal?: AbortSignal): Promise<Task>;
  commentTask(id: string, text: string, signal?: AbortSignal): Promise<TaskEvent>;
  confirmTask(id: string, signal?: AbortSignal): Promise<Task>;
  requestTaskChanges(id: string, text: string, signal?: AbortSignal): Promise<Task>;
  rejectTask(id: string, note?: string, signal?: AbortSignal): Promise<Task>;

  getSourceTree(projectId: string, signal?: AbortSignal): Promise<SourceNode[]>;
  patchSourceFlags(id: string, flags: { included?: boolean; noAgents?: boolean; sectionId?: string | null }, signal?: AbortSignal): Promise<SourceNode>;
  getSourceView(id: string, signal?: AbortSignal): Promise<SourceView>;
  getRequirements(blockIds: string[], signal?: AbortSignal): Promise<RequirementView[]>;
  loadConfluenceTree(projectId: string, ref: string, signal?: AbortSignal): Promise<{ sources: SourceNode[]; truncated: boolean }>;
  modulesFromTree(projectId: string, rootSourceId: string, signal?: AbortSignal): Promise<{ sections: Array<{ id: string; name: string; created: boolean; planTask: string | null }> }>;
  importFigma(projectId: string, url: string, signal?: AbortSignal): Promise<SyncResult>;
  syncInputs(projectId: string, force?: boolean, signal?: AbortSignal): Promise<{ results: SyncResult[]; errors: Array<{ sourceId: string; title: string; error: string }> }>;
  syncSource(id: string, signal?: AbortSignal): Promise<SyncResult>;
  setBlockRoute(blockId: string, route: string | null, signal?: AbortSignal): Promise<unknown>;
  listAssets(projectId: string, readingState?: ReadingState, signal?: AbortSignal): Promise<Asset[]>;
  decideReading(id: string, approve: boolean, reading?: string, note?: string, signal?: AbortSignal): Promise<Asset>;
  assetFileUrl(id: string): string;

  listTests(query: TestQuery, signal?: AbortSignal): Promise<Page<CodeTest>>;
  setTestState(id: string, state: 'active' | 'quarantined', signal?: AbortSignal): Promise<CodeTest>;
  listPushChecks(projectId: string, signal?: AbortSignal): Promise<PushCheck[]>;
  acknowledgePush(projectId: string, id: string, signal?: AbortSignal): Promise<void>;
  getStatusMarkdown(projectId: string, signal?: AbortSignal): Promise<string>;

  getAgenticSummary(projectId: string, signal?: AbortSignal): Promise<AgenticSummary>;
  getHealth(signal?: AbortSignal): Promise<HealthResponse>;
  runHealthChecks(signal?: AbortSignal): Promise<HealthResponse>;
  getWeekly(projectId: string, week?: string, signal?: AbortSignal): Promise<WeeklyPreview>;
  publishWeekly(projectId: string, input: { week?: string; insights?: string }, signal?: AbortSignal): Promise<{ week: string; jira?: { key: string; url: string; created: boolean } }>;
  listNotifications(signal?: AbortSignal): Promise<{ configured: boolean; items: NotificationItem[] }>;
  testNotification(signal?: AbortSignal): Promise<{ ok: boolean }>;
  patchProjectV2(id: string, patch: Partial<Pick<Project, 'repo' | 'settings' | 'name' | 'description'>>, signal?: AbortSignal): Promise<Project>;
  patchSection(id: string, patch: { paths?: string[]; owners?: string[]; name?: string }, signal?: AbortSignal): Promise<unknown>;
}

export const httpApiV2: V2Api = {
  me: (signal) => request<Me>(`${R}/me`, { signal }),
  listUsers: (signal) => request<User[]>(`${R}/users`, { signal }),
  setUserRole: (login, role, signal) => request<User>(`${R}/users/${enc(login)}`, { method: 'PATCH', body: { role }, signal }),
  listTokens: (projectId, signal) => request<ApiTokenRecord[]>(`${R}/tokens${qs({ projectId })}`, { signal }),
  issueToken: (input, signal) => request<{ token: string; record: ApiTokenRecord }>(`${R}/tokens`, { method: 'POST', body: input, signal }),
  revokeToken: (id, signal) => request<void>(`${R}/tokens/${enc(id)}`, { method: 'DELETE', signal }),

  listTasks: (query, signal) =>
    request<Page<TaskListItem>>(
      `${R}/tasks${qs({
        projectId: query.projectId,
        state: query.state?.join(','),
        kind: query.kind?.join(','),
        sectionId: query.sectionId,
        mine: query.mine ? '1' : undefined,
        q: query.q,
        page: query.page,
        limit: query.limit,
      })}`,
      { signal },
    ),
  getTask: (id, signal) => request<TaskDetail>(`${R}/tasks/${enc(id)}`, { signal }),
  createTask: (input, signal) => request<Task>(`${R}/tasks`, { method: 'POST', body: input, signal }),
  answerTask: (id, text, signal) => request<Task>(`${R}/tasks/${enc(id)}/answer`, { method: 'POST', body: { text }, signal }),
  commentTask: (id, text, signal) => request<TaskEvent>(`${R}/tasks/${enc(id)}/comment`, { method: 'POST', body: { text }, signal }),
  confirmTask: (id, signal) => request<Task>(`${R}/tasks/${enc(id)}/confirm`, { method: 'POST', body: {}, signal }),
  requestTaskChanges: (id, text, signal) => request<Task>(`${R}/tasks/${enc(id)}/request-changes`, { method: 'POST', body: { text }, signal }),
  rejectTask: (id, note, signal) => request<Task>(`${R}/tasks/${enc(id)}/reject`, { method: 'POST', body: { note }, signal }),

  getSourceTree: (projectId, signal) => request<SourceNode[]>(`${R}/sources/tree${qs({ projectId })}`, { signal }),
  patchSourceFlags: (id, flags, signal) => request<SourceNode>(`${R}/sources/${enc(id)}`, { method: 'PATCH', body: flags, signal }),
  getSourceView: (id, signal) => request<SourceView>(`${R}/sources/${enc(id)}/view`, { signal }),
  getRequirements: (blockIds, signal) => request<RequirementView[]>(`${R}/requirements${qs({ blockIds: blockIds.join(',') })}`, { signal }),
  loadConfluenceTree: (projectId, ref, signal) =>
    request<{ sources: SourceNode[]; truncated: boolean }>(`${R}/inputs/confluence/tree`, { method: 'POST', body: { projectId, ref }, signal }),
  modulesFromTree: (projectId, rootSourceId, signal) =>
    request(`${R}/inputs/confluence/modules`, { method: 'POST', body: { projectId, rootSourceId }, signal }),
  importFigma: (projectId, url, signal) => request<SyncResult>(`${R}/inputs/figma`, { method: 'POST', body: { projectId, url }, signal }),
  syncInputs: (projectId, force, signal) => request(`${R}/inputs/sync`, { method: 'POST', body: { projectId, force: Boolean(force) }, signal }),
  syncSource: (id, signal) => request<SyncResult>(`${R}/sources/${enc(id)}/sync`, { method: 'POST', body: { force: true }, signal }),
  setBlockRoute: (blockId, route, signal) => request(`${R}/blocks/${enc(blockId)}`, { method: 'PATCH', body: { route }, signal }),
  listAssets: (projectId, readingState, signal) => request<Asset[]>(`${R}/assets${qs({ projectId, readingState })}`, { signal }),
  decideReading: (id, approve, reading, note, signal) =>
    request<Asset>(`${R}/assets/${enc(id)}/decide`, { method: 'POST', body: { approve, reading, note }, signal }),
  assetFileUrl: (id) => withToken(`${R}/assets/${enc(id)}/file`),

  listTests: (query, signal) =>
    request<Page<CodeTest>>(
      `${R}/tests${qs({
        projectId: query.projectId,
        caseId: query.caseId,
        level: query.level,
        withoutCase: query.withoutCase ? '1' : undefined,
        status: query.status,
        q: query.q,
        page: query.page,
        limit: query.limit,
      })}`,
      { signal },
    ),
  setTestState: (id, state, signal) => request<CodeTest>(`${R}/tests/${enc(id)}`, { method: 'PATCH', body: { state }, signal }),
  listPushChecks: (projectId, signal) => request<PushCheck[]>(`${R}/push-checks${qs({ projectId })}`, { signal }),
  acknowledgePush: (projectId, id, signal) => request<void>(`${R}/push-checks/${enc(id)}/ack`, { method: 'POST', body: { projectId }, signal }),
  getStatusMarkdown: async (projectId, signal) => {
    const response = await fetch(withToken(`${R}/status.md${qs({ projectId })}`), { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  },

  getAgenticSummary: (projectId, signal) => request<AgenticSummary>(`${R}/dashboard/agentic${qs({ projectId })}`, { signal }),
  getHealth: (signal) => request<HealthResponse>(`${R}/health`, { signal }),
  runHealthChecks: (signal) => request<HealthResponse>(`${R}/health/check`, { method: 'POST', body: {}, signal }),
  getWeekly: (projectId, week, signal) => request<WeeklyPreview>(`${R}/reports/weekly${qs({ projectId, week })}`, { signal }),
  publishWeekly: (projectId, input, signal) => request(`${R}/reports/weekly`, { method: 'POST', body: { projectId, ...input }, signal }),
  listNotifications: (signal) => request(`${R}/notifications`, { signal }),
  testNotification: (signal) => request(`${R}/notifications/test`, { method: 'POST', body: {}, signal }),
  patchProjectV2: (id, patch, signal) => request<Project>(`${R}/projects/${enc(id)}`, { method: 'PATCH', body: patch, signal }),
  patchSection: (id, patch, signal) => request(`${R}/sections/${enc(id)}`, { method: 'PATCH', body: patch, signal }),
};
