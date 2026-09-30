/**
 * Синхронізація реєстру з TestRail через API.
 *
 * Модуль не має доступу до бази: він будує payload, рахує хеш синхронізації,
 * створює відсутні секції й вирішує, що створювати, а що оновлювати.
 * Запис у реєстр робить маршрутизатор через колбек `onSynced`.
 *
 * Клієнт описаний структурним типом, щоб не залежати від реалізації
 * `src/integrations/testrail-api.ts`, яку маршрут підвантажує динамічно.
 */
import { createHash } from 'node:crypto';
import type { CaseTestrail, TestrailMapping, ItemStatus } from './types.js';

/** Розділювач шляху секцій у реєстрі (`sectionPathMap`). */
export const SECTION_SEPARATOR = ' / ';

export interface TestrailSyncCase {
  id: string;
  title: string;
  sectionPath: string;
  kind: string;
  priority: string;
  preconditions: string;
  checks: string[];
  steps: Array<{ action: string; expected: string }>;
  tags: string[];
  refs: string[];
  testrailCaseId?: number;
  /** Хеш останньої синхронізації з реєстру — щоб не чіпати незмінені кейси. */
  syncHash?: string;
}

export interface TestrailSectionLike {
  id: number;
  name: string;
  parent_id: number | null;
}

export interface TestrailClientLike {
  getSections(projectId: number, suiteId?: number): Promise<TestrailSectionLike[]>;
  addSection(projectId: number, name: string, parentId?: number, suiteId?: number): Promise<{ id: number }>;
  getCases(projectId: number, suiteId?: number, sectionId?: number): Promise<Array<Record<string, unknown>>>;
  addCase(sectionId: number, payload: Record<string, unknown>): Promise<{ id: number }>;
  updateCase(caseId: number, payload: Record<string, unknown>): Promise<void>;
  updateCases(suiteId: number, caseIds: number[], payload: Record<string, unknown>): Promise<void>;
  getRuns(projectId: number): Promise<Array<Record<string, unknown>>>;
  getResultsForRun(runId: number): Promise<Array<Record<string, unknown>>>;
}

export interface TestrailProjectRef {
  testrailProjectId: number;
  testrailSuiteId?: number;
}

/* ─────────────────────────────── payload ─────────────────────────────── */

function apiField(mapping: TestrailMapping, key: string, fallback: string): string {
  const mapped = mapping.fields?.[key];
  return typeof mapped === 'string' && mapped.length > 0 ? mapped : fallback;
}

/** Перевірки у вигляді чек-листа — один текстовий блок із маркерами. */
export function checklistText(checks: string[]): string {
  return checks.map((check) => `- ${check}`).join('\n');
}

export function buildCasePayload(item: TestrailSyncCase, mapping: TestrailMapping): Record<string, unknown> {
  const payload: Record<string, unknown> = { title: item.title };

  const typeId = mapping.typeMap?.[item.kind];
  if (typeof typeId === 'number') payload.type_id = typeId;
  const priorityId = mapping.priorityMap?.[item.priority];
  if (typeof priorityId === 'number') payload.priority_id = priorityId;

  if (item.refs.length > 0) payload[apiField(mapping, 'refs', 'refs')] = item.refs.join(', ');
  if (item.preconditions) {
    payload[apiField(mapping, 'preconditions', 'custom_preconds')] = item.preconditions;
  }

  if (mapping.template === 'steps_separated' && item.steps.length > 0) {
    payload[apiField(mapping, 'steps', 'custom_steps_separated')] = item.steps.map((step) => ({
      content: step.action,
      expected: step.expected,
    }));
  } else {
    payload[apiField(mapping, 'checks', 'custom_steps')] = checklistText(item.checks);
  }

  if (mapping.idField) payload[mapping.idField] = item.id;
  return payload;
}

/**
 * Хеш полів, які ми синхронізуємо. Зберігається в `case.testrail.syncHash`,
 * тому наступний push бачить, що змінилось у нас, а `drift` — що розійшлось.
 */
export function caseSyncHash(item: TestrailSyncCase, mapping: TestrailMapping): string {
  const canonical = JSON.stringify({
    title: item.title,
    section: item.sectionPath,
    kind: item.kind,
    priority: item.priority,
    preconditions: item.preconditions,
    checks: item.checks,
    steps: item.steps,
    refs: item.refs,
    template: mapping.template,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/* ─────────────────────────────── секції ──────────────────────────────── */

function sectionPaths(sections: TestrailSectionLike[]): Map<string, number> {
  const byId = new Map(sections.map((section) => [section.id, section]));
  const paths = new Map<string, number>();

  const resolve = (section: TestrailSectionLike, guard = 0): string => {
    if (!section.parent_id || guard > 50) return section.name;
    const parent = byId.get(section.parent_id);
    if (!parent) return section.name;
    return `${resolve(parent, guard + 1)}${SECTION_SEPARATOR}${section.name}`;
  };

  for (const section of sections) paths.set(resolve(section), section.id);
  return paths;
}

/** Створює відсутні секції (включно з проміжними) і повертає карту «шлях → id». */
export async function ensureSections(
  client: TestrailClientLike,
  project: TestrailProjectRef,
  paths: readonly string[],
): Promise<{ map: Map<string, number>; created: string[] }> {
  const existing = await client.getSections(project.testrailProjectId, project.testrailSuiteId);
  const map = sectionPaths(existing);
  const created: string[] = [];

  for (const full of paths) {
    const parts = full.split(SECTION_SEPARATOR).map((part) => part.trim()).filter(Boolean);
    let current = '';
    let parentId: number | undefined;
    for (const part of parts) {
      current = current ? `${current}${SECTION_SEPARATOR}${part}` : part;
      const known = map.get(current);
      if (known !== undefined) {
        parentId = known;
        continue;
      }
      const result = await client.addSection(
        project.testrailProjectId,
        part,
        parentId,
        project.testrailSuiteId,
      );
      map.set(current, result.id);
      created.push(current);
      parentId = result.id;
    }
  }

  return { map, created };
}

/* ──────────────────────────────── push ───────────────────────────────── */

export interface PushCasesArgs {
  client: TestrailClientLike;
  project: TestrailProjectRef;
  mapping: TestrailMapping;
  cases: TestrailSyncCase[];
  /** Запис метаданих синхронізації в реєстр (`setTestrailMeta`). */
  onSynced: (caseId: string, patch: Partial<CaseTestrail>) => void;
  /** Оновлювати навіть ті кейси, чий хеш не змінився. */
  force?: boolean;
}

export interface PushCasesResult {
  created: Array<{ caseId: string; testrailCaseId: number }>;
  updated: string[];
  unchanged: string[];
  sectionsCreated: string[];
  errors: Array<{ caseId: string; error: string }>;
}

export async function pushCases(args: PushCasesArgs): Promise<PushCasesResult> {
  const result: PushCasesResult = {
    created: [],
    updated: [],
    unchanged: [],
    sectionsCreated: [],
    errors: [],
  };
  if (args.cases.length === 0) return result;

  const wantedPaths = Array.from(new Set(args.cases.map((item) => item.sectionPath).filter(Boolean)));
  const { map: sectionMap, created: sectionsCreated } = await ensureSections(
    args.client,
    args.project,
    wantedPaths,
  );
  result.sectionsCreated = sectionsCreated;

  for (const item of args.cases) {
    const hash = caseSyncHash(item, args.mapping);
    try {
      if (item.testrailCaseId && item.syncHash === hash && !args.force) {
        result.unchanged.push(item.id);
        continue;
      }

      const payload = buildCasePayload(item, args.mapping);
      const syncedAt = new Date().toISOString();

      if (item.testrailCaseId) {
        await args.client.updateCase(item.testrailCaseId, payload);
        args.onSynced(item.id, { caseId: item.testrailCaseId, syncedAt, syncHash: hash });
        result.updated.push(item.id);
        continue;
      }

      const sectionId = sectionMap.get(item.sectionPath);
      if (sectionId === undefined) {
        result.errors.push({ caseId: item.id, error: `Секцію «${item.sectionPath}» не створено` });
        continue;
      }
      const added = await args.client.addCase(sectionId, payload);
      args.onSynced(item.id, { caseId: added.id, sectionId, syncedAt, syncHash: hash });
      result.created.push({ caseId: item.id, testrailCaseId: added.id });
    } catch (error) {
      result.errors.push({
        caseId: item.id,
        error: error instanceof Error ? error.message : 'Невідома помилка TestRail',
      });
    }
  }

  return result;
}

/* ──────────────────────────────── pull ───────────────────────────────── */

export interface PullCasesArgs {
  client: TestrailClientLike;
  project: TestrailProjectRef;
  mapping: TestrailMapping;
  /** Наші кейси з обчисленим хешем — для порівняння з тим, що в TestRail. */
  ours: TestrailSyncCase[];
}

export interface PullCasesResult {
  /** Кейси, яким ми знайшли пару в TestRail за нашим ID і записали `caseId`. */
  adopted: Array<{ caseId: string; testrailCaseId: number }>;
  /** Розбіжності: у TestRail правили руками. */
  drift: Array<{
    caseId: string;
    testrailCaseId: number;
    fields: string[];
    ours: Record<string, string>;
    theirs: Record<string, string>;
  }>;
  /** Кейси TestRail, яких немає в реєстрі. */
  unknown: Array<{ testrailCaseId: number; title: string }>;
  total: number;
}

function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

function theirChecklist(row: Record<string, unknown>, mapping: TestrailMapping): string {
  const stepsField = apiField(mapping, 'checks', 'custom_steps');
  const raw = stringField(row, stepsField);
  return raw.trim();
}

export async function pullCases(args: PullCasesArgs): Promise<PullCasesResult> {
  const rows = await args.client.getCases(args.project.testrailProjectId, args.project.testrailSuiteId);
  const result: PullCasesResult = { adopted: [], drift: [], unknown: [], total: rows.length };

  const byOurId = new Map(args.ours.map((item) => [item.id, item]));
  const byTestrailId = new Map(
    args.ours.filter((item) => item.testrailCaseId).map((item) => [item.testrailCaseId as number, item]),
  );

  for (const row of rows) {
    const testrailCaseId = Number(row.id);
    if (!Number.isFinite(testrailCaseId)) continue;

    const ourIdRaw = mapping_ourId(row, args.mapping);
    let ours = ourIdRaw ? byOurId.get(ourIdRaw) : undefined;
    if (!ours) ours = byTestrailId.get(testrailCaseId);

    if (!ours) {
      result.unknown.push({ testrailCaseId, title: stringField(row, 'title') });
      continue;
    }

    if (!ours.testrailCaseId) {
      result.adopted.push({ caseId: ours.id, testrailCaseId });
    }

    const fields: string[] = [];
    const theirTitle = stringField(row, 'title');
    if (theirTitle && theirTitle !== ours.title) fields.push('title');

    const theirSteps = theirChecklist(row, args.mapping);
    const ourSteps = checklistText(ours.checks).trim();
    if (theirSteps && ourSteps && theirSteps !== ourSteps) fields.push('checks');

    if (fields.length > 0) {
      result.drift.push({
        caseId: ours.id,
        testrailCaseId,
        fields,
        ours: { title: ours.title, checks: ourSteps },
        theirs: { title: theirTitle, checks: theirSteps },
      });
    }
  }

  return result;
}

function mapping_ourId(row: Record<string, unknown>, mapping: TestrailMapping): string | undefined {
  const direct = row[mapping.idField];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  // Деякі інстанси віддають кастомні поля без префікса `custom_`.
  const short = mapping.idField.replace(/^custom_/, '');
  const alt = row[short];
  if (typeof alt === 'string' && alt.trim()) return alt.trim();
  return undefined;
}

/* ─────────────────────── результати прогонів TestRail ─────────────────── */

/** Стандартні статуси TestRail: 1 passed, 2 blocked, 3 untested, 4 retest, 5 failed. */
export function mapTestrailStatus(statusId: number): ItemStatus {
  switch (statusId) {
    case 1:
      return 'passed';
    case 2:
      return 'blocked';
    case 5:
      return 'failed';
    case 4:
    case 3:
      return 'untested';
    default:
      return statusId > 5 ? 'failed' : 'untested';
  }
}

export interface PulledRunResult {
  testrailCaseId: number;
  status: ItemStatus;
  comment: string;
}

export interface PullResultsArgs {
  client: TestrailClientLike;
  project: TestrailProjectRef;
  /** Конкретний ран TestRail; якщо не заданий — найсвіжіший. */
  runId?: number;
}

export interface PullResultsOutcome {
  run?: { id: number; name: string };
  results: PulledRunResult[];
}

export async function pullResults(args: PullResultsArgs): Promise<PullResultsOutcome> {
  let runId = args.runId;
  let runName = runId ? `TestRail run ${runId}` : '';

  if (!runId) {
    const runs = await args.client.getRuns(args.project.testrailProjectId);
    const latest = runs
      .map((row) => ({
        id: Number(row.id),
        name: stringField(row, 'name'),
        createdOn: Number(row.created_on ?? 0),
      }))
      .filter((row) => Number.isFinite(row.id))
      .sort((a, b) => b.createdOn - a.createdOn)[0];
    if (!latest) return { results: [] };
    runId = latest.id;
    runName = latest.name || `TestRail run ${latest.id}`;
  }

  const rows = await args.client.getResultsForRun(runId);
  const results: PulledRunResult[] = [];
  const seen = new Set<number>();

  // Результати приходять від найновішого; беремо перший на кейс.
  for (const row of rows) {
    const testrailCaseId = Number(row.case_id);
    const statusId = Number(row.status_id);
    if (!Number.isFinite(testrailCaseId) || seen.has(testrailCaseId)) continue;
    if (!Number.isFinite(statusId)) continue;
    seen.add(testrailCaseId);
    results.push({
      testrailCaseId,
      status: mapTestrailStatus(statusId),
      comment: stringField(row, 'comment'),
    });
  }

  return { run: { id: runId, name: runName }, results };
}
