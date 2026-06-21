export interface UiSettings {
  qaTargetUrl: string;
  qaMode: 'warm-up' | 'regression';
  qaScenarioPath: string;
  debugCache: boolean;
  llmBaseUrl?: string;
  llmModelName?: string;
}

export interface ScenarioMeta {
  path: string;
  name: string;
  goal: string;
  targetUrl?: string;
  tags?: string[];
  group?: string;
  updatedAt?: string;
}

export interface ScenarioForm {
  name: string;
  goal: string;
  target_url?: string;
  tags?: string[];
  group?: string;
  hints: string[];
  steps: string[];
  success_criteria: string[];
  auth?: { profile: string };
  navigation?: {
    type: 'deterministic' | 'ai';
    url?: string;
    instruction?: string;
  };
}

export interface SuiteDefinition {
  id: string;
  name: string;
  description: string;
  scenarioPaths: string[];
  stopOnFailure: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface SuiteForm {
  name: string;
  description: string;
  scenarioPaths: string[];
  stopOnFailure: boolean;
}

export interface ScenarioDetail extends ScenarioForm {
  path: string;
  raw?: string;
}

export interface StepResult {
  index: number;
  kind: 'step' | 'assertion';
  instruction: string;
  status: 'passed' | 'failed' | 'healed' | 'skipped';
  attempts: number;
  healed: boolean;
  handledBy: 'midscene' | 'playwright' | 'stagehand' | 'deterministic';
  durationMs: number;
  error?: string;
  errorClass?: string;
  thought?: string;
}

export interface RunEvidence {
  summary?: { total: number; passed: number; failed: number; healed: number };
  bugReports?: Array<{
    id: string;
    assertion: string;
    severity: 'low' | 'medium' | 'high';
    thought?: string;
    rootCauseHypothesis?: string;
  }>;
  generatedSpec?: string;
}

export interface RunSummary {
  id: string;
  status: string;
  runType?: 'single' | 'suite' | 'suite-step';
  qaTargetUrl: string;
  qaScenarioPath: string;
  qaMode: string;
  scenarioName?: string;
  suiteId?: string;
  parentRunId?: string;
  childRunIds?: string[];
  stepIndex?: number;
  totalSteps?: number;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  errorSummary?: string;
  hitlReason?: string;
  logCount: number;
  active: boolean;
  reportPaths?: {
    aggregate?: string;
    playwright?: string;
    midscene?: string[];
    videos?: string[];
    plans?: string[];
  };
  stepResults?: StepResult[];
  evidence?: RunEvidence;
}

export interface RunDetail extends Omit<RunSummary, 'logCount'> {
  logs: string[];
}

export interface DashboardStats {
  totalRuns: number;
  passed: number;
  failed: number;
  running: number;
  passRate: number | null;
  scenariosCount: number;
  suitesCount: number;
  last7dRuns: number;
  last7dPassed: number;
  recentRuns: Array<Omit<RunSummary, 'active'>>;
}

export interface AiGenerateRequest {
  description: string;
  targetUrl?: string;
  testType?: 'smoke' | 'regression' | 'accessibility' | 'security' | 'e2e';
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

function scenarioFilename(path: string): string {
  return path.replace(/^scenarios\//, '');
}

export const api = {
  getSettings: () => request<UiSettings>('/api/settings'),
  saveSettings: (settings: UiSettings) =>
    request<UiSettings>('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    }),
  getScenarios: () => request<ScenarioMeta[]>('/api/scenarios'),
  getScenarioTemplate: () => request<ScenarioForm>('/api/scenarios/template'),
  getScenario: (path: string) =>
    request<ScenarioDetail>(`/api/scenarios/detail/${encodeURIComponent(scenarioFilename(path))}`),
  createScenario: (data: ScenarioForm) =>
    request<{ path: string; name: string }>('/api/scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  updateScenario: (path: string, data: ScenarioForm) =>
    request<{ path: string; name: string }>(`/api/scenarios/detail/${encodeURIComponent(scenarioFilename(path))}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  deleteScenario: (path: string) =>
    request<{ deleted: boolean }>(`/api/scenarios/detail/${encodeURIComponent(scenarioFilename(path))}`, {
      method: 'DELETE',
    }),
  getSuites: () => request<SuiteDefinition[]>('/api/suites'),
  getSuiteTemplate: () => request<SuiteForm>('/api/suites/template'),
  getSuite: (id: string) => request<SuiteDefinition>(`/api/suites/${encodeURIComponent(id)}`),
  createSuite: (data: SuiteForm) =>
    request<SuiteDefinition>('/api/suites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  updateSuite: (id: string, data: SuiteForm) =>
    request<SuiteDefinition>(`/api/suites/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, id }),
    }),
  deleteSuite: (id: string) =>
    request<{ deleted: boolean }>(`/api/suites/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  startSuiteRun: (suiteId: string, overrides?: { qaTargetUrl?: string; qaMode?: UiSettings['qaMode'] }) =>
    request<RunDetail>(`/api/suites/${encodeURIComponent(suiteId)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(overrides ?? {}),
    }),
  getRuns: () => request<RunSummary[]>('/api/runs'),
  getRun: (id: string) => request<RunDetail>(`/api/runs/${id}`),
  startRun: (overrides?: Partial<UiSettings> & { suiteId?: string }) =>
    request<RunDetail>('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(overrides ?? {}),
    }),
  cancelRun: (id: string) => request<{ cancelled: boolean }>(`/api/runs/${id}/cancel`, { method: 'POST' }),
  resumeRun: (id: string) => request<{ resumed: boolean }>(`/api/runs/${id}/resume`, { method: 'POST' }),
  checkLlm: () => request<{ ok: boolean; models?: string[]; error?: string }>('/api/llm/check'),
  getStats: () => request<DashboardStats>('/api/stats'),
  generateScenario: (data: AiGenerateRequest) =>
    request<ScenarioForm>('/api/ai/generate-scenario', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  enhanceScenario: (scenario: Partial<ScenarioForm>, focus?: 'hints' | 'steps' | 'criteria' | 'all') =>
    request<Partial<ScenarioForm>>('/api/ai/enhance-scenario', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario, focus }),
    }),
  suggestIdeas: (targetUrl: string, context?: string) =>
    request<{ ideas: string[] }>('/api/ai/suggest-ideas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl, context }),
    }),
};

export function modeLabel(mode: string): string {
  return mode === 'regression' ? 'Регресія (швидкий повтор)' : 'Перший запуск (навчання AI)';
}

export function modeHint(mode: string): string {
  return mode === 'regression'
    ? 'Використовує збережений кеш локаторів. Швидше, але потребує попереднього «Перший запуск» на цій сторінці.'
    : 'AI досліджує інтерфейс і записує локатори в кеш. Оберіть для нових сторінок або після змін UI.';
}

export function runTypeLabel(runType?: string): string {
  if (runType === 'suite') return 'Набір сценаріїв';
  if (runType === 'suite-step') return 'Крок набору';
  return 'Один сценарій';
}

export function statusLabel(status: string): string {
  const map: Record<string, string> = {
    queued: 'У черзі',
    running: 'Виконується',
    paused: 'Очікує оператора',
    passed: 'Успішно',
    failed: 'Помилка',
    cancelled: 'Скасовано',
  };
  return map[status] ?? status;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('uk-UA');
}

export function linesToArray(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
}

export function arrayToLines(items: string[]): string {
  return items.join('\n');
}
