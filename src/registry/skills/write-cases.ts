/**
 * Скіл `write-cases`: з блоків вимог робить чернетки тест-кейсів.
 *
 * Схема роботи (два проходи, як у `src/server/ai-assistant.ts`):
 *   для кожного блоку → генератор (один самодостатній запит)
 *                     → критик (другий запит: тавтології, кейси без перевірної
 *                       умови, складені перевірки, пояснення для `derived`)
 *                     → детермінований санітайзер (нижче) — він не покладається
 *                       на сумління моделі й ріже те, що правила забороняють.
 *
 * Скіл — чиста функція: нічого не пише в базу, лише повертає `DraftCase[]`.
 * Запис у чергу апрувів робить `src/server/registry-routes.ts`.
 */
import { z } from 'zod';
import type { CaseKind, CasePriority } from '../types.js';
import { askJson, isModelUnavailable, mergeUsage, type SkillUsage } from './model.js';
import {
  buildCriticSystemPrompt,
  buildCriticUserPrompt,
  buildWriteCasesSystemPrompt,
  buildWriteCasesUserPrompt,
} from './prompts.js';

export type { SkillUsage };

export interface WriteCasesInput {
  blocks: Array<{ id: string; heading: string; text: string }>;
  /** «Кібер / Карта договору / Акти» — контекст для моделі. */
  sectionPath: string;
  projectName: string;
  style?: {
    /** Дефолт 8. */
    maxPerBlock?: number;
    /** Дефолт true — негативні/нейтральні/безпекові. */
    includeDerived?: boolean;
    /** Few-shot зі справжніх кейсів команди. */
    examples?: Array<{ title: string; checks: string[] }>;
    /** Дефолт 'Ukrainian'. */
    language?: string;
  };
}

export interface DraftCase {
  blockId: string;
  coverageKind: 'quote' | 'derived';
  /** Чому цей кейс потрібен — показуємо в черзі апрувів. */
  rationale: string;
  case: {
    title: string;
    kind: CaseKind;
    priority: CasePriority;
    preconditions: string;
    checks: string[];
    tags: string[];
  };
}

export interface WriteCasesResult {
  drafts: DraftCase[];
  usage: SkillUsage;
  warnings: string[];
}

export const DEFAULT_MAX_PER_BLOCK = 8;
export const DEFAULT_LANGUAGE = 'Ukrainian';

/* ───────────────────────── схема відповіді моделі ─────────────────────── */

/**
 * Структура жорстка (масив кейсів, непорожній заголовок), а перелічення —
 * толерантні: якщо модель напише `functional` замість `positive`, дешевше
 * змапити це самим, ніж витрачати повтор запиту.
 */
const rawCaseSchema = z.object({
  coverageKind: z.string().optional(),
  rationale: z.string().optional(),
  title: z.string().min(1),
  kind: z.string().optional(),
  priority: z.string().optional(),
  preconditions: z.string().optional(),
  checks: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});
export type RawCase = z.infer<typeof rawCaseSchema>;

export const writeCasesResponseSchema = z.object({
  cases: z.array(rawCaseSchema).default([]),
});

export const criticResponseSchema = z.object({
  cases: z.array(rawCaseSchema).default([]),
  removed: z.array(z.string()).default([]),
});

/* ───────────────────── детерміновані правила якості ───────────────────── */

/**
 * Слова, з яких сама собою не виходить перевірна умова. Якщо перевірка
 * складається ЛИШЕ з них — це «працює нормально», і такий рядок ми ріжемо.
 */
const FILLER_WORDS = new Set([
  'все',
  'усе',
  'всі',
  'уся',
  'система',
  'сторінка',
  'форма',
  'функціонал',
  'функція',
  'модуль',
  'працює',
  'працюють',
  'відображається',
  'відображаються',
  'показується',
  'коректно',
  'корректно',
  'нормально',
  'правильно',
  'успішно',
  'як',
  'очікується',
  'очікувалось',
  'без',
  'помилок',
  'проблем',
  'збоїв',
  'ок',
  'окей',
  'ok',
  'fine',
  'works',
  'good',
  'перевірити',
  'перевірка',
  'переконатися',
  'що',
  'є',
  'має',
  'бути',
  'і',
  'та',
  'в',
  'у',
  'на',
  'дані',
  'загалом',
]);

/** Руйнівні дії, яких у формулюваннях кейсів бути не повинно. */
const DESTRUCTIVE_RE =
  /(сплатит|оплатит|оплату|платіж|платеж|списат[иь]\s+кошт|списанн?я\s+кошт|зня(ти|ття)\s+кошт|перека(зати|з)\s+кошт|видалит[иь]\s+(акаунт|обліковий|аккаунт|профіль|користувача)|видаленн?я\s+(акаунт|облікового|аккаунт|профіл)|delete\s+account|remove\s+account|drop\s+(table|database)|очистит[иь]\s+базу|масове\s+видаленн?я|видалит[иь]\s+вс[іе])/i;

const KIND_MAP: Record<string, CaseKind> = {
  positive: 'positive',
  pos: 'positive',
  functional: 'positive',
  smoke: 'positive',
  happy: 'positive',
  негативний: 'negative',
  negative: 'negative',
  neg: 'negative',
  validation: 'negative',
  neutral: 'neutral',
  boundary: 'neutral',
  edge: 'neutral',
  нейтральний: 'neutral',
  security: 'security',
  authz: 'security',
  безпека: 'security',
  a11y: 'a11y',
  accessibility: 'a11y',
  performance: 'performance',
  perf: 'performance',
};

const PRIORITY_MAP: Record<string, CasePriority> = {
  p1: 'P1',
  p2: 'P2',
  p3: 'P3',
  p4: 'P4',
  critical: 'P1',
  high: 'P1',
  blocker: 'P1',
  medium: 'P2',
  normal: 'P2',
  low: 'P3',
  minor: 'P3',
  trivial: 'P4',
  cosmetic: 'P4',
  '1': 'P1',
  '2': 'P2',
  '3': 'P3',
  '4': 'P4',
};

export function normalizeKind(value: string | undefined): CaseKind {
  if (!value) return 'positive';
  return KIND_MAP[value.trim().toLowerCase()] ?? 'positive';
}

export function normalizePriority(value: string | undefined): CasePriority {
  if (!value) return 'P2';
  return PRIORITY_MAP[value.trim().toLowerCase()] ?? 'P2';
}

/** Прибирає маркери списку й нумерацію, з якими модель любить віддавати рядки. */
function stripMarkers(text: string): string {
  return text
    .replace(/^\s*(?:[-*•–—▪☐✓]|\d+[.)]|[a-zа-яіїєґ][.)])\s+/iu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Розбиває складену перевірку на атомарні. Ріжемо лише за однозначними
 * межами (`;`, перенос рядка, ` + `) — сполучник «та» в українській надто
 * часто всередині одного твердження, щоб різати по ньому автоматично.
 */
export function splitCompoundCheck(text: string): string[] {
  return text
    .split(/[;\n\r]+|\s+\+\s+/)
    .map(stripMarkers)
    .filter((part) => part.length > 0);
}

/** Перевірка без перевірної умови: лише загальні слова («працює нормально»). */
export function isVagueCheck(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[«»"'`]/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (words.length === 0) return true;
  // Конкретика зазвичай містить лапки, число або назву елемента — якщо в рядку
  // немає жодного «змістовного» слова, перевірити його неможливо.
  return words.every((word) => FILLER_WORDS.has(word));
}

/** Чи формулювання містить руйнівну дію (оплата, видалення акаунта тощо). */
export function isDestructive(text: string): boolean {
  return DESTRUCTIVE_RE.test(text);
}

function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const slug = tag
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/[^\p{L}\p{N}-]/gu, '')
      .replace(/^-+|-+$/g, '');
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
    if (out.length >= 6) break;
  }
  return out;
}

/** Ключ для виявлення тавтологій: заголовок без розділових знаків і регістру. */
function dedupKey(title: string, checks: string[]): string {
  const norm = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  return `${norm(title)}::${checks.map(norm).sort().join('|')}`;
}

export interface NormalizeContext {
  blockId: string;
  blockHeading?: string;
  maxPerBlock: number;
  /** Звідки прийшли кейси — щоб попередження були зрозумілі: 'генератор' | 'критик'. */
  stage?: string;
}

/**
 * Детермінований санітайзер: те, що правила забороняють, ріжеться незалежно
 * від того, чи модель послухалась. Виділено окремо, щоб тестувати без LLM.
 */
export function normalizeDraftCases(
  raw: RawCase[],
  ctx: NormalizeContext,
): { drafts: DraftCase[]; warnings: string[] } {
  const warnings: string[] = [];
  const drafts: DraftCase[] = [];
  const seen = new Set<string>();
  const where = ctx.blockHeading ? `блок «${ctx.blockHeading}»` : `блок ${ctx.blockId}`;

  for (const item of raw) {
    const title = stripMarkers(item.title);
    if (!title) {
      warnings.push(`${where}: кейс без заголовка прибрано.`);
      continue;
    }

    // 3. Складені перевірки розбиваємо, порожні й загальні — ріжемо.
    const checks: string[] = [];
    for (const rawCheck of item.checks) {
      for (const part of splitCompoundCheck(rawCheck)) {
        if (isVagueCheck(part)) {
          warnings.push(`${where}: перевірку «${part}» прибрано — немає спостережуваної умови.`);
          continue;
        }
        if (!checks.includes(part)) checks.push(part);
      }
    }

    // 2. Кейс без перевірної умови не має сенсу — прибираємо разом із кейсом.
    if (checks.length === 0) {
      warnings.push(`${where}: кейс «${title}» прибрано — немає перевірної умови.`);
      continue;
    }

    // 10. Руйнівні дії заборонені у формулюваннях.
    const fullText = [title, item.preconditions ?? '', ...checks].join('\n');
    if (isDestructive(fullText)) {
      warnings.push(`${where}: кейс «${title}» прибрано — містить руйнівну дію (оплата/видалення).`);
      continue;
    }

    // 1. Тавтології: один кейс = одна перевірка, дублі не потрібні.
    const key = dedupKey(title, checks);
    if (seen.has(key)) {
      warnings.push(`${where}: дубль кейса «${title}» прибрано.`);
      continue;
    }
    seen.add(key);

    const coverageKind: 'quote' | 'derived' =
      (item.coverageKind ?? '').trim().toLowerCase() === 'derived' ? 'derived' : 'quote';
    let rationale = (item.rationale ?? '').replace(/\s+/g, ' ').trim();

    // 4. Для `derived` пояснення обов'язкове — інакше в черзі апрувів незрозуміло,
    //    чому ми дописали те, чого немає у вимозі.
    if (coverageKind === 'derived' && rationale.length < 10) {
      warnings.push(
        `${where}: кейс «${title}» позначений derived без пояснення — підставлено загальне rationale.`,
      );
      rationale = 'Перевірки немає у вимозі, але без неї залишається неперекритий ризик.';
    }
    if (!rationale) {
      rationale = 'Перевірка прямо випливає з тексту вимоги.';
    }

    drafts.push({
      blockId: ctx.blockId,
      coverageKind,
      rationale,
      case: {
        title,
        kind: normalizeKind(item.kind),
        priority: normalizePriority(item.priority),
        preconditions: (item.preconditions ?? '').trim(),
        checks,
        tags: normalizeTags(item.tags),
      },
    });
  }

  // 7. Ліміт на блок: лишаємо перші (модель віддає у порядку важливості).
  if (drafts.length > ctx.maxPerBlock) {
    warnings.push(
      `${where}: модель віддала ${drafts.length} кейсів, обрізано до ${ctx.maxPerBlock}.`,
    );
    drafts.length = ctx.maxPerBlock;
  }

  return { drafts, warnings };
}

/* ──────────────────────────────── скіл ──────────────────────────────── */

/** Зворотне перетворення `DraftCase` у форму, яку розуміє промпт критика. */
function draftsToRaw(drafts: DraftCase[]): RawCase[] {
  return drafts.map((draft) => ({
    coverageKind: draft.coverageKind,
    rationale: draft.rationale,
    title: draft.case.title,
    kind: draft.case.kind,
    priority: draft.case.priority,
    preconditions: draft.case.preconditions,
    checks: draft.case.checks,
    tags: draft.case.tags,
  }));
}

/**
 * Генерує чернетки кейсів за блоками вимог.
 *
 * Один блок = один запит генератора + один запит критика. Помилка на окремому
 * блоці не валить увесь запуск (йде в `warnings`); якщо ж моделі немає взагалі
 * або жоден блок не дав кейсів через помилки — кидаємо помилку.
 */
export async function writeCases(input: WriteCasesInput): Promise<WriteCasesResult> {
  const startedAt = Date.now();
  const maxPerBlock = Math.max(1, input.style?.maxPerBlock ?? DEFAULT_MAX_PER_BLOCK);
  const includeDerived = input.style?.includeDerived ?? true;
  const language = input.style?.language ?? DEFAULT_LANGUAGE;

  const warnings: string[] = [];
  const usageParts: SkillUsage[] = [];
  const drafts: DraftCase[] = [];
  let firstError: unknown;

  const systemPrompt = buildWriteCasesSystemPrompt({ language, maxPerBlock, includeDerived });
  const criticSystemPrompt = buildCriticSystemPrompt({ language, maxPerBlock });

  for (const block of input.blocks) {
    if (!block.text || block.text.trim().length === 0) {
      warnings.push(`Блок ${block.id} порожній — пропущено.`);
      continue;
    }

    let generated: DraftCase[];
    try {
      const result = await askJson({
        role: 'planning',
        system: systemPrompt,
        user: buildWriteCasesUserPrompt({
          projectName: input.projectName,
          sectionPath: input.sectionPath,
          block,
          examples: input.style?.examples,
        }),
        schema: writeCasesResponseSchema,
      });
      usageParts.push(result.usage);
      const normalized = normalizeDraftCases(result.value.cases, {
        blockId: block.id,
        blockHeading: block.heading,
        maxPerBlock,
        stage: 'генератор',
      });
      generated = normalized.drafts;
      warnings.push(...normalized.warnings);
    } catch (error) {
      if (isModelUnavailable(error)) throw error;
      firstError ??= error;
      warnings.push(
        `Блок ${block.id}: генерація кейсів не вдалася — ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    if (generated.length === 0) {
      warnings.push(`Блок ${block.id}: модель не дала жодного придатного кейса.`);
      continue;
    }

    // Другий прохід — критик. Best-effort: якщо він не спрацював, беремо чернетки
    // генератора (вони вже пройшли детермінований санітайзер).
    let finalDrafts = generated;
    try {
      const critic = await askJson({
        role: 'critic',
        system: criticSystemPrompt,
        user: buildCriticUserPrompt({
          sectionPath: input.sectionPath,
          block,
          drafts: draftsToRaw(generated),
        }),
        schema: criticResponseSchema,
      });
      usageParts.push(critic.usage);
      const normalized = normalizeDraftCases(critic.value.cases, {
        blockId: block.id,
        blockHeading: block.heading,
        maxPerBlock,
        stage: 'критик',
      });
      if (normalized.drafts.length > 0) {
        finalDrafts = normalized.drafts;
        warnings.push(...normalized.warnings);
        for (const removed of critic.value.removed) {
          const note = removed.replace(/\s+/g, ' ').trim();
          if (note) warnings.push(`Критик прибрав: ${note}`);
        }
      } else {
        warnings.push(`Блок ${block.id}: критик не лишив кейсів — використано чернетки генератора.`);
      }
    } catch (error) {
      if (isModelUnavailable(error)) throw error;
      warnings.push(
        `Блок ${block.id}: прохід критика пропущено — ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    drafts.push(...finalDrafts);
  }

  if (drafts.length === 0 && firstError) {
    throw firstError;
  }

  return { drafts, usage: mergeUsage(usageParts, startedAt), warnings };
}
