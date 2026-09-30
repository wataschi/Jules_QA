/**
 * Обгортка над `chatJson` із `src/config/models.ts` для AI-скілів реєстру.
 *
 * Що додає поверх `chatJson`:
 *  - жорстку zod-схему очікуваного JSON;
 *  - до 2 повторів, причому в наступний запит підкладається текст помилки
 *    валідації (модель бачить, що саме зламала);
 *  - низьку температуру й окремий таймаут;
 *  - облік токенів і часу (`SkillUsage`) для логу запусків скілів.
 *
 * Важливо: один запит = самодостатній контекст. Історія не накопичується —
 * кожен виклик містить усе, що потрібно моделі (так один блок вимог = один
 * запит, і запити можна ганяти паралельно чи повторювати незалежно).
 *
 * Це єдине місце в скілах, яке звертається до моделі, тому в тестах достатньо
 * підмінити цей модуль (`vi.mock('.../skills/model.js')`).
 */
import type { z } from 'zod';
import * as models from '../../config/models.js';

/** Облік одного (або кількох агрегованих) звернення до моделі. */
export interface SkillUsage {
  promptTokens?: number;
  completionTokens?: number;
  model?: string;
  durationMs: number;
}

export type SkillModelRole = 'planning' | 'critic';

export interface AskJsonArgs<T> {
  role: SkillModelRole;
  system: string;
  user: string;
  /**
   * Схема очікуваного JSON. Вхід схеми — `unknown` (модель може віддати
   * будь-що), тому `T` виводиться саме з ВИХОДУ схеми: `.default()` у полях не
   * перетворює результат у «можливо undefined».
   */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  /** Скільки разів перепитати після невалідної відповіді. Дефолт 2. */
  maxRetries?: number;
  /** Дефолт 0.2 — скіли мають бути відтворюваними. */
  temperature?: number;
  /** Дефолт `REGISTRY_SKILL_TIMEOUT` або 120 с. */
  timeoutMs?: number;
}

export interface AskJsonResult<T> {
  value: T;
  usage: SkillUsage;
}

/** Помилка скіла з повідомленням, готовим до показу людині. */
export class SkillModelError extends Error {
  readonly attempts: number;
  /** `true` — моделі взагалі немає (немає сенсу пробувати інші блоки). */
  readonly unavailable: boolean;

  constructor(message: string, attempts = 1, cause?: unknown, unavailable = false) {
    super(message);
    this.name = 'SkillModelError';
    this.attempts = attempts;
    this.unavailable = unavailable;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/** Чи помилка означає «моделі немає» (на відміну від «модель відповіла дурницю»). */
export function isModelUnavailable(error: unknown): boolean {
  return error instanceof SkillModelError && error.unavailable;
}

/** Форма, яку ми очікуємо від (опційного) `chatJsonWithUsage`. */
interface UsageEnvelope {
  value?: unknown;
  data?: unknown;
  json?: unknown;
  result?: unknown;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    model?: string;
  };
  model?: string;
}

type ChatJsonWithUsage = (options: models.ChatJsonOptions) => Promise<UsageEnvelope>;

/**
 * Якщо інший модуль уже додав `chatJsonWithUsage` — беремо його (отримаємо
 * токени). Якщо ні — падаємо на `chatJson`, а токени лишаються `undefined`.
 */
function resolveChatFn(): { fn: ChatJsonWithUsage; withUsage: boolean } {
  let candidate: unknown;
  try {
    candidate = (models as Record<string, unknown>).chatJsonWithUsage;
  } catch {
    // Проба відсутнього експорту може кинути (наприклад, під мок-проксі у тестах).
    candidate = undefined;
  }
  if (typeof candidate === 'function') {
    return { fn: candidate as ChatJsonWithUsage, withUsage: true };
  }
  return {
    fn: async (options) => ({ value: await models.chatJson(options) }),
    withUsage: false,
  };
}

function unwrapEnvelope(raw: UsageEnvelope | unknown, withUsage: boolean): unknown {
  if (!withUsage) {
    const envelope = raw as UsageEnvelope;
    return envelope && typeof envelope === 'object' && 'value' in envelope ? envelope.value : raw;
  }
  const envelope = (raw ?? {}) as UsageEnvelope;
  if (envelope && typeof envelope === 'object') {
    for (const key of ['value', 'data', 'json', 'result'] as const) {
      if (key in envelope && envelope[key] !== undefined) return envelope[key];
    }
  }
  return raw;
}

function readUsage(raw: unknown, fallbackModel: string | undefined): Omit<SkillUsage, 'durationMs'> {
  const envelope = (raw ?? {}) as UsageEnvelope;
  const usage = envelope?.usage;
  return {
    promptTokens: usage?.promptTokens ?? usage?.prompt_tokens,
    completionTokens: usage?.completionTokens ?? usage?.completion_tokens,
    model: usage?.model ?? envelope?.model ?? fallbackModel,
  };
}

/** Складає компактний опис помилки валідації для наступного запиту до моделі. */
export function describeValidationError(error: unknown): string {
  const issues = (error as { issues?: Array<{ path?: unknown[]; message?: string }> })?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    return issues
      .slice(0, 12)
      .map((issue) => {
        const path = Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join('.') : '(корінь)';
        return `${path}: ${issue.message ?? 'невалідне значення'}`;
      })
      .join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

/** Чи це помилка «моделі немає / не налаштована», а не проблема відповіді. */
function isUnavailable(message: string): boolean {
  return /не налаштовано|не задано назву моделі|ECONNREFUSED|fetch failed|ENOTFOUND|timed? ?out|aborted/i.test(
    message,
  );
}

const UNAVAILABLE_HINT =
  'Модель недоступна. Перевірте, що LM Studio (або інший бекенд) запущений і що в .env задані ' +
  'MIDSCENE_MODEL_BASE_URL / MIDSCENE_MODEL_NAME (або PLANNER_MODEL_BASE_URL / PLANNER_MODEL_NAME).';

/**
 * Запитує модель і повертає провалідований JSON.
 *
 * @throws {SkillModelError} якщо модель недоступна або після всіх повторів
 *         відповідь не проходить схему — повідомлення українською, готове до UI.
 */
export async function askJson<T>(args: AskJsonArgs<T>): Promise<AskJsonResult<T>> {
  const startedAt = Date.now();
  const maxRetries = args.maxRetries ?? 2;
  const temperature = args.temperature ?? 0.2;
  const timeoutMs =
    args.timeoutMs ?? Number(process.env.REGISTRY_SKILL_TIMEOUT ?? process.env.MIDSCENE_MODEL_TIMEOUT ?? 120_000);

  const resolved = models.resolveModel(args.role);
  if (!resolved.baseUrl) {
    throw new SkillModelError(UNAVAILABLE_HINT, 0, undefined, true);
  }

  const { fn, withUsage } = resolveChatFn();
  let lastProblem = '';
  let lastCause: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    // Кожна спроба — самодостатній промпт: система + юзер (+ опис минулої помилки).
    const user =
      attempt === 0
        ? args.user
        : `${args.user}\n\n### Попередня спроба була відкинута\n` +
          `Твоя минула відповідь не пройшла валідацію схеми: ${lastProblem}\n` +
          'Поверни ЛИШЕ валідний JSON рівно за схемою, без пояснень, без markdown-огорожі.';

    let raw: unknown;
    try {
      raw = await fn({ role: args.role, system: args.system, user, temperature, timeoutMs });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastCause = error;
      if (isUnavailable(message)) {
        throw new SkillModelError(
          `${UNAVAILABLE_HINT} Технічна деталь: ${message}`,
          attempt + 1,
          error,
          true,
        );
      }
      lastProblem = `модель не повернула JSON (${message})`;
      continue;
    }

    const parsed = args.schema.safeParse(unwrapEnvelope(raw, withUsage));
    if (parsed.success) {
      return {
        value: parsed.data,
        usage: {
          ...readUsage(raw, resolved.name),
          durationMs: Date.now() - startedAt,
        },
      };
    }
    lastProblem = describeValidationError(parsed.error);
    lastCause = parsed.error;
  }

  throw new SkillModelError(
    `Модель ${maxRetries + 1} раз(и) повернула відповідь, яка не відповідає схемі. Остання проблема: ${lastProblem}`,
    maxRetries + 1,
    lastCause,
  );
}

/** Сума кількох `SkillUsage` в один — скіл робить кілька запитів на блоки. */
export function mergeUsage(parts: SkillUsage[], startedAt: number): SkillUsage {
  const hasPrompt = parts.some((p) => typeof p.promptTokens === 'number');
  const hasCompletion = parts.some((p) => typeof p.completionTokens === 'number');
  return {
    promptTokens: hasPrompt ? parts.reduce((sum, p) => sum + (p.promptTokens ?? 0), 0) : undefined,
    completionTokens: hasCompletion
      ? parts.reduce((sum, p) => sum + (p.completionTokens ?? 0), 0)
      : undefined,
    model: parts.find((p) => p.model)?.model,
    durationMs: Date.now() - startedAt,
  };
}
