import { test as base } from '@playwright/test';
import { PlaywrightAiFixture, type PlayWrightAiFixtureType } from '@midscene/web/playwright';
import { getCacheId, isRegressionMode, isWarmUpMode } from '../config/env.js';

function buildCacheConfig(scenarioName: string) {
  const id = getCacheId(scenarioName);

  if (isWarmUpMode()) {
    return {
      id,
      strategy: 'write-only' as const,
    };
  }

  if (isRegressionMode()) {
    return {
      id,
      strategy: 'read-only' as const,
    };
  }

  return { id };
}

export function createAiTestFixture(scenarioName: string, options?: { storageState?: string }) {
  const cache = buildCacheConfig(scenarioName);

  const extended = base.extend<PlayWrightAiFixtureType>(
    PlaywrightAiFixture({
      waitForNetworkIdleTimeout: 2000,
      cache,
    }),
  );

  if (options?.storageState) {
    extended.use({ storageState: options.storageState });
  }

  return extended;
}

export const test = createAiTestFixture('default');

export { expect } from '@playwright/test';

export function getCacheDebugHint(): string {
  if (process.env.DEBUG?.includes('midscene:cache')) {
    return 'Cache debug logging enabled (DEBUG=midscene:cache:*)';
  }
  return 'Tip: set DEBUG=midscene:cache:* to inspect cache hit/miss';
}
