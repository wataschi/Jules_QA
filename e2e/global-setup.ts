import dotenv from 'dotenv';
import { applyTlsPolicy, isProxyEnabled, getProxyPort } from '../src/config/midscene-env.js';
import { startLmStudioProxy, type LmStudioProxyHandle } from '../src/config/lmstudio-proxy.js';

dotenv.config();
applyTlsPolicy();

/**
 * Playwright global setup. Starts the LM Studio image-transport proxy in the
 * runner process (reachable by all workers on a fixed local port) and returns a
 * teardown function that shuts it down after the run.
 */
async function globalSetup(): Promise<() => Promise<void>> {
  const upstream = process.env.MIDSCENE_MODEL_BASE_URL ?? process.env.OPENAI_BASE_URL;

  if (!isProxyEnabled() || !upstream) {
    return async () => undefined;
  }

  let handle: LmStudioProxyHandle | null = null;
  try {
    handle = await startLmStudioProxy({ upstreamBaseUrl: upstream, port: getProxyPort() });
    console.log(`[lmstudio-proxy] webp->png proxy on ${handle.url} -> ${upstream}`);
  } catch (error) {
    console.warn('[lmstudio-proxy] failed to start, falling back to direct upstream:', error);
    return async () => undefined;
  }

  return async () => {
    await handle?.close().catch(() => undefined);
  };
}

export default globalSetup;
