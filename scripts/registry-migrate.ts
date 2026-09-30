/**
 * Перенос наявних даних у реєстр тест-кейсів.
 *
 *   npx tsx scripts/registry-migrate.ts
 *
 * Що робить (ідемпотентно — повторний запуск не дублює):
 *   1. створює проєкт за замовчуванням із ключем `JULES`;
 *   2. секції з поля `group` YAML-сценаріїв (без групи → «Загальне»);
 *   3. кейси з усіх YAML-сценаріїв: `automation.status='automated'`,
 *      `scenarioPath`, теги, `checks` із `success_criteria`;
 *   4. статичні вибірки з кожного набору `data/suites/*.json`;
 *   5. прогони реєстру (`kind='auto'`) з `data/runs/*.json`, елементи — за
 *      `scenarioName`; прогін набору збирає елементи з дочірніх прогонів.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { closeDb, ensureMigrated, execute, query, queryOne, toJson, tx } from '../src/registry/db.js';
import { bumpCaseCounter, generateSectionCode, newId } from '../src/registry/ids.js';
import { createProject, getProjectByKey } from '../src/registry/projects-store.js';
import { createSection, getSectionByName, listSections, takenCodes } from '../src/registry/sections-store.js';
import { createCase, getCase, listAllCases } from '../src/registry/cases-store.js';
import { createSelection, getSelection, updateSelection } from '../src/registry/selections-store.js';
import { getDataRoot, getScenariosDir } from '../src/server/data-paths.js';
import type { ItemStatus, Project, Section } from '../src/registry/types.js';

const DEFAULT_KEY = 'JULES';
const DEFAULT_SECTION = 'Загальне';

interface ScenarioFile {
  file: string;
  scenarioPath: string;
  name: string;
  goal: string;
  group?: string;
  tags: string[];
  hints: string[];
  successCriteria: string[];
  targetUrl?: string;
}

interface Stats {
  project: string;
  sectionsCreated: number;
  casesCreated: number;
  casesSkipped: number;
  selectionsCreated: number;
  selectionsUpdated: number;
  runsCreated: number;
  runsSkipped: number;
  warnings: string[];
}

function readScenarios(): ScenarioFile[] {
  const dir = getScenariosDir();
  if (!fs.existsSync(dir)) return [];
  const result: ScenarioFile[] = [];

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
      const parsed = parseYaml(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed.name !== 'string') continue;
      result.push({
        file,
        scenarioPath: `scenarios/${file}`,
        name: parsed.name,
        goal: typeof parsed.goal === 'string' ? parsed.goal : parsed.name,
        group: typeof parsed.group === 'string' && parsed.group.trim() ? parsed.group.trim() : undefined,
        tags: Array.isArray(parsed.tags) ? (parsed.tags as string[]).filter((t) => typeof t === 'string') : [],
        hints: Array.isArray(parsed.hints) ? (parsed.hints as string[]).filter((t) => typeof t === 'string') : [],
        successCriteria: Array.isArray(parsed.success_criteria)
          ? (parsed.success_criteria as string[]).filter((t) => typeof t === 'string')
          : [],
        targetUrl: typeof parsed.target_url === 'string' ? parsed.target_url : undefined,
      });
    } catch (error) {
      process.stdout.write(
        `  ! сценарій ${file} пропущено: ${error instanceof Error ? error.message : 'помилка розбору'}\n`,
      );
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

function ensureProject(scenarios: ScenarioFile[], stats: Stats): Project {
  const existing = getProjectByKey(DEFAULT_KEY);
  if (existing) {
    stats.project = `${existing.id} (уже був)`;
    return existing;
  }
  const baseUrl = scenarios.find((s) => s.targetUrl)?.targetUrl;
  const project = createProject({
    id: 'jules',
    key: DEFAULT_KEY,
    name: 'Jules AI QA',
    description: 'Проєкт за замовчуванням, створений скриптом переносу даних у реєстр',
    ...(baseUrl ? { baseUrl } : {}),
  });
  stats.project = `${project.id} (створено)`;
  return project;
}

function ensureSection(project: Project, name: string, stats: Stats): Section {
  const existing = getSectionByName(project.id, name, null);
  if (existing) return existing;
  const section = createSection({
    projectId: project.id,
    name,
    code: generateSectionCode(name, takenCodes(project.id)),
  });
  stats.sectionsCreated += 1;
  return section;
}

function caseByScenarioPath(projectId: string, scenarioPath: string): string | null {
  const row = queryOne<{ id: string }>(
    `SELECT id FROM cases WHERE project_id = ? AND json_extract(automation, '$.scenarioPath') = ?`,
    [projectId, scenarioPath],
  );
  return row?.id ?? null;
}

function migrateScenarios(project: Project, scenarios: ScenarioFile[], stats: Stats): Map<string, string> {
  const byScenarioPath = new Map<string, string>();

  for (const scenario of scenarios) {
    const existingId = caseByScenarioPath(project.id, scenario.scenarioPath);
    if (existingId) {
      byScenarioPath.set(scenario.scenarioPath, existingId);
      byScenarioPath.set(scenario.name, existingId);
      stats.casesSkipped += 1;
      continue;
    }

    const section = ensureSection(project, scenario.group ?? DEFAULT_SECTION, stats);
    const tags = Array.from(new Set([...scenario.tags, 'auto']));
    const created = createCase(
      project.id,
      {
        sectionId: section.id,
        title: scenario.goal || scenario.name,
        kind: 'positive',
        priority: 'P2',
        status: 'approved',
        preconditions: scenario.hints.join('\n'),
        checks: scenario.successCriteria.length > 0 ? scenario.successCriteria : [scenario.goal || scenario.name],
        tags,
        automation: { status: 'automated', scenarioPath: scenario.scenarioPath },
      },
      { author: 'registry-migrate', reason: `перенос сценарію ${scenario.scenarioPath}` },
    );
    byScenarioPath.set(scenario.scenarioPath, created.id);
    byScenarioPath.set(scenario.name, created.id);
    stats.casesCreated += 1;
  }

  // Лічильники секцій мають бути не нижче за максимальний виданий номер.
  for (const section of listSections(project.id)) {
    const max = queryOne<{ n: number }>(
      `SELECT MAX(CAST(substr(id, length(id) - 2) AS INTEGER)) AS n FROM cases WHERE section_id = ?`,
      [section.id],
    );
    if (max?.n) bumpCaseCounter(section.id, Number(max.n));
  }

  return byScenarioPath;
}

interface SuiteFile {
  id: string;
  name: string;
  description?: string;
  scenarioPaths: string[];
  stopOnFailure?: boolean;
}

function readSuites(): SuiteFile[] {
  const dir = path.join(getDataRoot(), 'suites');
  if (!fs.existsSync(dir)) return [];
  const suites: SuiteFile[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as SuiteFile;
      if (parsed?.id && Array.isArray(parsed.scenarioPaths)) suites.push(parsed);
    } catch {
      /* пропускаємо зламаний файл */
    }
  }
  return suites;
}

function migrateSuites(
  project: Project,
  suites: SuiteFile[],
  caseByPath: Map<string, string>,
  stats: Stats,
): void {
  for (const suite of suites) {
    const caseIds = suite.scenarioPaths
      .map((scenarioPath) => caseByPath.get(scenarioPath))
      .filter((id): id is string => Boolean(id));

    if (caseIds.length === 0) {
      stats.warnings.push(`набір «${suite.name}» пропущено: жоден сценарій не має кейса`);
      continue;
    }

    const selectionId = `suite-${suite.id}`;
    const existing = getSelection(selectionId);
    if (existing) {
      updateSelection(selectionId, { caseIds, mode: 'static' });
      stats.selectionsUpdated += 1;
      continue;
    }
    createSelection({
      id: selectionId,
      projectId: project.id,
      name: suite.name,
      description: suite.description ?? '',
      mode: 'static',
      caseIds,
      stopOnFailure: suite.stopOnFailure ?? false,
    });
    stats.selectionsCreated += 1;
  }
}

interface EngineRun {
  id: string;
  status: string;
  runType?: string;
  scenarioName?: string;
  qaTargetUrl?: string;
  qaMode?: string;
  suiteId?: string;
  childRunIds?: string[];
  startedAt: string;
  finishedAt?: string;
}

function readEngineRuns(): EngineRun[] {
  const dir = path.join(getDataRoot(), 'runs');
  if (!fs.existsSync(dir)) return [];
  const runs: EngineRun[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as EngineRun;
      if (parsed?.id && parsed.startedAt) runs.push(parsed);
    } catch {
      /* пропускаємо зламаний файл */
    }
  }
  return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function mapEngineStatus(status: string): ItemStatus {
  if (status === 'passed') return 'passed';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'blocked';
  return 'untested';
}

function migrateRuns(project: Project, runs: EngineRun[], caseByPath: Map<string, string>, stats: Stats): void {
  const byId = new Map(runs.map((run) => [run.id, run]));

  for (const run of runs) {
    if (run.runType === 'suite-step') continue; // згорнуто в батьківський прогін

    const note = `engine-run:${run.id}`;
    const already = queryOne<{ id: string }>('SELECT id FROM registry_runs WHERE note = ?', [note]);
    if (already) {
      stats.runsSkipped += 1;
      continue;
    }

    const parts: Array<{ caseId: string; status: ItemStatus }> = [];
    if (run.runType === 'suite') {
      for (const childId of run.childRunIds ?? []) {
        const child = byId.get(childId);
        if (!child?.scenarioName) continue;
        const caseId = caseByPath.get(child.scenarioName);
        if (caseId) parts.push({ caseId, status: mapEngineStatus(child.status) });
      }
    } else if (run.scenarioName) {
      const caseId = caseByPath.get(run.scenarioName);
      if (caseId) parts.push({ caseId, status: mapEngineStatus(run.status) });
    }

    if (parts.length === 0) {
      stats.warnings.push(`прогін ${run.id.slice(0, 8)} пропущено: не знайдено кейсів за scenarioName`);
      continue;
    }

    const registryRunId = newId('run');
    tx(() => {
      execute(
        `INSERT INTO registry_runs
           (id, project_id, kind, title, selection_id, env, state, executor, started_at, finished_at, note)
         VALUES (?, ?, 'auto', ?, ?, ?, ?, 'registry-migrate', ?, ?, ?)`,
        [
          registryRunId,
          project.id,
          run.runType === 'suite'
            ? `Набір ${run.suiteId ?? ''} (${run.startedAt.slice(0, 16).replace('T', ' ')})`
            : `${run.scenarioName} (${run.startedAt.slice(0, 16).replace('T', ' ')})`,
          run.suiteId ? `suite-${run.suiteId}` : null,
          toJson({
            ...(run.qaTargetUrl ? { baseUrl: run.qaTargetUrl } : {}),
            ...(run.qaMode === 'warm-up' || run.qaMode === 'regression' ? { mode: run.qaMode } : {}),
            label: 'перенесено з data/runs',
          }),
          run.finishedAt ? 'completed' : 'open',
          run.startedAt,
          run.finishedAt ?? null,
          note,
        ],
      );

      let position = 0;
      for (const part of parts) {
        if (!getCase(part.caseId)) continue;
        execute(
          `INSERT OR IGNORE INTO run_items
             (id, run_id, case_id, position, status, auto_run_id, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'registry-migrate')`,
          [
            newId('rit'),
            registryRunId,
            part.caseId,
            position,
            part.status,
            run.id,
            run.finishedAt ?? run.startedAt,
          ],
        );
        position += 1;
      }
    });
    stats.runsCreated += 1;
  }
}

function main(): void {
  ensureMigrated();
  const stats: Stats = {
    project: '',
    sectionsCreated: 0,
    casesCreated: 0,
    casesSkipped: 0,
    selectionsCreated: 0,
    selectionsUpdated: 0,
    runsCreated: 0,
    runsSkipped: 0,
    warnings: [],
  };

  const scenarios = readScenarios();
  process.stdout.write(`Знайдено YAML-сценаріїв: ${scenarios.length}\n`);

  const project = ensureProject(scenarios, stats);
  const caseByPath = migrateScenarios(project, scenarios, stats);
  migrateSuites(project, readSuites(), caseByPath, stats);
  migrateRuns(project, readEngineRuns(), caseByPath, stats);

  const total = listAllCases(project.id).length;
  const sections = listSections(project.id).length;

  process.stdout.write(
    [
      '',
      'Готово.',
      `  проєкт:      ${stats.project}`,
      `  секції:      +${stats.sectionsCreated} (усього ${sections})`,
      `  кейси:       +${stats.casesCreated}, без змін ${stats.casesSkipped} (усього ${total})`,
      `  вибірки:     +${stats.selectionsCreated}, оновлено ${stats.selectionsUpdated}`,
      `  прогони:     +${stats.runsCreated}, без змін ${stats.runsSkipped}`,
      `  база:        ${path.resolve(process.env.REGISTRY_DB ?? path.join(getDataRoot(), 'registry.db'))}`,
      '',
    ].join('\n'),
  );

  if (stats.warnings.length > 0) {
    process.stdout.write('Попередження:\n');
    for (const warning of stats.warnings) process.stdout.write(`  - ${warning}\n`);
    process.stdout.write('\n');
  }

  // Наявні прогони переносяться як факт: перерахунок flakeScore зробить дашборд.
  const results = query<{ n: number }>('SELECT COUNT(*) AS n FROM run_items')[0];
  process.stdout.write(`Результатів у прогонах: ${Number(results?.n ?? 0)}\n`);
  closeDb();
}

main();
