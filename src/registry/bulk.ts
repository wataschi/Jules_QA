/**
 * Масові операції над кейсами.
 *
 *  - `dryRun=true` (дефолт) нічого не змінює: віддає `preview` (до 200 рядків)
 *    і ТОЧНУ кількість входжень, а не оцінку;
 *  - застосування йде в одній транзакції; усі ревізії пакета позначаються
 *    спільним `batchId`, тому `POST /cases/bulk/undo` може його відкотити;
 *  - `replace-text` працює по `title`, `preconditions`, кожному елементу
 *    `checks[]` і по `steps[].action/expected`, з регексом і врахуванням
 *    регістру за прапорцем.
 */
import { tx } from './db.js';
import { newId } from './ids.js';
import {
  deleteCase,
  getCasesByIds,
  requireCase,
  resolveCaseIds,
  restoreCaseFromSnapshot,
  updateCase,
  type CasePatch,
} from './cases-store.js';
import { listBatchRevisions } from './revisions-store.js';
import {
  automationStatusSchema,
  bulkRequestSchema,
  caseKindSchema,
  casePrioritySchema,
  caseStatusSchema,
  type BulkOp,
  type BulkPreviewRow,
  type BulkRequest,
  type BulkResult,
  type Case,
  type CaseStep,
} from './types.js';

export const PREVIEW_LIMIT = 200;

interface CasePlan {
  caseId: string;
  title: string;
  patch: CasePatch;
  hardDelete: boolean;
  softDelete: boolean;
  rows: BulkPreviewRow[];
  occurrences: number;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildMatcher(op: Extract<BulkOp, { op: 'replace-text' }>): RegExp {
  const flags = op.caseSensitive ? 'g' : 'gi';
  const source = op.regex ? op.find : escapeRegex(op.find);
  try {
    return new RegExp(source, flags);
  } catch (error) {
    throw new Error(
      `Некоректний регулярний вираз «${op.find}»: ${error instanceof Error ? error.message : 'помилка розбору'}`,
    );
  }
}

function countMatches(text: string, matcher: RegExp): number {
  if (!text) return 0;
  matcher.lastIndex = 0;
  let count = 0;
  let match: RegExpExecArray | null = matcher.exec(text);
  while (match !== null) {
    count += 1;
    // Захист від нескінченного циклу на матчі нульової довжини.
    if (match[0] === '') matcher.lastIndex += 1;
    if (count > 100_000) break;
    match = matcher.exec(text);
  }
  matcher.lastIndex = 0;
  return count;
}

function replaceAll(text: string, matcher: RegExp, replacement: string): string {
  matcher.lastIndex = 0;
  return text.replace(matcher, replacement);
}

function planReplaceText(target: Case, op: Extract<BulkOp, { op: 'replace-text' }>): CasePlan {
  const matcher = buildMatcher(op);
  const plan: CasePlan = {
    caseId: target.id,
    title: target.title,
    patch: {},
    hardDelete: false,
    softDelete: false,
    rows: [],
    occurrences: 0,
  };

  const pushRow = (field: string, before: string, after: string, occurrences: number): void => {
    plan.rows.push({ caseId: target.id, title: target.title, field, before, after, occurrences });
    plan.occurrences += occurrences;
  };

  for (const field of op.fields) {
    if (field === 'title' || field === 'preconditions') {
      const before = field === 'title' ? target.title : target.preconditions;
      const hits = countMatches(before, matcher);
      if (hits === 0) continue;
      const after = replaceAll(before, matcher, op.replace);
      if (after === before) continue;
      plan.patch[field] = after;
      pushRow(field, before, after, hits);
      continue;
    }

    if (field === 'checks') {
      const nextChecks = [...target.checks];
      let changed = false;
      target.checks.forEach((check, index) => {
        const hits = countMatches(check, matcher);
        if (hits === 0) return;
        const after = replaceAll(check, matcher, op.replace);
        if (after === check) return;
        nextChecks[index] = after;
        changed = true;
        pushRow(`checks[${index}]`, check, after, hits);
      });
      if (changed) plan.patch.checks = nextChecks;
      continue;
    }

    if (field === 'steps') {
      const nextSteps: CaseStep[] = target.steps.map((step) => ({ ...step }));
      let changed = false;
      target.steps.forEach((step, index) => {
        for (const key of ['action', 'expected'] as const) {
          const before = step[key] ?? '';
          const hits = countMatches(before, matcher);
          if (hits === 0) continue;
          const after = replaceAll(before, matcher, op.replace);
          if (after === before) continue;
          nextSteps[index][key] = after;
          changed = true;
          pushRow(`steps[${index}].${key}`, before, after, hits);
        }
      });
      if (changed) plan.patch.steps = nextSteps;
    }
  }

  return plan;
}

function planForCase(target: Case, op: BulkOp): CasePlan {
  const empty: CasePlan = {
    caseId: target.id,
    title: target.title,
    patch: {},
    hardDelete: false,
    softDelete: false,
    rows: [],
    occurrences: 0,
  };

  switch (op.op) {
    case 'replace-text':
      return planReplaceText(target, op);

    case 'set-field': {
      const field = op.field;
      const before = field === 'owner' ? (target.owner ?? '') : String(target[field]);
      if (field === 'kind') caseKindSchema.parse(op.value);
      if (field === 'priority') casePrioritySchema.parse(op.value);
      if (field === 'status') caseStatusSchema.parse(op.value);
      if (before === op.value) return empty;
      (empty.patch as Record<string, unknown>)[field] = op.value;
      empty.rows.push({
        caseId: target.id,
        title: target.title,
        field,
        before,
        after: op.value,
        occurrences: 1,
      });
      empty.occurrences = 1;
      return empty;
    }

    case 'add-tag': {
      const next = [...target.tags];
      for (const tag of op.tags) if (!next.includes(tag)) next.push(tag);
      if (next.length === target.tags.length) return empty;
      empty.patch.tags = next;
      empty.rows.push({
        caseId: target.id,
        title: target.title,
        field: 'tags',
        before: target.tags.join(', '),
        after: next.join(', '),
        occurrences: next.length - target.tags.length,
      });
      empty.occurrences = next.length - target.tags.length;
      return empty;
    }

    case 'remove-tag': {
      const next = target.tags.filter((tag) => !op.tags.includes(tag));
      if (next.length === target.tags.length) return empty;
      empty.patch.tags = next;
      empty.rows.push({
        caseId: target.id,
        title: target.title,
        field: 'tags',
        before: target.tags.join(', '),
        after: next.join(', '),
        occurrences: target.tags.length - next.length,
      });
      empty.occurrences = target.tags.length - next.length;
      return empty;
    }

    case 'move': {
      if (target.sectionId === op.sectionId) return empty;
      empty.patch.sectionId = op.sectionId;
      empty.rows.push({
        caseId: target.id,
        title: target.title,
        field: 'sectionId',
        before: target.sectionId,
        after: op.sectionId,
        occurrences: 1,
      });
      empty.occurrences = 1;
      return empty;
    }

    case 'set-automation': {
      automationStatusSchema.parse(op.status);
      if (target.automation.status === op.status) return empty;
      empty.patch.automation = { ...target.automation, status: op.status };
      empty.rows.push({
        caseId: target.id,
        title: target.title,
        field: 'automation.status',
        before: target.automation.status,
        after: op.status,
        occurrences: 1,
      });
      empty.occurrences = 1;
      return empty;
    }

    case 'delete': {
      if (op.hard) {
        empty.hardDelete = true;
      } else {
        if (target.status === 'deprecated') return empty;
        empty.softDelete = true;
      }
      empty.rows.push({
        caseId: target.id,
        title: target.title,
        field: op.hard ? 'deleted' : 'status',
        before: op.hard ? target.title : target.status,
        after: op.hard ? '' : 'deprecated',
        occurrences: 1,
      });
      empty.occurrences = 1;
      return empty;
    }

    default: {
      const never: never = op;
      throw new Error(`Невідома масова операція: ${JSON.stringify(never)}`);
    }
  }
}

function hasChanges(plan: CasePlan): boolean {
  return plan.hardDelete || plan.softDelete || Object.keys(plan.patch).length > 0;
}

function reasonFor(op: BulkOp, request: BulkRequest): string {
  if (request.reason) return request.reason;
  switch (op.op) {
    case 'replace-text':
      return `масова заміна «${op.find}» → «${op.replace}»`;
    case 'set-field':
      return `масова зміна ${op.field} → ${op.value}`;
    case 'add-tag':
      return `масове додавання тегів: ${op.tags.join(', ')}`;
    case 'remove-tag':
      return `масове знімання тегів: ${op.tags.join(', ')}`;
    case 'move':
      return `масове переміщення в секцію ${op.sectionId}`;
    case 'set-automation':
      return `масова зміна автоматизації → ${op.status}`;
    case 'delete':
      return op.hard ? 'масове фізичне видалення' : 'масове переведення в deprecated';
    default:
      return 'масова операція';
  }
}

/** Виконує (або лише показує) масову операцію. */
export function runBulk(input: BulkRequest): BulkResult {
  const request = bulkRequestSchema.parse(input);
  const ids =
    request.caseIds && request.caseIds.length > 0
      ? request.caseIds
      : resolveCaseIds(request.projectId, request.filter ?? {});

  const targets = getCasesByIds(ids).filter((c) => c.projectId === request.projectId);
  const plans = targets.map((target) => planForCase(target, request.operation)).filter(hasChanges);

  const occurrences = plans.reduce((sum, plan) => sum + plan.occurrences, 0);
  const preview = plans.flatMap((plan) => plan.rows).slice(0, PREVIEW_LIMIT);

  if (request.dryRun) {
    return { affected: plans.length, occurrences, preview, applied: false };
  }

  const batchId = newId('batch');
  const reason = reasonFor(request.operation, request);
  const author = request.author ?? 'local';

  tx(() => {
    for (const plan of plans) {
      if (plan.hardDelete) {
        deleteCase(plan.caseId, { hard: true }, { author, reason, batchId });
        continue;
      }
      if (plan.softDelete) {
        updateCase(plan.caseId, { status: 'deprecated' }, { author, reason, batchId });
        continue;
      }
      updateCase(plan.caseId, plan.patch, { author, reason, batchId });
    }
  });

  return { affected: plans.length, occurrences, preview, applied: true, batchId };
}

export interface UndoResult {
  batchId: string;
  reverted: number;
  restored: number;
  removed: number;
  errors: Array<{ caseId: string; error: string }>;
}

/**
 * Відкат пакета: ревізії з `batchId` застосовуються у зворотному порядку,
 * `before`-значення повертаються на місце. Сам відкат теж пише ревізії
 * (з `batchId = undo_<оригінал>`), тому історія лишається повною.
 */
export function undoBulk(batchId: string): UndoResult {
  const revisions = listBatchRevisions(batchId);
  if (revisions.length === 0) {
    throw new Error(`Пакет «${batchId}» не знайдено в історії ревізій`);
  }

  const result: UndoResult = { batchId, reverted: 0, restored: 0, removed: 0, errors: [] };
  const undoBatchId = `undo_${batchId}`;
  const reason = `відкат пакета ${batchId}`;

  tx(() => {
    for (const revision of revisions) {
      try {
        const entries = Object.entries(revision.patch);
        const deleted = entries.find(([field]) => field === 'deleted');
        if (deleted) {
          restoreCaseFromSnapshot(deleted[1].before as Record<string, unknown>);
          result.restored += 1;
          result.reverted += 1;
          continue;
        }
        const created = entries.find(([field]) => field === 'created');
        if (created) {
          deleteCase(revision.caseId, { hard: true }, { author: 'undo', reason, batchId: undoBatchId });
          result.removed += 1;
          result.reverted += 1;
          continue;
        }

        const patch: Record<string, unknown> = {};
        for (const [field, change] of entries) {
          patch[field] = change.before;
        }
        requireCase(revision.caseId);
        updateCase(revision.caseId, patch as CasePatch, {
          author: 'undo',
          reason,
          batchId: undoBatchId,
        });
        result.reverted += 1;
      } catch (error) {
        result.errors.push({
          caseId: revision.caseId,
          error: error instanceof Error ? error.message : 'невідома помилка',
        });
      }
    }
  });

  return result;
}
