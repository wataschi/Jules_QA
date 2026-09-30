import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaseKind } from '../../../../src/registry/types.js';

const { askJson } = vi.hoisted(() => ({ askJson: vi.fn() }));

vi.mock('../../../../src/registry/skills/model.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/registry/skills/model.js')>();
  return { ...actual, askJson };
});

const { findLocallyUntestable, validateCoverage } = await import(
  '../../../../src/registry/skills/validate-coverage.js'
);

const blocks = [
  {
    id: 'blk-1',
    heading: 'Створення акта',
    text: 'Менеджер створює акт. Поле «Сума» обов’язкове, більше 0. Номер унікальний у межах договору.',
  },
  {
    id: 'blk-2',
    heading: 'Видалення акта',
    text: 'Акт можна прибрати лише у статусі «Чернетка».',
  },
];

const cases = [
  {
    id: 'CYBER-REG-001',
    title: 'Акт із сумою зберігається',
    checks: ['У списку актів з’явився рядок'],
    kind: 'positive' as CaseKind,
  },
  {
    id: 'CYBER-REG-002',
    title: 'Акт із сумою створюється',
    checks: ['Рядок акта є у списку'],
    kind: 'positive' as CaseKind,
  },
];

const input = { blocks, cases, sectionPath: 'Кібер / Карта договору / Акти' };

function usage() {
  return { promptTokens: 40, completionTokens: 20, model: 'qwen-test', durationMs: 5 };
}

const emptyReport = {
  gaps: [],
  duplicates: [],
  untestable: [],
  contradictions: [],
};

beforeEach(() => {
  askJson.mockReset();
});

describe('findLocallyUntestable (без моделі)', () => {
  it('ловить порожні checks і загальні слова', () => {
    const result = findLocallyUntestable([
      { id: 'A-B-001', title: 'Без перевірок', checks: [], kind: 'positive' },
      { id: 'A-B-002', title: 'Загальні слова', checks: ['працює нормально', 'все ок'], kind: 'positive' },
      { id: 'A-B-003', title: 'Нормальний', checks: ['Показано текст «Збережено»'], kind: 'positive' },
    ]);
    expect(result.map((item) => item.caseId)).toEqual(['A-B-001', 'A-B-002']);
    expect(result[0]?.reason).toContain('Немає жодної перевірки');
    expect(result[1]?.reason).toContain('загальні слова');
  });
});

describe('validateCoverage', () => {
  it('один блок = один запит, результати агрегуються', async () => {
    askJson
      .mockResolvedValueOnce({
        value: {
          ...emptyReport,
          gaps: [
            {
              blockId: 'blk-1',
              fragment: 'Номер унікальний у межах договору.',
              suggestion: {
                title: 'Дубль номера акта в межах договору — помилка',
                kind: 'negative',
                priority: 'P2',
                preconditions: 'Є акт із номером A-1',
                checks: ['Показано текст «Номер уже використано»'],
                tags: ['acts'],
              },
            },
          ],
          duplicates: [
            { caseIds: ['CYBER-REG-001', 'CYBER-REG-002'], reason: 'Обидва перевіряють створення акта' },
          ],
        },
        usage: usage(),
      })
      .mockResolvedValueOnce({
        value: {
          ...emptyReport,
          contradictions: [
            {
              caseId: 'CYBER-REG-001',
              blockId: 'blk-2',
              reason: 'Кейс чекає видалення підписаного акта, вимога дозволяє лише чернетку',
            },
          ],
        },
        usage: usage(),
      });

    const result = await validateCoverage(input);

    expect(askJson).toHaveBeenCalledTimes(2);
    expect(askJson.mock.calls[0]?.[0]?.role).toBe('critic');
    expect(String(askJson.mock.calls[0]?.[0]?.user)).toContain('Створення акта');
    expect(String(askJson.mock.calls[1]?.[0]?.user)).toContain('Видалення акта');
    // Кейси передаються моделі в обох запитах — вона мусить бачити повний список.
    expect(String(askJson.mock.calls[1]?.[0]?.user)).toContain('CYBER-REG-001');

    expect(result.report.gaps).toHaveLength(1);
    expect(result.report.gaps[0]?.blockId).toBe('blk-1');
    expect(result.report.gaps[0]?.fragment).toBe('Номер унікальний у межах договору.');
    expect(result.report.gaps[0]?.suggestion.kind).toBe('negative');
    expect(result.report.gaps[0]?.suggestion.checks).toEqual(['Показано текст «Номер уже використано»']);

    expect(result.report.duplicates).toEqual([
      { caseIds: ['CYBER-REG-001', 'CYBER-REG-002'], reason: 'Обидва перевіряють створення акта' },
    ]);
    expect(result.report.contradictions[0]).toMatchObject({
      caseId: 'CYBER-REG-001',
      blockId: 'blk-2',
    });

    expect(result.usage.promptTokens).toBe(80);
    expect(result.usage.completionTokens).toBe(40);
  });

  it('відкидає невідомі id кейсів і пише попередження', async () => {
    askJson.mockResolvedValue({
      value: {
        ...emptyReport,
        untestable: [{ caseId: 'НЕМА-ТАКОГО-001', reason: 'вигадка' }],
        contradictions: [{ caseId: 'НЕМА-ТАКОГО-002', blockId: 'blk-1', reason: 'вигадка' }],
        duplicates: [{ caseIds: ['CYBER-REG-001'], reason: 'один id — не дубль' }],
      },
      usage: usage(),
    });

    const result = await validateCoverage(input);
    expect(result.report.untestable).toEqual([]);
    expect(result.report.contradictions).toEqual([]);
    expect(result.report.duplicates).toEqual([]);
    expect(result.warnings.filter((w) => w.includes('невідомий кейс'))).toHaveLength(4);
    expect(result.warnings.some((w) => w.includes('менше двох відомих кейсів'))).toBe(true);
  });

  it('не дублює однакові знахідки з різних блоків', async () => {
    askJson.mockResolvedValue({
      value: {
        ...emptyReport,
        duplicates: [
          { caseIds: ['CYBER-REG-002', 'CYBER-REG-001'], reason: 'те саме' },
        ],
        untestable: [{ caseId: 'CYBER-REG-001', reason: 'загальні слова' }],
      },
      usage: usage(),
    });

    const result = await validateCoverage(input);
    expect(result.report.duplicates).toHaveLength(1);
    expect(result.report.untestable).toHaveLength(1);
  });

  it('прогалина без фрагмента або без пропозиції відкидається', async () => {
    askJson.mockResolvedValue({
      value: {
        ...emptyReport,
        gaps: [
          { blockId: 'blk-1', fragment: '   ', suggestion: { title: 'Щось', checks: ['Показано текст'] } },
          { blockId: 'blk-1', fragment: 'Поле «Сума» обов’язкове.' },
          {
            blockId: 'blk-1',
            fragment: 'Сума більше 0.',
            suggestion: { title: 'Все працює нормально', checks: ['працює нормально'] },
          },
        ],
      },
      usage: usage(),
    });

    const result = await validateCoverage(input);
    expect(result.report.gaps).toEqual([]);
    expect(result.warnings.some((w) => w.includes('без фрагмента'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('без пропозиції кейса'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('немає перевірної умови'))).toBe(true);
  });

  it('локальні untestable додаються без моделі', async () => {
    askJson.mockResolvedValue({ value: emptyReport, usage: usage() });
    const result = await validateCoverage({
      ...input,
      cases: [
        ...input.cases,
        { id: 'CYBER-REG-009', title: 'Все працює', checks: ['працює нормально'], kind: 'positive' as CaseKind },
      ],
    });
    expect(result.report.untestable.map((item) => item.caseId)).toEqual(['CYBER-REG-009']);
  });

  it('порожні блоки не йдуть у модель', async () => {
    const result = await validateCoverage({
      ...input,
      blocks: [{ id: 'blk-x', heading: 'Пусто', text: '' }],
    });
    expect(askJson).not.toHaveBeenCalled();
    expect(result.report.gaps).toEqual([]);
    expect(result.warnings.some((w) => w.includes('порожній'))).toBe(true);
  });

  it('якщо жоден блок не проаналізовано — кидає помилку', async () => {
    askJson.mockRejectedValue(new Error('LLM API error: 500'));
    await expect(validateCoverage(input)).rejects.toThrow('LLM API error: 500');
  });

  it('промпт містить чотири завдання аудиту', async () => {
    askJson.mockResolvedValue({ value: emptyReport, usage: usage() });
    await validateCoverage(input);
    const system = String(askJson.mock.calls[0]?.[0]?.system);
    expect(system).toContain('gaps');
    expect(system).toContain('duplicates');
    expect(system).toContain('untestable');
    expect(system).toContain('contradictions');
    expect(system).toContain('дослівний фрагмент');
    expect(system).toContain('Не придумуй id');
  });
});
