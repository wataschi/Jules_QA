import { createHash } from 'node:crypto';
import { z } from 'zod';

const envSchema = z.object({
  QA_TARGET_URL: z.string().url().default('https://example.com'),
  QA_MODE: z.enum(['warm-up', 'regression']).default('warm-up'),
  QA_SCENARIO_PATH: z.string().default('scenarios/invalid-password.yaml'),
  MIDSCENE_MODEL_BASE_URL: z.string().optional(),
  MIDSCENE_MODEL_API_KEY: z.string().optional(),
  MIDSCENE_MODEL_NAME: z.string().optional(),
  MIDSCENE_MODEL_FAMILY: z.string().optional(),
  MIDSCENE_PREFERRED_LANGUAGE: z.string().default('Ukrainian'),
  PLANNER_MODEL_BASE_URL: z.string().optional(),
  PLANNER_MODEL_API_KEY: z.string().optional(),
  PLANNER_MODEL_NAME: z.string().optional(),
  CRITIC_MODEL_BASE_URL: z.string().optional(),
  CRITIC_MODEL_API_KEY: z.string().optional(),
  CRITIC_MODEL_NAME: z.string().optional(),
  STAGEHAND_MODEL: z.string().default('google/gemini-2.5-flash'),
  // LM Studio image-transport proxy (webp -> png fix). Enabled by default;
  // it transparently no-ops when there is no upstream model URL configured.
  LMSTUDIO_PROXY_ENABLED: z
    .enum(['true', 'false'])
    .default('true'),
  LMSTUDIO_PROXY_PORT: z.coerce.number().int().positive().default(3941),
  // Disable Qwen/LM Studio "thinking" per request so the model returns visible
  // content instead of an empty reply after an internal <think> pass. Proven
  // with the local qwen3.6-35b-a3b model in the HiveADE project.
  LMSTUDIO_DISABLE_THINKING: z.enum(['true', 'false']).default('true'),
  // Allow connecting to an https model endpoint with an untrusted/unverifiable
  // certificate (e.g. Tailscale Funnel). Safe here because Tailscale already
  // provides an encrypted WireGuard tunnel. Set to 'false' to enforce strict TLS.
  ALLOW_INSECURE_TLS: z.enum(['true', 'false']).default('true'),
  DEBUG: z.string().optional(),
  JULES_VAULT_KEY: z.string().optional(),
  QA_HEADED: z.enum(['true', 'false']).default('false'),
  QA_HITL_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  QA_RUN_ID: z.string().optional(),
  // Playwright-трасування. Дефолти — як раніше ('on'), але тепер це керується
  // зовні: прогони зі секретами запускаються з QA_TRACE='off' (див. test-runner).
  QA_TRACE: z.enum(['on', 'off', 'retain-on-failure', 'on-first-retry', 'on-all-retries']).default('on'),
  QA_VIDEO: z.enum(['on', 'off', 'retain-on-failure', 'on-first-retry']).default('on'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (!cached) {
    cached = envSchema.parse(process.env);
  }
  return cached;
}

/**
 * Ефективний targetUrl поточного прогону (`scenario.target_url ?? QA_TARGET_URL`).
 * Виставляється один раз на початку планування, щоб УСІ похідні артефакти
 * (cache, plans, results, aggregate, generated spec) вважали ключ однаково —
 * навіть там, де доступна лише назва сценарію (наприклад Playwright-фікстура).
 */
let activeTargetUrl: string | null = null;

export function setActiveTargetUrl(url: string | null): void {
  activeTargetUrl = url;
}

export function getActiveTargetUrl(): string {
  // process.env читаємо напряму: кеш `getEnv()` може бути прогрітий ще до того,
  // як сервер застосував налаштування прогону до process.env.
  return activeTargetUrl ?? process.env.QA_TARGET_URL ?? 'https://example.com';
}

export function resetEnvCache(): void {
  cached = null;
  activeTargetUrl = null;
}

export function isWarmUpMode(): boolean {
  return getEnv().QA_MODE === 'warm-up';
}

export function isRegressionMode(): boolean {
  return getEnv().QA_MODE === 'regression';
}

/** Суфікс ключа: `--` + 8 hex. Використовується для ідемпотентності та fallback. */
const KEY_SUFFIX_RE = /--[0-9a-f]{8}$/;

/**
 * Нормалізує ціль до `origin + pathname` (без query/hash, без хвостових слешів,
 * у нижньому регістрі) — щоб `https://Site.com/app/?x=1#y` і
 * `https://site.com/app` давали один і той самий ключ.
 */
export function normalizeTargetUrl(targetUrl: string): string {
  try {
    const url = new URL(targetUrl);
    const pathname = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.host}${pathname}`.toLowerCase();
  } catch {
    return targetUrl.trim().toLowerCase();
  }
}

/** 8 hex-символів sha256 від нормалізованої цілі. */
export function hashTargetUrl(targetUrl: string): string {
  return createHash('sha256').update(normalizeTargetUrl(targetUrl)).digest('hex').slice(0, 8);
}

/**
 * ЄДИНИЙ ключ артефактів прогону: `<name>--<hash8(targetUrl)>`.
 *
 * Без хеша кеш локаторів одного сайту підставлявся іншому: `scenarioKey` робить
 * cacheId/plans/results/aggregate/generated унікальними на пару «сценарій+ціль».
 * Виклик ідемпотентний — передати вже готовий ключ безпечно.
 */
export function scenarioKey(scenarioName: string, targetUrl?: string): string {
  if (KEY_SUFFIX_RE.test(scenarioName)) return scenarioName;
  return `${scenarioName}--${hashTargetUrl(targetUrl ?? getActiveTargetUrl())}`;
}

/** Стара (без хеша) назва артефакту — читається як fallback для наявних даних. */
export function baseScenarioName(scenarioKeyOrName: string): string {
  return scenarioKeyOrName.replace(KEY_SUFFIX_RE, '');
}

/**
 * Назви-кандидати для читання артефакту: спершу новий ключ, далі стара назва.
 * Завдяки цьому перехід на ключі не «губить» уже наявні plans/results/спеки.
 */
export function artifactNameCandidates(scenarioKeyOrName: string, targetUrl?: string): string[] {
  const key = scenarioKey(scenarioKeyOrName, targetUrl);
  const legacy = baseScenarioName(key);
  return key === legacy ? [key] : [key, legacy];
}

export function getCacheId(scenarioName: string, targetUrl?: string): string {
  return `jules-${scenarioKey(scenarioName, targetUrl)}`;
}
