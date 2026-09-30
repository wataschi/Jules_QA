/**
 * Скіл `validate-coverage`: аудит покриття вимог наявними кейсами.
 *
 * Шукає чотири речі:
 *   - `gaps` — фрагмент вимоги без жодного кейса + готова пропозиція кейса;
 *   - `duplicates` — кейси, що перевіряють те саме;
 *   - `untestable` — кейси без перевірної умови;
 *   - `contradictions` — кейс очікує інше, ніж написано у вимозі.
 *
 * Один блок = один запит до моделі; результати агрегуються тут. Усе, що модель
 * вигадала (невідомі id кейсів, прогалини без фрагмента, пропозиції без
 * перевірної умови), відсіюється детерміновано й іде в `warnings`.
 *
 * Чиста функція: нічого не пише в базу.
 */
import { z } from 'zod';
import type { CaseKind } from '../types.js';
import { askJson, isModelUnavailable, mergeUsage, type SkillUsage } from './model.js';
import {
  buildValidateCoverageSystemPrompt,
  buildValidateCoverageUserPrompt,
} from './prompts.js';
import {
  isVagueCheck,
  normalizeDraftCases,
  type DraftCase,
  type RawCase,
} from './write-cases.js';

export type { SkillUsage };

export interface ValidateCoverageInput {
  blocks: Array<{ id: string; heading: string; text: string }>;
  cases: Array<{ id: string; title: string; checks: string[]; kind: CaseKind }>;
  sectionPath: string;
}

export interface CoverageReport {
  gaps: Array<{ blockId: string; fragment: string; suggestion: DraftCase['case'] }>;
  duplicates: Array<{ caseIds: string[]; reason: string }>;
  untestable: Array<{ caseId: string; reason: string }>;
  contradictions: Array<{ caseId: string; blockId: string; reason: string }>;
}

export interface ValidateCoverageResult {
  report: CoverageReport;
  usage: SkillUsage;
  warnings: string[];
}

export const DEFAULT_LANGUAGE = 'Ukrainian';

/* ───────────────────────── схема відповіді моделі ─────────────────────── */

const suggestionSchema = z.object({
  title: z.string().min(1),
  kind: z.string().optional(),
  priority: z.string().optional(),
  preconditions: z.string().optional(),
  checks: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});

export const coverageResponseSchema = z.object({
  gaps: z
    .array(
      z.object({
        blockId: z.string().optional(),
        fragment: z.string().default(''),
        suggestion: suggestionSchema.optional(),
      }),
    )
    .default([]),
  duplicates: z
    .array(z.object({ caseIds: z.array(z.string()).default([]), reason: z.string().default('') }))
    .default([]),
  untestable: z
    .array(z.object({ caseId: z.string(), reason: z.string().default('') }))
    .default([]),
  contradictions: z
    .array(
      z.object({
        caseId: z.string(),
        blockId: z.string().optional(),
        reason: z.string().default(''),
      }),
    )
    .default([]),
});

/* ──────────────────────────── агрегація ──────────────────────────────── */

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function dedupKeyForCaseIds(caseIds: string[]): string {
  return [...caseIds].sort().join('|');
}

/**
 * Локальна (без моделі) перевірка «кейс без перевірної умови»: порожні checks
 * або лише загальні слова. Дешево, надійно, не залежить від сумління моделі.
 */
export function findLocallyUntestable(
  cases: ValidateCoverageInput['cases'],
): CoverageReport['untestable'] {
  const out: CoverageReport['untestable'] = [];
  for (const item of cases) {
    const meaningful = item.checks.filter((check) => !isVagueCheck(check));
    if (item.checks.length === 0) {
      out.push({ caseId: item.id, reason: 'Немає жодної перевірки (checks порожній).' });
    } else if (meaningful.length === 0) {
      out.push({
        caseId: item.id,
        reason: 'Усі перевірки — загальні слова без спостережуваної умови.',
      });
    }
  }
  return out;
}

/**
 * Перевіряє покриття блоків вимог наявними кейсами.
 *
 * Помилка на окремому блоці не валить запуск (йде в `warnings`); якщо моделі
 * немає взагалі — кидаємо помилку з людським повідомленням.
 */
export async function validateCoverage(
  input: ValidateCoverageInput,
): Promise<ValidateCoverageResult> {
  const startedAt = Date.now();
  const warnings: string[] = [];
  const usageParts: SkillUsage[] = [];

  const knownCaseIds = new Set(input.cases.map((item) => item.id));
  const knownBlockIds = new Set(input.blocks.map((block) => block.id));

  const gaps: CoverageReport['gaps'] = [];
  const duplicates: CoverageReport['duplicates'] = [];
  const untestable: CoverageReport['untestable'] = [];
  const contradictions: CoverageReport['contradictions'] = [];

  const seenDuplicates = new Set<string>();
  const seenUntestable = new Set<string>();
  const seenContradictions = new Set<string>();
  const seenGaps = new Set<string>();

  // Локальні `untestable` додаємо першими — вони точні.
  for (const item of findLocallyUntestable(input.cases)) {
    seenUntestable.add(item.caseId);
    untestable.push(item);
  }

  const systemPrompt = buildValidateCoverageSystemPrompt({ language: DEFAULT_LANGUAGE });
  const casesForModel = input.cases.map((item) => ({
    id: item.id,
    title: item.title,
    checks: item.checks,
    kind: item.kind,
  }));

  let firstError: unknown;
  let analyzedBlocks = 0;

  for (const block of input.blocks) {
    if (!block.text || block.text.trim().length === 0) {
      warnings.push(`Блок ${block.id} порожній — пропущено.`);
      continue;
    }

    let value: z.infer<typeof coverageResponseSchema>;
    try {
      const result = await askJson({
        role: 'critic',
        system: systemPrompt,
        user: buildValidateCoverageUserPrompt({
          sectionPath: input.sectionPath,
          block,
          cases: casesForModel,
        }),
        schema: coverageResponseSchema,
      });
      usageParts.push(result.usage);
      value = result.value;
      analyzedBlocks += 1;
    } catch (error) {
      if (isModelUnavailable(error)) throw error;
      firstError ??= error;
      warnings.push(
        `Блок ${block.id}: перевірка покриття не вдалася — ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    /* прогалини */
    for (const gap of value.gaps) {
      const fragment = normalizeText(gap.fragment);
      if (!fragment) {
        warnings.push(`Блок ${block.id}: прогалину без фрагмента вимоги пропущено.`);
        continue;
      }
      if (!gap.suggestion) {
        warnings.push(`Блок ${block.id}: прогалина «${fragment.slice(0, 60)}…» без пропозиції кейса.`);
        continue;
      }
      // Пропозиція проходить той самий санітайзер, що й кейси write-cases.
      const raw: RawCase = {
        coverageKind: 'quote',
        rationale: `Закриває прогалину покриття: ${fragment.slice(0, 160)}`,
        title: gap.suggestion.title,
        kind: gap.suggestion.kind,
        priority: gap.suggestion.priority,
        preconditions: gap.suggestion.preconditions,
        checks: gap.suggestion.checks,
        tags: gap.suggestion.tags,
      };
      const normalized = normalizeDraftCases([raw], {
        blockId: block.id,
        blockHeading: block.heading,
        maxPerBlock: 1,
      });
      warnings.push(...normalized.warnings);
      const draft = normalized.drafts[0];
      if (!draft) continue;

      const key = `${block.id}::${fragment.toLowerCase()}`;
      if (seenGaps.has(key)) continue;
      seenGaps.add(key);
      gaps.push({ blockId: block.id, fragment, suggestion: draft.case });
    }

    /* дублі */
    for (const duplicate of value.duplicates) {
      const ids = [...new Set(duplicate.caseIds.filter((id) => knownCaseIds.has(id)))];
      if (ids.length < 2) {
        warnings.push(
          `Блок ${block.id}: запис про дублі пропущено — менше двох відомих кейсів (${duplicate.caseIds.join(', ') || '—'}).`,
        );
        continue;
      }
      const key = dedupKeyForCaseIds(ids);
      if (seenDuplicates.has(key)) continue;
      seenDuplicates.add(key);
      duplicates.push({ caseIds: ids, reason: normalizeText(duplicate.reason) });
    }

    /* кейси без перевірної умови */
    for (const item of value.untestable) {
      if (!knownCaseIds.has(item.caseId)) {
        warnings.push(`Блок ${block.id}: невідомий кейс ${item.caseId} в untestable — пропущено.`);
        continue;
      }
      if (seenUntestable.has(item.caseId)) continue;
      seenUntestable.add(item.caseId);
      untestable.push({ caseId: item.caseId, reason: normalizeText(item.reason) });
    }

    /* суперечності вимога ↔ кейс */
    for (const item of value.contradictions) {
      if (!knownCaseIds.has(item.caseId)) {
        warnings.push(
          `Блок ${block.id}: невідомий кейс ${item.caseId} в contradictions — пропущено.`,
        );
        continue;
      }
      const blockId = item.blockId && knownBlockIds.has(item.blockId) ? item.blockId : block.id;
      const key = `${item.caseId}::${blockId}`;
      if (seenContradictions.has(key)) continue;
      seenContradictions.add(key);
      contradictions.push({ caseId: item.caseId, blockId, reason: normalizeText(item.reason) });
    }
  }

  if (analyzedBlocks === 0 && firstError) {
    throw firstError;
  }

  return {
    report: { gaps, duplicates, untestable, contradictions },
    usage: mergeUsage(usageParts, startedAt),
    warnings,
  };
}
