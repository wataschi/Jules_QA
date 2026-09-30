/**
 * Той самий `askJson`, але на бекенді, де є лише `chatJson` без обліку токенів
 * (сумісність: якщо `chatJsonWithUsage` немає, скіл працює, токени — undefined).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const { resolveModel, chatJson } = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  chatJson: vi.fn(),
}));

vi.mock('../../../../src/config/models.js', () => ({ resolveModel, chatJson }));

const { askJson } = await import('../../../../src/registry/skills/model.js');

const schema = z.object({ cases: z.array(z.string()).default([]) });

beforeEach(() => {
  resolveModel.mockReset();
  chatJson.mockReset();
  resolveModel.mockReturnValue({
    role: 'planning',
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKey: 'lm-studio',
    name: 'legacy-model',
  });
});

describe('askJson без chatJsonWithUsage', () => {
  it('працює через chatJson, токени лишаються undefined', async () => {
    chatJson.mockResolvedValue({ cases: ['a', 'b'] });

    const result = await askJson({ role: 'planning', system: 's', user: 'u', schema });

    expect(result.value.cases).toEqual(['a', 'b']);
    expect(result.usage.promptTokens).toBeUndefined();
    expect(result.usage.completionTokens).toBeUndefined();
    // Назва моделі відома з resolveModel навіть без обліку токенів.
    expect(result.usage.model).toBe('legacy-model');
    expect(chatJson).toHaveBeenCalledTimes(1);
  });

  it('відповідь, що випадково має поле value, не «розгортається» помилково', async () => {
    chatJson.mockResolvedValue({ cases: ['x'], value: 'щось' });
    const result = await askJson({ role: 'planning', system: 's', user: 'u', schema });
    expect(result.value.cases).toEqual(['x']);
  });
});
