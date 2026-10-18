/**
 * Побічні ефекти циклу «QA направляє, агент робить» — в одному місці, щоб
 * маршрути, MCP і фонові задачі поводились однаково:
 *  - погоджений план модуля → задачі `add_test` на кожен новий кейс;
 *  - погоджена зміна кейса з тестами → `change_test`;
 *  - відхилена чернетка, яку зарезервував агент → `remove_test`;
 *  - червоне на main → `triage`, пройшло з повторами → `stabilize`;
 *  - картинка без тексту → `read_asset`.
 * Усі задачі мають ключ дедуплікації: повторна подія не плодить дублів.
 */
import { createTask, completeTask, listTasks, type ActorKind } from '../registry/tasks-store.js';
import { getProposal, type ApproveResult } from '../registry/proposals-store.js';
import { getCase, updateCase } from '../registry/cases-store.js';
import { setTestState, testsForCase, type IngestRunOutcome } from '../registry/code-tests-store.js';
import { upsertDefect } from '../registry/defects-store.js';
import { requireProject } from '../registry/projects-store.js';
import { enqueueNotification } from '../registry/notifications-store.js';
import { query, type Row } from '../registry/db.js';
import { isNoAgents } from '../registry/sources-store.js';
import type { Asset, Proposal, Task } from '../registry/types.js';

/** Після погодження пропозицій: задачі на тести й закриття задач плану. */
export function afterProposalsApproved(proposalIds: readonly string[], result: ApproveResult, reviewer: string): string[] {
  const createdTasks: string[] = [];
  const approved = new Set(result.approved);
  const planTasks = new Set<string>();
  let createdIndex = 0;

  for (const id of proposalIds) {
    if (!approved.has(id)) continue;
    const proposal = getProposal(id);
    if (!proposal) continue;
    if (proposal.kind === 'case_create') {
      const caseId = result.created[createdIndex];
      createdIndex += 1;
      if (proposal.origin?.taskId) planTasks.add(proposal.origin.taskId);
      if (caseId && proposal.origin?.taskId) {
        createdTasks.push(addTestTask(proposal.projectId, caseId, reviewer));
      }
    } else if (proposal.kind === 'case_update') {
      const caseId = (proposal.payload as { caseId?: string } | null)?.caseId ?? proposal.origin?.caseId;
      if (!caseId) continue;
      if (proposal.origin?.reserved) continue;
      if (testsForCase(caseId).length === 0) continue;
      const caseRecord = getCase(caseId);
      const { task, created } = createTask({
        projectId: proposal.projectId,
        kind: 'change_test',
        title: `Оновити тести: ${caseRecord?.title ?? caseId}`,
        text: `Кейс змінено (${proposal.title}). Онови тести так, щоб вони перевіряли нове формулювання.`,
        anchor: { caseId },
        priority: caseRecord?.priority,
        author: reviewer,
        authorKind: 'system',
        dedupKey: `change_test:${caseId}`,
      });
      if (created) createdTasks.push(task.id);
    }
  }

  for (const taskId of planTasks) closePlanIfDecided(taskId, reviewer);
  return createdTasks;
}

/** Після відхилення: чернетка агента без погодження → прибрати тест. */
export function afterProposalsRejected(proposals: Proposal[], reviewer: string): string[] {
  const createdTasks: string[] = [];
  const planTasks = new Set<string>();
  for (const proposal of proposals) {
    if (proposal.origin?.taskId) planTasks.add(proposal.origin.taskId);
    if (!proposal.origin?.reserved || !proposal.origin.caseId) continue;
    const caseId = proposal.origin.caseId;
    const caseRecord = getCase(caseId);
    if (caseRecord && caseRecord.status !== 'deprecated') {
      updateCase(caseId, { status: 'deprecated' }, { author: reviewer, reason: 'QA відхилив кейс, зарезервований агентом' });
    }
    if (testsForCase(caseId).length === 0 && !hasPendingReport(caseId)) continue;
    const { task, created } = createTask({
      projectId: proposal.projectId,
      kind: 'remove_test',
      title: `Прибрати тест: ${caseRecord?.title ?? caseId}`,
      text: 'QA не погодив цей кейс — тест, що його перевіряє, треба прибрати.',
      anchor: { caseId },
      author: reviewer,
      authorKind: 'system',
      dedupKey: `remove_test:${caseId}`,
    });
    if (created) createdTasks.push(task.id);
  }
  for (const taskId of planTasks) closePlanIfDecided(taskId, reviewer);
  return createdTasks;
}

function hasPendingReport(caseId: string): boolean {
  return Boolean(
    query<Row>(`SELECT 1 FROM tasks WHERE json_extract(anchor, '$.caseId') = ? AND state IN ('claimed', 'review') LIMIT 1`, [caseId])
      .length,
  );
}

function addTestTask(projectId: string, caseId: string, author: string): string {
  const caseRecord = getCase(caseId);
  const { task } = createTask({
    projectId,
    kind: 'add_test',
    title: `Тест: ${caseRecord?.title ?? caseId}`,
    text: 'Кейс із погодженого плану модуля. Напиши тест за конвенціями, ID кейса — у назві тесту.',
    anchor: { caseId },
    priority: caseRecord?.priority,
    author,
    authorKind: 'system',
    dedupKey: `add_test:${caseId}`,
  });
  return task.id;
}

/** Задача плану закривається, коли всі її пропозиції вирішено. */
function closePlanIfDecided(taskId: string, reviewer: string): void {
  const pending = query<Row>(
    `SELECT COUNT(*) AS n FROM proposals WHERE state = 'pending' AND json_extract(origin, '$.taskId') = ?`,
    [taskId],
  );
  if (Number(pending[0]?.n ?? 0) > 0) return;
  const task = query<Row>(`SELECT state FROM tasks WHERE id = ?`, [taskId])[0];
  if (!task || task.state !== 'review') return;
  completeTask(taskId, reviewer, 'qa', 'План модуля розглянуто, задачі на тести створено');
}

/** Червоне на main → розбір; пройшло з повторами → стабілізація; сповіщення. */
export function afterIngest(projectId: string, event: 'pr' | 'main' | 'local', sha: string, outcome: IngestRunOutcome, runUrl?: string): string[] {
  if (event !== 'main') return [];
  const project = requireProject(projectId);
  const created: string[] = [];

  for (const failed of outcome.failedTests) {
    const { task, created: isNew } = createTask({
      projectId,
      kind: 'triage',
      title: `Розібрати падіння: ${failed.name}`,
      text: [
        `Тест упав на main @ ${sha.slice(0, 7)}.`,
        `Файл: ${failed.file}`,
        failed.error ? `Помилка:\n${failed.error.slice(0, 2000)}` : '',
        'Класифікуй: баг продукту, баг тесту, флейк чи середовище. Асерти не змінюй.',
      ]
        .filter(Boolean)
        .join('\n'),
      anchor: { testId: failed.testId, file: failed.file, caseId: failed.caseIds[0], runId: outcome.runId },
      priority: 'P1',
      author: 'ci',
      authorKind: 'system',
      dedupKey: `triage:${failed.testId}`,
    });
    if (isNew) created.push(task.id);
  }

  for (const flaky of outcome.flakyTests) {
    const { task, created: isNew } = createTask({
      projectId,
      kind: 'stabilize',
      title: `Стабілізувати флейк: ${flaky.name}`,
      text: `Тест пройшов на main лише з повторами (${sha.slice(0, 7)}). Знайди причину нестабільності; перевірки не послаблюй.`,
      anchor: { testId: flaky.testId, file: flaky.file, caseId: flaky.caseIds[0] },
      author: 'ci',
      authorKind: 'system',
      dedupKey: `stabilize:${flaky.testId}`,
    });
    if (isNew) created.push(task.id);
  }

  if (outcome.failed > 0) {
    enqueueNotification({ kind: 'main_red', project: project.name, sha, failed: outcome.failed, url: runUrl }, projectId);
  }
  return created;
}

/** Картинка, зміст якої лише в пікселях, → агент описує, QA погоджує. */
export function requestReading(asset: Asset, author: string, authorKind: ActorKind = 'system'): string | null {
  if (asset.readingState !== 'needed') return null;
  // Сторінка (або її предок) «не віддавати агентам»: картинку читає лише QA, задачі агентам немає.
  if (isNoAgents(asset.sourceId)) return null;
  const { task, created } = createTask({
    projectId: asset.projectId,
    kind: 'read_asset',
    title: `Прочитати ${asset.kind === 'diagram' ? 'схему' : 'зображення'}: ${asset.name}`,
    text: 'Опиши, що на картинці: кроки флоу, поля, умови, стани, тексти. Опис погоджує QA, далі за ним пишуться кейси.',
    anchor: { assetId: asset.id, blockId: asset.blockId, sourceId: asset.sourceId },
    author,
    authorKind,
    dedupKey: `read_asset:${asset.sha256 ?? asset.id}`,
  });
  return created ? task.id : null;
}

/**
 * Задача «спланувати модуль», якщо модуль ще не планували. Закритий чи
 * відхилений план не перезапускається повторним призначенням модулів;
 * невдалий — повертається в чергу через дедуплікацію.
 */
export function requestModulePlan(projectId: string, sectionId: string, sectionName: string, author: string): string | null {
  const planned = listTasks({ projectId, kinds: ['plan_module'], sectionId, states: ['new', 'queued', 'claimed', 'needs_info', 'review', 'done', 'rejected'] });
  if (planned.total > 0) return null;
  const { task, created } = createTask({
    projectId,
    kind: 'plan_module',
    title: `Спланувати покриття модуля «${sectionName}»`,
    text:
      'Склади інвентар поведінки модуля (маршрути, API, сервіси, бізнес-правила) і план кейсів за вимогами, ' +
      'макетами й кодом. Відправ план через qa_propose_plan — QA погодить, далі будуть задачі на тести.',
    anchor: { sectionId },
    priority: 'P1',
    author,
    authorKind: 'system',
    dedupKey: `plan_module:${sectionId}`,
  });
  return created ? task.id : null;
}

export const triageSchemaShape = ['product_bug', 'test_bug', 'flaky', 'environment'] as const;
export type TriageClass = (typeof triageSchemaShape)[number];

/**
 * Наслідки розбору падіння: баг продукту → дефект; баг тесту → задача на зміну
 * тесту через QA; флейк → карантин і стабілізація; середовище → лише запис.
 * Асерти під час розбору не змінюються — це окремі задачі з погодженням QA.
 */
export function applyTriage(
  task: Task,
  triage: { classification: TriageClass; defectTitle?: string; severity?: 'low' | 'medium' | 'high' | 'critical'; note?: string },
  author: string,
): { defectId?: string; taskId?: string } {
  const anchor = task.anchor;
  switch (triage.classification) {
    case 'product_bug': {
      const defect = upsertDefect({
        projectId: task.projectId,
        title: triage.defectTitle ?? task.title.replace(/^Розібрати падіння: /, ''),
        details: triage.note ?? '',
        severity: triage.severity ?? 'high',
        caseId: anchor.caseId,
      });
      return { defectId: defect.id };
    }
    case 'test_bug': {
      const { task: created } = createTask({
        projectId: task.projectId,
        kind: 'change_test',
        title: `Виправити тест: ${task.title.replace(/^Розібрати падіння: /, '')}`,
        text: `Розбір ${task.id}: падіння спричинене самим тестом.\n${triage.note ?? ''}`.trim(),
        anchor: { testId: anchor.testId, caseId: anchor.caseId, file: anchor.file },
        author,
        authorKind: 'agent',
        dedupKey: `change_test:test:${anchor.testId ?? task.id}`,
      });
      return { taskId: created.id };
    }
    case 'flaky': {
      if (anchor.testId) setTestState(anchor.testId, 'quarantined');
      const { task: created } = createTask({
        projectId: task.projectId,
        kind: 'stabilize',
        title: `Стабілізувати флейк: ${task.title.replace(/^Розібрати падіння: /, '')}`,
        text: `Розбір ${task.id}: тест нестабільний, його поставлено в карантин.\n${triage.note ?? ''}`.trim(),
        anchor: { testId: anchor.testId, caseId: anchor.caseId, file: anchor.file },
        author,
        authorKind: 'agent',
        dedupKey: `stabilize:${anchor.testId ?? task.id}`,
      });
      return { taskId: created.id };
    }
    default:
      return {};
  }
}
