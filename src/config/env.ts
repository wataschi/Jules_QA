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
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (!cached) {
    cached = envSchema.parse(process.env);
  }
  return cached;
}

export function resetEnvCache(): void {
  cached = null;
}

export function isWarmUpMode(): boolean {
  return getEnv().QA_MODE === 'warm-up';
}

export function isRegressionMode(): boolean {
  return getEnv().QA_MODE === 'regression';
}

export function getCacheId(scenarioName: string): string {
  return `jules-${scenarioName}`;
}
