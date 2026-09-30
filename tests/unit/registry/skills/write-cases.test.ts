import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawCase } from '../../../../src/registry/skills/write-cases.js';

const { askJson } = vi.hoisted(() => ({ askJson: vi.fn() }));

// Виклик моделі винесено в `skills/model.ts` — тут підміняємо саме його.
vi.mock('../../../../src/registry/skills/model.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/registry/skills/model.js')>();
  return { ...actual, askJson };
});

const {
  isDestructive,
  isVagueCheck,
  normalizeDraftCases,
  splitCompoundCheck,
  writeCases,
} = await import('../../../../src/registry/skills/write-cases.js');

const block = {
  id: 'blk-1',
  heading: 'Створення акта',
  text: 'Менеджер створює акт із карти договору. Поле «Сума» обов\'язкове, більше 0.',
};

const input = {
  blocks: [block],
  sectionPath: 'Кібер / Карта договору / Акти',
  projectName: 'Кібер',
};

function usage() {
  return { promptTokens: 100, completionTokens: 50, model: 'qwen-test', durationMs: 10 };
}

function rawCase(overrides: Partial<RawCase> = {}): RawCase {
  return {
    coverageKind: 'quote',
    rationale: 'Вимога прямо описує обов’язковість суми.',
    title: 'Акт із заповненою сумою зберігається',
    kind: 'positive',
    priority: 'P2',
    preconditions: 'Роль «Менеджер», активний договір',
    checks: ['У списку актів з’явився рядок із номером акта'],
    tags: ['acts'],
    ...overrides,
  };
}

beforeEach(() => {
  askJson.mockReset();
});

describe('правила якості (без моделі)', () => {
  it('splitCompoundCheck розбиває складені перевірки', () => {
    expect(splitCompoundCheck('Поле підсвічене; показано текст «Обов’язкове»')).toEqual([
      'Поле підсвічене',
      'показано текст «Обов’язкове»',
    ]);
    expect(splitCompoundCheck('- Рядок 1\n- Рядок 2')).toEqual(['Рядок 1', 'Рядок 2']);
    expect(splitCompoundCheck('Проста перевірка')).toEqual(['Проста перевірка']);
  });

  it('isVagueCheck ловить «працює нормально» і пропускає конкретику', () => {
    expect(isVagueCheck('працює нормально')).toBe(true);
    expect(isVagueCheck('Все ОК')).toBe(true);
    expect(isVagueCheck('форма відображається коректно')).toBe(true);
    expect(isVagueCheck('без помилок')).toBe(true);
    expect(isVagueCheck('')).toBe(true);
    expect(isVagueCheck('Показано текст «Обов’язкове поле»')).toBe(false);
    expect(isVagueCheck('Кнопка «Зберегти» неактивна')).toBe(false);
  });

  it('isDestructive ловить оплату й видалення акаунта', () => {
    expect(isDestructive('Оплатити рахунок карткою')).toBe(true);
    expect(isDestructive('Видалити акаунт користувача')).toBe(true);
    expect(isDestructive('Списати кошти з рахунку')).toBe(true);
    expect(isDestructive('Прибрати акт зі списку у статусі «Чернетка»')).toBe(false);
  });
});

describe('normalizeDraftCases', () => {
  const ctx = { blockId: 'blk-1', blockHeading: 'Створення акта', maxPerBlock: 8 };

  it('прибирає кейс без перевірної умови', () => {
    const { drafts, warnings } = normalizeDraftCases(
      [rawCase(), rawCase({ title: 'Форма акта працює', checks: ['працює нормально'] })],
      ctx,
    );
    expect(drafts).toHaveLength(1);
    expect(warnings.some((w) => w.includes('немає перевірної умови'))).toBe(true);
  });

  it('один кейс = одна перевірка: складені перевірки розбиваються', () => {
    const { drafts } = normalizeDraftCases(
      [rawCase({ checks: ['Поле підсвічене червоним; показано текст «Обов’язкове поле»'] })],
      ctx,
    );
    expect(drafts[0]?.case.checks).toEqual([
      'Поле підсвічене червоним',
      'показано текст «Обов’язкове поле»',
    ]);
  });

  it('позначає derived і вимагає пояснення', () => {
    const { drafts, warnings } = normalizeDraftCases(
      [
        rawCase({ coverageKind: 'derived', rationale: '', title: 'Сума 0 — акт не зберігається' }),
        rawCase({
          coverageKind: 'derived',
          rationale: 'Прямий URL без прав — типова дірка в авторизації.',
          title: 'Прямий URL на акт чужого договору — 403',
          kind: 'security',
        }),
      ],
      ctx,
    );
    expect(drafts.map((draft) => draft.coverageKind)).toEqual(['derived', 'derived']);
    expect(drafts[0]?.rationale.length).toBeGreaterThan(10);
    expect(warnings.some((w) => w.includes('derived без пояснення'))).toBe(true);
    expect(drafts[1]?.rationale).toContain('авторизації');
    expect(drafts[1]?.case.kind).toBe('security');
  });

  it('прибирає дублі й ріже до maxPerBlock', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      rawCase({ title: `Кейс ${i}`, checks: [`Показано рядок ${i}`] }),
    );
    const { drafts, warnings } = normalizeDraftCases([...many, many[0]!], {
      ...ctx,
      maxPerBlock: 3,
    });
    expect(drafts).toHaveLength(3);
    expect(warnings.some((w) => w.includes('обрізано до 3'))).toBe(true);
    expect(warnings.some((w) => w.includes('дубль'))).toBe(true);
  });

  it('прибирає кейси з руйнівними діями', () => {
    const { drafts, warnings } = normalizeDraftCases(
      [rawCase({ title: 'Оплатити акт карткою', checks: ['Показано «Оплата успішна»'] })],
      ctx,
    );
    expect(drafts).toHaveLength(0);
    expect(warnings.some((w) => w.includes('руйнівну дію'))).toBe(true);
  });

  it('нормалізує невідомі kind/priority і теги', () => {
    const { drafts } = normalizeDraftCases(
      [rawCase({ kind: 'functional', priority: 'High', tags: ['Акти Форма', 'validation', 'validation'] })],
      ctx,
    );
    expect(drafts[0]?.case.kind).toBe('positive');
    expect(drafts[0]?.case.priority).toBe('P1');
    expect(drafts[0]?.case.tags).toEqual(['акти-форма', 'validation']);
  });

  it('проставляє blockId кожному кейсу', () => {
    const { drafts } = normalizeDraftCases([rawCase()], ctx);
    expect(drafts[0]?.blockId).toBe('blk-1');
  });
});

describe('writeCases (модель підмінена)', () => {
  it('робить два проходи — генератор і критик — і бере результат критика', async () => {
    askJson
      .mockResolvedValueOnce({
        value: {
          cases: [
            rawCase(),
            rawCase({ title: 'Форма акта в цілому', checks: ['працює нормально'] }),
            rawCase({
              coverageKind: 'derived',
              title: 'Сума 0 — акт не зберігається',
              kind: 'negative',
              rationale: 'Межове значення, у вимозі його немає.',
              checks: ['Під полем «Сума» показано «Значення має бути більше 0»'],
            }),
          ],
        },
        usage: usage(),
      })
      .mockResolvedValueOnce({
        value: {
          cases: [
            rawCase(),
            rawCase({
              coverageKind: 'derived',
              title: 'Сума 0 — акт не зберігається',
              kind: 'negative',
              rationale: 'Межове значення, у вимозі його немає.',
              checks: ['Під полем «Сума» показано «Значення має бути більше 0»'],
            }),
          ],
          removed: ['«Форма акта в цілому» — немає перевірної умови'],
        },
        usage: usage(),
      });

    const result = await writeCases(input);

    expect(askJson).toHaveBeenCalledTimes(2);
    expect(askJson.mock.calls[0]?.[0]?.role).toBe('planning');
    expect(askJson.mock.calls[1]?.[0]?.role).toBe('critic');

    expect(result.drafts).toHaveLength(2);
    expect(result.drafts.map((draft) => draft.coverageKind)).toEqual(['quote', 'derived']);
    expect(result.drafts.every((draft) => draft.case.checks.length > 0)).toBe(true);
    expect(result.drafts.every((draft) => draft.blockId === 'blk-1')).toBe(true);

    // Критик прибрав кейс без перевірної умови — це видно і в warnings.
    expect(result.warnings.some((w) => w.includes('немає перевірної умови'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('Критик прибрав'))).toBe(true);

    // Токени сумуються по обох запитах.
    expect(result.usage.promptTokens).toBe(200);
    expect(result.usage.completionTokens).toBe(100);
    expect(result.usage.model).toBe('qwen-test');
  });

  it('передає моделі правила ліда QA і межу maxPerBlock', async () => {
    askJson.mockResolvedValue({ value: { cases: [rawCase()], removed: [] }, usage: usage() });
    await writeCases({ ...input, style: { maxPerBlock: 3, language: 'Ukrainian' } });

    const system = String(askJson.mock.calls[0]?.[0]?.system);
    expect(system).toContain('Один кейс = ОДНА перевірка');
    expect(system).toContain('СПОСТЕРЕЖУВАНІ');
    expect(system).toContain("'derived'");
    expect(system).toContain('rationale');
    expect(system).toContain('руйнівні дії');
    expect(system).toContain('Не більше 3 кейсів');
    expect(system).toContain('Ukrainian');

    const user = String(askJson.mock.calls[0]?.[0]?.user);
    expect(user).toContain('Кібер / Карта договору / Акти');
    expect(user).toContain('Створення акта');
    expect(user).toContain('Поле «Сума» обов\'язкове');
  });

  it('includeDerived=false забороняє домисли в промпті', async () => {
    askJson.mockResolvedValue({ value: { cases: [rawCase()], removed: [] }, usage: usage() });
    await writeCases({ ...input, style: { includeDerived: false } });
    const system = String(askJson.mock.calls[0]?.[0]?.system);
    expect(system).toContain("Тільки 'quote' кейси");
  });

  it('додає few-shot приклади команди в запит', async () => {
    askJson.mockResolvedValue({ value: { cases: [rawCase()], removed: [] }, usage: usage() });
    await writeCases({
      ...input,
      style: { examples: [{ title: 'Наш зразковий кейс', checks: ['Показано таблицю'] }] },
    });
    expect(String(askJson.mock.calls[0]?.[0]?.user)).toContain('Наш зразковий кейс');
  });

  it('один блок = один запит генератора: 2 блоки → 4 запити', async () => {
    askJson.mockResolvedValue({ value: { cases: [rawCase()], removed: [] }, usage: usage() });
    const result = await writeCases({
      ...input,
      blocks: [block, { id: 'blk-2', heading: 'Видалення акта', text: 'Акт прибирається лише у статусі «Чернетка».' }],
    });
    expect(askJson).toHaveBeenCalledTimes(4);
    expect(result.drafts.map((draft) => draft.blockId)).toEqual(['blk-1', 'blk-2']);
  });

  it('падіння критика не валить запуск — лишаються чернетки генератора', async () => {
    askJson
      .mockResolvedValueOnce({ value: { cases: [rawCase()] }, usage: usage() })
      .mockRejectedValueOnce(new Error('модель відповіла дурницю'));

    const result = await writeCases(input);
    expect(result.drafts).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes('прохід критика пропущено'))).toBe(true);
  });

  it('порожні блоки пропускаються без запиту до моделі', async () => {
    const result = await writeCases({ ...input, blocks: [{ id: 'blk-9', heading: 'Пусто', text: '  ' }] });
    expect(askJson).not.toHaveBeenCalled();
    expect(result.drafts).toEqual([]);
    expect(result.warnings.some((w) => w.includes('порожній'))).toBe(true);
  });

  it('якщо жоден блок не вдався — кидає помилку генератора', async () => {
    askJson.mockRejectedValue(new Error('LLM API error: 500'));
    await expect(writeCases(input)).rejects.toThrow('LLM API error: 500');
  });

  it('недоступна модель припиняє роботу відразу', async () => {
    const { SkillModelError } = await import('../../../../src/registry/skills/model.js');
    askJson.mockRejectedValue(new SkillModelError('Модель недоступна.', 0, undefined, true));
    await expect(
      writeCases({ ...input, blocks: [block, { id: 'blk-2', heading: 'Ще', text: 'текст вимоги' }] }),
    ).rejects.toThrow('Модель недоступна');
    expect(askJson).toHaveBeenCalledTimes(1);
  });
});
