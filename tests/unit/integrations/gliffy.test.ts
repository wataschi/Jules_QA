import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gliffyToText, parseGliffy } from '../../../src/integrations/gliffy.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../fixtures/diagrams/login-flow.gliffy');

function readFixture(): string {
  return readFileSync(FIXTURE, 'utf-8');
}

describe('parseGliffy — зразок схеми', () => {
  const diagram = parseGliffy(readFixture());
  const page = diagram.pages[0]!;

  it('збирає фігури з текстом дочірніх Text-об’єктів, прибираючи HTML', () => {
    expect(page.nodes).toEqual([
      { id: '0', label: 'Форма входу' },
      { id: '2', label: 'Кабінет' },
      { id: '4', label: 'Помилка пароля' },
      { id: '10', label: 'Підтримка' },
      { id: '12', label: 'Примітка: 3 спроби' },
    ]);
  });

  it('бере кінці ліній зі startConstraint / endConstraint і підпис лінії', () => {
    expect(page.edges).toEqual([
      { id: '6', source: '0', target: '2', label: 'пароль вірний' },
      { id: '8', source: '0', target: '4', label: '' },
    ]);
  });

  it('будує текст у тому ж форматі, що й draw.io', () => {
    expect(gliffyToText(diagram)).toBe(
      [
        'Сторінка: Сторінка 1',
        'Форма входу → Кабінет (пароль вірний)',
        'Форма входу → Помилка пароля',
        'Окремі елементи: Примітка: 3 спроби, Підтримка',
      ].join('\n'),
    );
  });

  it('розуміє новіший формат зі сторінками pages[].scene.objects', () => {
    const json = JSON.stringify({
      pages: [
        {
          title: 'Реєстрація',
          scene: {
            objects: [
              { id: 1, graphic: { type: 'Shape' }, children: [{ id: 2, graphic: { type: 'Text', Text: { html: 'A' } } }] },
              { id: 3, graphic: { type: 'Shape' }, children: [{ id: 4, graphic: { type: 'Text', Text: { html: 'B' } } }] },
              {
                id: 5,
                graphic: { type: 'Line' },
                constraints: {
                  startConstraint: { StartPositionConstraint: { nodeId: 1 } },
                  endConstraint: { EndPositionConstraint: { nodeId: 3 } },
                },
              },
            ],
          },
        },
      ],
    });
    expect(gliffyToText(parseGliffy(json))).toBe('Сторінка: Реєстрація\nA → B');
  });
});

describe('parseGliffy — порожній і незнайомий вхід', () => {
  it('повертає порожній результат для не-JSON без винятку', () => {
    expect(parseGliffy('<xml/>')).toEqual({ pages: [] });
    expect(parseGliffy('')).toEqual({ pages: [] });
  });

  it('повертає порожній результат для JSON іншого формату', () => {
    expect(parseGliffy('{"foo": [1, 2]}')).toEqual({ pages: [] });
    expect(parseGliffy('null')).toEqual({ pages: [] });
    expect(parseGliffy('[1,2,3]')).toEqual({ pages: [] });
  });

  it('відкидає кінці ліній, що вказують на неіснуючі об’єкти', () => {
    const json = JSON.stringify({
      stage: {
        objects: [
          {
            id: 1,
            graphic: { type: 'Line' },
            constraints: { startConstraint: { StartPositionConstraint: { nodeId: 99 } } },
          },
        ],
      },
    });
    expect(parseGliffy(json).pages[0]!.edges).toEqual([{ id: '1', label: '' }]);
  });
});
