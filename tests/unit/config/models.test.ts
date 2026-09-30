import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatJson, chatJsonWithUsage, parseJsonFromLlm } from '../../../src/config/models.js';

function stubLlm(body: Record<string, unknown>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body }),
  );
}

describe('chatJsonWithUsage', () => {
  beforeEach(() => {
    process.env.PLANNER_MODEL_BASE_URL = 'http://mock-llm/v1';
    process.env.PLANNER_MODEL_NAME = 'mock-model';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.PLANNER_MODEL_BASE_URL;
    delete process.env.PLANNER_MODEL_NAME;
  });

  it('returns the parsed value plus token/timing usage', async () => {
    stubLlm({
      model: 'served-model-id',
      usage: { prompt_tokens: 123, completion_tokens: 45 },
      choices: [{ message: { content: '{"steps":["one"]}' } }],
    });

    const result = await chatJsonWithUsage({ role: 'planning', system: 's', user: 'u' });

    expect(result.value).toEqual({ steps: ['one'] });
    expect(result.usage.promptTokens).toBe(123);
    expect(result.usage.completionTokens).toBe(45);
    expect(result.usage.model).toBe('served-model-id');
    expect(result.usage.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('falls back to zeros and the configured model name when usage is absent', async () => {
    stubLlm({ choices: [{ message: { content: '{"ok":true}' } }] });

    const result = await chatJsonWithUsage({ system: 's', user: 'u' });
    expect(result.usage).toMatchObject({
      promptTokens: 0,
      completionTokens: 0,
      model: 'mock-model',
    });
  });

  it('chatJson keeps its original signature and returns just the value', async () => {
    stubLlm({
      usage: { prompt_tokens: 7, completion_tokens: 8 },
      choices: [{ message: { content: '{"a":1}' } }],
    });

    // Жодних обгорток — рівно те, що було до появи chatJsonWithUsage.
    await expect(chatJson({ system: 's', user: 'u' })).resolves.toEqual({ a: 1 });
  });

  it('still throws when the LLM is not configured', async () => {
    delete process.env.PLANNER_MODEL_BASE_URL;
    delete process.env.MIDSCENE_MODEL_BASE_URL;
    delete process.env.MIDSCENE_OPENAI_BASE_URL;
    await expect(chatJsonWithUsage({ system: 's', user: 'u' })).rejects.toThrow(/LLM не налаштовано/);
  });
});

describe('parseJsonFromLlm', () => {
  it('unwraps fenced json blocks', () => {
    expect(parseJsonFromLlm('```json\n{"x":1}\n```')).toEqual({ x: 1 });
  });
});
