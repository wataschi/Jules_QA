import dotenv from 'dotenv';

dotenv.config();

export async function isLlmAvailable(): Promise<boolean> {
  const baseUrl =
    process.env.MIDSCENE_MODEL_BASE_URL ??
    (process.env.LM_STUDIO_HOST
      ? `${process.env.LM_STUDIO_USE_HTTPS === 'true' ? 'https' : 'http'}://${process.env.LM_STUDIO_HOST}:${process.env.LM_STUDIO_PORT ?? '1234'}/v1`
      : null);

  if (!baseUrl) return false;

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: { Authorization: `Bearer ${process.env.MIDSCENE_MODEL_API_KEY ?? 'lm-studio'}` },
      signal: AbortSignal.timeout(20_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForRunComplete(
  runId: string,
  apiBase = process.env.UI_BASE_URL ?? 'http://localhost:3840',
  timeoutMs = 900_000,
): Promise<{ status: string; exitCode?: number }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${apiBase}/api/runs/${runId}`);
    if (!res.ok) throw new Error(`Run ${runId} not found`);
    const run = (await res.json()) as { status: string; exitCode?: number };
    if (['passed', 'failed', 'cancelled'].includes(run.status)) {
      return run;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`Timeout waiting for run ${runId}`);
}
