import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dashboard, driftCount, flakeScores, persistFlakeScores } from '../../../src/registry/dashboard.js';
import { getCase, setTestrailMeta, updateCase } from '../../../src/registry/cases-store.js';
import { createRun, setItemStatus, syncAutoResult, updateRun } from '../../../src/registry/runs-store.js';
import { createSource } from '../../../src/registry/sources-store.js';
import { linkCoverage } from '../../../src/registry/coverage-store.js';
import { createProposal } from '../../../src/registry/proposals-store.js';
import { upsertDefect } from '../../../src/registry/defects-store.js';
import { createTempRegistry, seedCase, seedProject, type TempRegistry } from './temp-db.js';

describe('агрегати дашборда', () => {
  let temp: TempRegistry;

  beforeEach(() => {
    temp = createTempRegistry();
  });

  afterEach(() => {
    temp.cleanup();
  });

  it('рахує кейси за статусом, автоматизацією і пріоритетом', () => {
    const { project, section } = seedProject();
    seedCase(project.id, section.id, { title: 'A', status: 'approved', priority: 'P1' });
    seedCase(project.id, section.id, { title: 'B', status: 'approved', priority: 'P2' });
    seedCase(project.id, section.id, { title: 'C', status: 'draft', priority: 'P2' });
    seedCase(project.id, section.id, {
      title: 'D',
      status: 'draft',
      automation: { status: 'automated', scenarioPath: 'scenarios/x.yaml' },
    });

    const data = dashboard(project.id);
    expect(data.project.key).toBe('CYBER');
    expect(data.cases.total).toBe(4);
    expect(data.cases.byStatus).toEqual({ draft: 2, in_review: 0, approved: 2, deprecated: 0 });
    expect(data.cases.byAutomation).toEqual({ manual: 3, candidate: 0, automated: 1, quarantined: 0 });
    // Кейс D без явного пріоритету отримує дефолт P2.
    expect(data.cases.byPriority).toEqual({ P1: 1, P2: 3, P3: 0, P4: 0 });
  });

  it('рахує покриття, прогалини й частку derived', () => {
    const { project, section } = seedProject();
    const caseA = seedCase(project.id, section.id, { title: 'Покритий' });
    const caseB = seedCase(project.id, section.id, { title: 'Домисел' });
    seedCase(project.id, section.id, { title: 'Без джерела' });

    const { blocks } = createSource({
      projectId: project.id,
      kind: 'paste',
      title: 'Вимоги',
      blocks: [
        { heading: 'Розділ 1', text: 'Клієнт бачить акти', position: 0 },
        { heading: 'Розділ 2', text: 'Клієнт підписує договір', position: 1 },
        { heading: 'Розділ 3', text: 'Нічого не покрито', position: 2 },
      ],
    });

    linkCoverage({ blockId: blocks[0].id, caseId: caseA.id, kind: 'quote', confirmed: true });
    linkCoverage({ blockId: blocks[1].id, caseId: caseB.id, kind: 'derived' });

    const data = dashboard(project.id);
    expect(data.coverage.blocks).toBe(3);
    expect(data.coverage.coveredBlocks).toBe(2);
    expect(data.coverage.gaps).toBe(1);
    expect(data.coverage.derivedShare).toBe(0.5);
    expect(data.coverage.casesWithSource).toBe(2);
  });

  it('flakeScore — частка failed+healed серед останніх 10 результатів', () => {
    const { project, section } = seedProject();
    const flaky = seedCase(project.id, section.id, { title: 'Нестабільний' });
    const stable = seedCase(project.id, section.id, { title: 'Стабільний' });

    // 4 результати: passed, failed, healed, passed → 2/4 = 0.5
    const statuses: Array<'passed' | 'failed' | 'healed'> = ['passed', 'failed', 'healed', 'passed'];
    for (const status of statuses) {
      const run = createRun({ projectId: project.id, caseIds: [flaky.id, stable.id] });
      if (status === 'healed') {
        syncAutoResult(run.id, flaky.id, { autoRunId: `engine-${run.id}`, engineStatus: 'passed', healed: true });
      } else {
        setItemStatus(run.id, flaky.id, { status });
      }
      setItemStatus(run.id, stable.id, { status: 'passed' });
    }

    const scores = new Map(flakeScores(project.id).map((row) => [row.caseId, row]));
    expect(scores.get(flaky.id)?.results).toBe(4);
    expect(scores.get(flaky.id)?.flakeScore).toBe(0.5);
    expect(scores.get(stable.id)?.flakeScore).toBe(0);
    // healed віддається в API як passed
    expect(scores.get(flaky.id)?.lastResult).toBe('passed');

    const data = dashboard(project.id);
    expect(data.flaky.map((row) => row.caseId)).toEqual([flaky.id]);
    expect(data.flaky[0].flakeScore).toBe(0.5);

    persistFlakeScores(project.id);
    expect(getCase(flaky.id)?.automation.flakeScore).toBe(0.5);
    expect(getCase(stable.id)?.automation.flakeScore).toBe(0);
  });

  it('враховує лише останні 10 результатів', () => {
    const { project, section } = seedProject();
    const target = seedCase(project.id, section.id, { title: 'Довга історія' });

    // 5 падінь, потім 10 успіхів → серед останніх 10 падінь немає
    for (let i = 0; i < 5; i += 1) {
      const run = createRun({ projectId: project.id, caseIds: [target.id] });
      setItemStatus(run.id, target.id, { status: 'failed' });
    }
    for (let i = 0; i < 10; i += 1) {
      const run = createRun({ projectId: project.id, caseIds: [target.id] });
      setItemStatus(run.id, target.id, { status: 'passed' });
    }

    const [row] = flakeScores(project.id);
    expect(row.results).toBe(10);
    expect(row.flakeScore).toBe(0);
  });

  it('рахує прогони, passRate за 7 днів і відкриті', () => {
    const { project, section } = seedProject();
    const a = seedCase(project.id, section.id, { title: 'A' });
    const b = seedCase(project.id, section.id, { title: 'B' });

    const closed = createRun({ projectId: project.id, caseIds: [a.id, b.id], title: 'Закритий' });
    setItemStatus(closed.id, a.id, { status: 'passed' });
    setItemStatus(closed.id, b.id, { status: 'failed' });
    updateRun(closed.id, { state: 'completed' });

    createRun({ projectId: project.id, caseIds: [a.id], title: 'Відкритий' });

    const data = dashboard(project.id);
    expect(data.runs.last7d).toBe(2);
    expect(data.runs.last30d).toBe(2);
    expect(data.runs.open).toBe(1);
    expect(data.runs.passRate7d).toBe(0.5);
    expect(data.runs.recent).toHaveLength(2);
    expect(data.runs.recent[0].summary.total).toBeGreaterThan(0);
  });

  it('passRate = null, коли результатів немає', () => {
    const { project, section } = seedProject();
    const a = seedCase(project.id, section.id, { title: 'A' });
    createRun({ projectId: project.id, caseIds: [a.id] });
    expect(dashboard(project.id).runs.passRate7d).toBeNull();
  });

  it('зводить модулі першого рівня з підсекціями', () => {
    const { project, section, child } = seedProject();
    const inParent = seedCase(project.id, section.id, { title: 'У батьку' });
    const inChild = seedCase(project.id, child.id, {
      title: 'У підсекції',
      automation: { status: 'automated', scenarioPath: 'scenarios/x.yaml' },
    });

    const run = createRun({ projectId: project.id, caseIds: [inParent.id, inChild.id] });
    setItemStatus(run.id, inParent.id, { status: 'passed' });
    setItemStatus(run.id, inChild.id, { status: 'failed' });

    const data = dashboard(project.id);
    expect(data.modules).toHaveLength(1);
    expect(data.modules[0]).toMatchObject({
      sectionId: section.id,
      name: 'Карта договору',
      cases: 2,
      automated: 1,
      passRate: 0.5,
      gaps: 2,
    });
  });

  it('черга рішень: пропозиції, дрейф, відкриті дефекти', () => {
    const { project, section } = seedProject();
    const target = seedCase(project.id, section.id, { title: 'Кейс' });

    createProposal({ projectId: project.id, kind: 'case_create', title: 'Новий кейс', payload: {} });
    upsertDefect({ projectId: project.id, title: 'Падає кнопка', caseId: target.id });
    upsertDefect({ projectId: project.id, title: 'Падає кнопка', caseId: target.id });

    setTestrailMeta(target.id, { caseId: 42, syncedAt: '2000-01-01T00:00:00.000Z' });
    updateCase(target.id, { title: 'Кейс змінено' }, { reason: 'дрейф' });

    const data = dashboard(project.id);
    expect(data.pending.proposals).toBe(1);
    expect(data.pending.openDefects).toBe(1);
    expect(data.pending.drift).toBe(1);
    expect(driftCount(project.id)).toBe(1);
  });

  it('дефект дедуплікується за caseId + нормалізованим заголовком', () => {
    const { project, section } = seedProject();
    const target = seedCase(project.id, section.id, { title: 'Кейс' });

    const first = upsertDefect({ projectId: project.id, title: 'Кнопка НЕ працює!', caseId: target.id });
    const second = upsertDefect({ projectId: project.id, title: 'кнопка не працює', caseId: target.id });
    const other = upsertDefect({ projectId: project.id, title: 'Інша проблема', caseId: target.id });

    expect(second.id).toBe(first.id);
    expect(second.seenCount).toBe(2);
    expect(other.id).not.toBe(first.id);
  });

  it('порожній проєкт дає нулі, а не падає', () => {
    const { project } = seedProject();
    const data = dashboard(project.id);
    expect(data.cases.total).toBe(0);
    expect(data.coverage.blocks).toBe(0);
    expect(data.runs.passRate7d).toBeNull();
    expect(data.flaky).toEqual([]);
  });
});
