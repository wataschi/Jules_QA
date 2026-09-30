import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '../../../src/config/env.js';
import { resolveScenarioTargetUrl } from '../../../src/planning/scenario-planner.js';
import type { ScenarioYaml } from '../../../src/planning/types.js';

const scenario = (targetUrl?: string): ScenarioYaml =>
  ({
    name: 'demo',
    goal: 'перевірити ціль',
    steps: ['крок'],
    ...(targetUrl ? { target_url: targetUrl } : {}),
  }) as ScenarioYaml;

describe('resolveScenarioTargetUrl — закріплена ціль', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.QA_TARGET_URL = 'https://stage.example/app';
    delete process.env.QA_TARGET_PINNED;
    resetEnvCache();
  });

  afterEach(() => {
    process.env = { ...saved };
    resetEnvCache();
  });

  it('без закріплення виграє ціль сценарію', () => {
    expect(resolveScenarioTargetUrl(scenario('https://prod.example/app'))).toBe('https://prod.example/app');
  });

  it('без цілі сценарію лишається глобальна', () => {
    expect(resolveScenarioTargetUrl(scenario())).toBe('https://stage.example/app');
  });

  it('закріплена ціль перекриває ціль сценарію', () => {
    // Саме це дає змогу прогнати той самий кейс на стейджі: інакше прогін
    // ішов туди, де сценарій колись народився.
    process.env.QA_TARGET_PINNED = '1';
    resetEnvCache();
    expect(resolveScenarioTargetUrl(scenario('https://prod.example/app'))).toBe('https://stage.example/app');
  });
});
