import { describe, expect, it } from 'vitest';
import { checklistSchema, parseStepMarker, scenarioYamlSchema } from '../../../src/planning/types.js';

describe('scenarioYamlSchema', () => {
  it('accepts valid scenario', () => {
    const parsed = scenarioYamlSchema.parse({
      name: 'test-scenario',
      goal: 'Test goal',
      hints: ['hint one'],
      steps: ['step one'],
      success_criteria: ['assert one'],
      navigation: { type: 'deterministic' },
    });
    expect(parsed.name).toBe('test-scenario');
    expect(parsed.tags).toEqual([]);
  });

  it('rejects missing name', () => {
    expect(() =>
      scenarioYamlSchema.parse({
        goal: 'Test goal',
      }),
    ).toThrow();
  });

  it('rejects invalid navigation type', () => {
    expect(() =>
      scenarioYamlSchema.parse({
        name: 'x',
        goal: 'g',
        navigation: { type: 'invalid' },
      }),
    ).toThrow();
  });

  it('accepts ai navigation with url', () => {
    const parsed = scenarioYamlSchema.parse({
      name: 'nav-test',
      goal: 'Navigate',
      navigation: { type: 'ai', url: 'https://example.com' },
    });
    expect(parsed.navigation?.type).toBe('ai');
  });

  it('accepts auth profile reference', () => {
    const parsed = scenarioYamlSchema.parse({
      name: 'auth-test',
      goal: 'Login test',
      auth: { profile: 'demo-site' },
    });
    expect(parsed.auth?.profile).toBe('demo-site');
  });
});

describe('parseStepMarker', () => {
  it('parses secret: prefix', () => {
    expect(parseStepMarker('secret: Type {{secret:demo.password}}')).toEqual({
      marker: 'secret',
      instruction: 'Type {{secret:demo.password}}',
    });
  });

  it('parses human: prefix', () => {
    expect(parseStepMarker('human: Solve CAPTCHA')).toEqual({
      marker: 'human',
      instruction: 'Solve CAPTCHA',
    });
  });
});

describe('checklistSchema', () => {
  it('accepts valid checklist', () => {
    const parsed = checklistSchema.parse({
      scenarioId: 'test',
      goal: 'goal',
      targetUrl: 'https://example.com',
      steps: ['step'],
      assertions: ['assert'],
    });
    expect(parsed.steps).toHaveLength(1);
  });

  it('rejects invalid targetUrl', () => {
    expect(() =>
      checklistSchema.parse({
        scenarioId: 'test',
        goal: 'goal',
        targetUrl: 'not-a-url',
        steps: [],
        assertions: [],
      }),
    ).toThrow();
  });
});
