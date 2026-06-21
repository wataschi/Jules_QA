/**
 * Midscene v1.x reads MIDSCENE_OPENAI_* / MIDSCENE_VQA_* keys.
 * Legacy Jules .env uses MIDSCENE_MODEL_* — map them before Playwright runs.
 */
function setIfMissing(key: string, value: string | undefined): void {
  if (value && !process.env[key]) {
    process.env[key] = value;
  }
}

export function isProxyEnabled(): boolean {
  return process.env.LMSTUDIO_PROXY_ENABLED !== 'false';
}

export function allowInsecureTls(): boolean {
  return process.env.ALLOW_INSECURE_TLS !== 'false';
}

/**
 * Relaxes Node TLS verification for the configured https model endpoint.
 *
 * Needed for self-hosted endpoints behind Tailscale Funnel / self-signed certs
 * that Node cannot verify (UNABLE_TO_VERIFY_LEAF_SIGNATURE). This is acceptable
 * because the traffic already rides inside the encrypted Tailscale tunnel.
 * For strict verification set ALLOW_INSECURE_TLS=false (and, on Node 22+, run
 * with NODE_OPTIONS=--use-system-ca to trust the OS certificate store instead).
 */
export function applyTlsPolicy(): void {
  const base = process.env.MIDSCENE_MODEL_BASE_URL ?? process.env.OPENAI_BASE_URL ?? '';
  if (allowInsecureTls() && base.startsWith('https')) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }
}

export function getProxyPort(): number {
  return Number(process.env.LMSTUDIO_PROXY_PORT ?? 3941);
}

/** Deterministic local proxy URL derived from the upstream base + fixed port. */
export function deriveProxyUrl(upstreamBaseUrl: string): string {
  const upstream = new URL(upstreamBaseUrl);
  return `http://127.0.0.1:${getProxyPort()}${upstream.pathname.replace(/\/$/, '')}`;
}

export function bootstrapMidsceneEnv(): Record<string, string> {
  applyTlsPolicy();

  // Original upstream (never rewritten): the LM Studio image-transport proxy and
  // /api/llm/check read this to reach the real server.
  const upstreamBaseUrl = process.env.MIDSCENE_MODEL_BASE_URL ?? process.env.OPENAI_BASE_URL;

  // Effective base the Midscene client actually talks to. Routed through the
  // local webp->png proxy when enabled so screenshots reach LM Studio intact.
  let effectiveBase =
    process.env.MIDSCENE_OPENAI_BASE_URL ?? upstreamBaseUrl;
  if (isProxyEnabled() && upstreamBaseUrl && !process.env.MIDSCENE_OPENAI_BASE_URL) {
    try {
      effectiveBase = deriveProxyUrl(upstreamBaseUrl);
    } catch {
      effectiveBase = upstreamBaseUrl;
    }
  }

  const baseUrl = effectiveBase;

  // Both insight (VQA) and planning roles send screenshots to the same LM Studio,
  // so when the proxy is active they must route through it too — otherwise they
  // bypass the webp->png fix and hit the empty-content bug.
  const proxyActive = Boolean(isProxyEnabled() && upstreamBaseUrl && baseUrl !== upstreamBaseUrl);

  const apiKey =
    process.env.MIDSCENE_OPENAI_API_KEY ??
    process.env.MIDSCENE_MODEL_API_KEY ??
    process.env.OPENAI_API_KEY ??
    'lm-studio';

  const modelName = process.env.MIDSCENE_MODEL_NAME;

  setIfMissing('MIDSCENE_OPENAI_BASE_URL', baseUrl);
  setIfMissing('MIDSCENE_OPENAI_API_KEY', apiKey);
  setIfMissing('OPENAI_BASE_URL', baseUrl);
  setIfMissing('OPENAI_API_KEY', apiKey);

  const vqaModel =
    process.env.MIDSCENE_VQA_MODEL_NAME ??
    process.env.MIDSCENE_INSIGHT_MODEL_NAME ??
    modelName;
  const vqaBase = proxyActive
    ? baseUrl
    : process.env.MIDSCENE_VQA_OPENAI_BASE_URL ??
      process.env.MIDSCENE_INSIGHT_MODEL_BASE_URL ??
      baseUrl;
  const vqaKey =
    process.env.MIDSCENE_VQA_OPENAI_API_KEY ??
    process.env.MIDSCENE_INSIGHT_MODEL_API_KEY ??
    apiKey;

  setIfMissing('MIDSCENE_VQA_MODEL_NAME', vqaModel);
  setIfMissing('MIDSCENE_VQA_OPENAI_BASE_URL', vqaBase);
  setIfMissing('MIDSCENE_VQA_OPENAI_API_KEY', vqaKey);

  const planningModel =
    process.env.MIDSCENE_PLANNING_MODEL_NAME ?? modelName;
  const planningBase = proxyActive
    ? baseUrl
    : process.env.MIDSCENE_PLANNING_OPENAI_BASE_URL ??
      process.env.MIDSCENE_PLANNING_MODEL_BASE_URL ??
      baseUrl;
  const planningKey =
    process.env.MIDSCENE_PLANNING_OPENAI_API_KEY ??
    process.env.MIDSCENE_PLANNING_MODEL_API_KEY ??
    apiKey;

  setIfMissing('MIDSCENE_PLANNING_MODEL_NAME', planningModel);
  setIfMissing('MIDSCENE_PLANNING_OPENAI_BASE_URL', planningBase);
  setIfMissing('MIDSCENE_PLANNING_OPENAI_API_KEY', planningKey);

  const family = process.env.MIDSCENE_MODEL_FAMILY ?? process.env.MIDSCENE_VL_MODE;
  if (family === 'qwen3-vl' || family === 'qwen3_vl') {
    setIfMissing('MIDSCENE_USE_QWEN3_VL', 'true');
    setIfMissing('MIDSCENE_VQA_VL_MODE', 'qwen3-vl');
    setIfMissing('MIDSCENE_PLANNING_VL_MODE', 'qwen3-vl');
  }

  const patch: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) patch[key] = value;
  }
  return patch;
}
