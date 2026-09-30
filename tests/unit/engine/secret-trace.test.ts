import { describe, expect, it } from 'vitest';
import { scenarioHasSecrets, scenarioNeedsHeaded } from '../../../src/planning/scenario-planner.js';
import type { ScenarioYaml } from '../../../src/planning/types.js';

function scenario(overrides: Partial<ScenarioYaml>): ScenarioYaml {
  return {
    name: 'trace-demo',
    goal: 'demo',
    tags: [],
    hints: [],
    steps: [],
    checkpoints: [],
    success_criteria: [],
    ...overrides,
  };
}

/**
 * Трейс Playwright зберігає ввід з клавіатури, а `secret-type` вводить пароль
 * саме через `page.keyboard.type`. Тому для таких сценаріїв трейс вимикається —
 * це свідомий компроміс (доказами лишаються відео/скриншоти та evidence-pack).
 */
describe('scenarioHasSecrets — gate for QA_TRACE=off', () => {
  it('flags a scenario with a secret: step', () => {
    expect(
      scenarioHasSecrets(
        scenario({ steps: ['Click login', 'secret: type {{secret:demo.password}} into password'] }),
      ),
    ).toBe(true);
  });

  it('flags a scenario with an auth profile', () => {
    expect(scenarioHasSecrets(scenario({ auth: { profile: 'demo' }, steps: ['Open dashboard'] }))).toBe(true);
  });

  it('does not flag an ordinary scenario', () => {
    expect(scenarioHasSecrets(scenario({ steps: ['Open the page', 'Click Search'] }))).toBe(false);
  });

  it('is not fooled by the word "secret" mid-instruction', () => {
    expect(scenarioHasSecrets(scenario({ steps: ['Verify the secret handshake banner is hidden'] }))).toBe(false);
  });
});

describe('scenarioNeedsHeaded', () => {
  it('flags human: steps and auth profiles', () => {
    expect(scenarioNeedsHeaded(scenario({ steps: ['human: solve the captcha'] }))).toBe(true);
    expect(scenarioNeedsHeaded(scenario({ auth: { profile: 'demo' } }))).toBe(true);
    expect(scenarioNeedsHeaded(scenario({ steps: ['Click Search'] }))).toBe(false);
  });
});
