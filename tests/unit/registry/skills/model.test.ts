import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const { resolveModel, chatJsonWithUsage } = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  chatJsonWithUsage: vi.fn(),
}));

// Модель підміняємо на рівні `src/config/models.ts` — жодної мережі в тестах.
vi.mock('../../../../src/config/models.js', () => ({ resolveModel, chatJsonWithUsage }));

const { SkillModelError, askJson, isModelUnavailable, mergeUsage } = await import(
  '../../../../src/registry/skills/model.js'
);

const schema = z.object({ ok: z.boolean(), items: z.array(z.string()).default([]) });

beforeEach(() => {
  resolveModel.mockReset();
  chatJsonWithUsage.mockReset();
  resolveModel.mockReturnValue({
    role: 'planning',
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKey: 'lm-studio',
    name: 'qwen-test',
  });
});

describe('askJson — щасливий шлях', () => {
  it('валідує JSON схемою і повертає usage', async () => {
    chatJsonWithUsage.mockResolvedValue({
      value: { ok: true },
      usage: { promptTokens: 11, completionTokens: 22, model: 'qwen-test', durationMs: 5 },
    });

    const result = await askJson({ role: 'planning', system: 'sys', user: 'usr', schema });

    expect(result.value).toEqual({ ok: true, items: [] });
    expect(result.usage.promptTokens).toBe(11);
    expect(result.usage.completionTokens).toBe(22);
    expect(result.usage.model).toBe('qwen-test');
    expect(result.usage.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('передає роль і низьку температуру, без історії діалогу', async () => {
    chatJsonWithUsage.mockResolvedValue({ value: { ok: true }, usage: { durationMs: 1 } });
    await askJson({ role: 'critic', system: 'sys', user: 'usr', schema });

    const options = chatJsonWithUsage.mock.calls[0]?.[0];
    expect(options).toMatchObject({ role: 'critic', system: 'sys', user: 'usr', temperature: 0.2 });
    // Один запит = самодостатній контекст: жодних messages/history.
    expect(Object.keys(options ?? {}).sort()).toEqual([
      'role',
      'system',
      'temperature',
      'timeoutMs',
      'user',
    ]);
  });
});

describe('askJson — повтори', () => {
  it('перепитує з текстом помилки валідації і приймає другу відповідь', async () => {
    chatJsonWithUsage
      .mockResolvedValueOnce({ value: { ok: 'так' }, usage: { durationMs: 1 } })
      .mockResolvedValueOnce({ value: { ok: false }, usage: { durationMs: 1 } });

    const result = await askJson({ role: 'planning', system: 'sys', user: 'базовий запит', schema });

    expect(result.value.ok).toBe(false);
    expect(chatJsonWithUsage).toHaveBeenCalledTimes(2);
    const retryUser = String(chatJsonWithUsage.mock.calls[1]?.[0]?.user);
    expect(retryUser).toContain('базовий запит');
    expect(retryUser).toContain('не пройшла валідацію');
    expect(retryUser).toContain('ok:');
  });

  it('за замовчуванням не більше 2 повторів (3 спроби)', async () => {
    chatJsonWithUsage.mockResolvedValue({ value: { ok: 'ні' }, usage: { durationMs: 1 } });

    const error = (await askJson({ role: 'planning', system: 's', user: 'u', schema }).catch(
      (e: unknown) => e,
    )) as InstanceType<typeof SkillModelError>;

    expect(error).toBeInstanceOf(SkillModelError);
    expect(error.attempts).toBe(3);
    expect(error.message).toContain('не відповідає схемі');
    expect(chatJsonWithUsage).toHaveBeenCalledTimes(3);
  });

  it('maxRetries=0 — рівно одна спроба', async () => {
    chatJsonWithUsage.mockResolvedValue({ value: {}, usage: { durationMs: 1 } });
    await expect(
      askJson({ role: 'planning', system: 's', user: 'u', schema, maxRetries: 0 }),
    ).rejects.toBeInstanceOf(SkillModelError);
    expect(chatJsonWithUsage).toHaveBeenCalledTimes(1);
  });

  it('повторює після відповіді, що не є JSON', async () => {
    chatJsonWithUsage
      .mockRejectedValueOnce(new Error('LLM повернув невалідний JSON'))
      .mockResolvedValueOnce({ value: { ok: true }, usage: { durationMs: 1 } });

    const result = await askJson({ role: 'planning', system: 's', user: 'u', schema });
    expect(result.value.ok).toBe(true);
    expect(String(chatJsonWithUsage.mock.calls[1]?.[0]?.user)).toContain('не пройшла валідацію');
  });
});

describe('askJson — модель недоступна', () => {
  it('кидає людську помилку українською, якщо немає baseUrl', async () => {
    resolveModel.mockReturnValue({ role: 'planning', apiKey: 'lm-studio' });

    const error = (await askJson({ role: 'planning', system: 's', user: 'u', schema }).catch(
      (e: unknown) => e,
    )) as InstanceType<typeof SkillModelError>;

    expect(error).toBeInstanceOf(SkillModelError);
    expect(error.message).toContain('Модель недоступна');
    expect(error.message).toContain('MIDSCENE_MODEL_BASE_URL');
    expect(isModelUnavailable(error)).toBe(true);
    expect(chatJsonWithUsage).not.toHaveBeenCalled();
  });

  it('не повторює запит, якщо бекенд не відповідає', async () => {
    chatJsonWithUsage.mockRejectedValue(new Error('fetch failed: ECONNREFUSED 127.0.0.1:1234'));

    const error = (await askJson({ role: 'planning', system: 's', user: 'u', schema }).catch(
      (e: unknown) => e,
    )) as InstanceType<typeof SkillModelError>;

    expect(isModelUnavailable(error)).toBe(true);
    expect(error.message).toContain('Модель недоступна');
    expect(chatJsonWithUsage).toHaveBeenCalledTimes(1);
  });
});

describe('mergeUsage', () => {
  it('сумує токени кількох запитів', () => {
    const merged = mergeUsage(
      [
        { promptTokens: 10, completionTokens: 5, model: 'qwen', durationMs: 100 },
        { promptTokens: 7, completionTokens: 3, model: 'qwen', durationMs: 200 },
      ],
      Date.now() - 50,
    );
    expect(merged.promptTokens).toBe(17);
    expect(merged.completionTokens).toBe(8);
    expect(merged.model).toBe('qwen');
    expect(merged.durationMs).toBeGreaterThanOrEqual(50);
  });

  it('лишає токени undefined, якщо їх ніхто не дав', () => {
    const merged = mergeUsage([{ durationMs: 10 }, { durationMs: 20 }], Date.now());
    expect(merged.promptTokens).toBeUndefined();
    expect(merged.completionTokens).toBeUndefined();
  });
});
