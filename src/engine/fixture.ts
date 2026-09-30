import fsSync from 'node:fs';
import path from 'node:path';
import { test as base } from '@playwright/test';
import { PlaywrightAiFixture, type PlayWrightAiFixtureType } from '@midscene/web/playwright';
import { baseScenarioName, getCacheId, isRegressionMode, isWarmUpMode } from '../config/env.js';
import { getMidsceneCacheDir } from '../server/data-paths.js';

/**
 * Одноразова міграція кешу локаторів на новий (URL-залежний) cacheId.
 *
 * cacheId тепер містить хеш цілі, тож наявний `jules-<name>.cache.yaml` став би
 * «невидимим» і перший прогін після оновлення був би холодним. Якщо файл під
 * новим ключем ще не існує, а старий є — копіюємо його; Midscene далі працює
 * тільки з новим ключем.
 */
function migrateLegacyCache(id: string, scenarioName: string): void {
  // Стара назва — БЕЗ хеша, тому `jules-<name>` складаємо напряму: `getCacheId`
  // додав би хеш і дав би той самий id, що й новий.
  const legacyId = `jules-${baseScenarioName(scenarioName)}`;
  if (legacyId === id) return;

  try {
    const dir = getMidsceneCacheDir();
    const target = path.join(dir, `${id}.cache.yaml`);
    const legacy = path.join(dir, `${legacyId}.cache.yaml`);
    if (!fsSync.existsSync(target) && fsSync.existsSync(legacy)) {
      fsSync.copyFileSync(legacy, target);
      console.log(`[cache] Перенесено старий кеш ${legacyId} → ${id}`);
    }
  } catch {
    /* міграція best-effort: без неї прогін просто буде холодним */
  }
}

function buildCacheConfig(scenarioName: string, targetUrl?: string) {
  const id = getCacheId(scenarioName, targetUrl);
  migrateLegacyCache(id, scenarioName);

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

export function createAiTestFixture(
  scenarioName: string,
  options?: { storageState?: string; targetUrl?: string },
) {
  const cache = buildCacheConfig(scenarioName, options?.targetUrl);

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
