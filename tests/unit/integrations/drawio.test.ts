import { readFileSync } from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { drawioToText, htmlToPlainText, parseDrawio } from '../../../src/integrations/drawio.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../fixtures/diagrams/payment-flow.drawio');

function readFixture(): string {
  return readFileSync(FIXTURE, 'utf-8');
}

/** Стискає XML так само, як draw.io: encodeURIComponent → deflateRaw → base64. */
function compress(xml: string): string {
  return deflateRawSync(Buffer.from(encodeURIComponent(xml), 'latin1')).toString('base64');
}

const SIMPLE_MODEL = `<mxGraphModel><root>
  <mxCell id="0"/><mxCell id="1" parent="0"/>
  <mxCell id="a" value="Старт" vertex="1" parent="1"/>
  <mxCell id="b" value="&lt;i&gt;Фініш&lt;/i&gt;" style="html=1;" vertex="1" parent="1"/>
  <mxCell id="ab" value="готово" edge="1" parent="1" source="a" target="b"/>
</root></mxGraphModel>`;

describe('parseDrawio — нестиснутий файл', () => {
  const diagram = parseDrawio(readFixture());
  const [payment, refund] = diagram.pages;

  it('читає всі сторінки з їхніми назвами', () => {
    expect(diagram.pages.map((page) => page.name)).toEqual(['Оплата', 'Повернення']);
  });

  it('прибирає HTML з міток, перетворює <br> на пробіл і декодує сутності', () => {
    const labels = Object.fromEntries(payment!.nodes.map((node) => [node.id, node.label]));
    expect(labels.pay).toBe('Оплата карткою');
    expect(labels.ok).toBe('Успіх оплати');
    expect(labels.err).toBe('Помилка «Недостатньо коштів»');
  });

  it('не вважає «<» у звичайній (не HTML) мітці тегом', () => {
    expect(payment!.nodes.find((node) => node.id === 'note')?.label).toBe('a < b — примітка');
  });

  it('підтягує підпис ребра з дочірньої вершини edgeLabel і не робить її вузлом', () => {
    const edge = payment!.edges.find((item) => item.id === 'e3');
    expect(edge).toEqual({ id: 'e3', source: 'pay', target: 'ok', label: 'банк підтвердив' });
    expect(payment!.nodes.some((node) => node.id === 'e3-label')).toBe(false);
  });

  it('бере мітки з <object label> і ставить parent лише для контейнерів-вершин', () => {
    expect(refund!.nodes).toEqual([
      { id: 'grp', label: 'Бекофіс' },
      { id: 'req', label: 'Заявка', parent: 'grp' },
      { id: 'done', label: 'Повернено', parent: 'grp' },
    ]);
  });

  it('будує текст «A → B (мітка)» і окремі елементи без порожніх міток', () => {
    expect(drawioToText(diagram)).toBe(
      [
        'Сторінка: Оплата',
        'Кошик → Оплата карткою (сума > 0)',
        'Оплата карткою → Помилка «Недостатньо коштів»',
        'Оплата карткою → Успіх оплати (банк підтвердив)',
        'Окремі елементи: a < b — примітка',
        '',
        'Сторінка: Повернення',
        'Заявка → Повернено (схвалено)',
        'Окремі елементи: Бекофіс',
      ].join('\n'),
    );
  });

  it('дає той самий текст, якщо клітинки в XML переставлено (z-порядок)', () => {
    const shuffled = readFixture().replace(
      /(<mxCell id="e2"[\s\S]*?<\/mxCell>)([\s\S]*?)(<mxCell id="e1"[\s\S]*?<\/mxCell>)/,
      '$3$2$1',
    );
    expect(shuffled).not.toBe(readFixture());
    expect(drawioToText(parseDrawio(shuffled))).toBe(drawioToText(diagram));
  });
});

describe('parseDrawio — стиснутий вміст і голий mxGraphModel', () => {
  it('розпаковує стиснуту сторінку (base64 → inflateRaw → decodeURIComponent)', () => {
    const file = `<mxfile><diagram id="x" name="Стиснута">${compress(SIMPLE_MODEL)}</diagram></mxfile>`;
    const diagram = parseDrawio(file);
    expect(diagram.pages).toHaveLength(1);
    expect(diagram.pages[0]!.name).toBe('Стиснута');
    expect(drawioToText(diagram)).toBe('Сторінка: Стиснута\nСтарт → Фініш (готово)');
  });

  it('змішує стиснуті й нестиснуті сторінки в одному файлі', () => {
    const file = `<mxfile>
      <diagram name="Один">${compress(SIMPLE_MODEL)}</diagram>
      <diagram name="Два">${SIMPLE_MODEL}</diagram>
    </mxfile>`;
    const diagram = parseDrawio(file);
    expect(diagram.pages.map((page) => page.edges.length)).toEqual([1, 1]);
  });

  it('розбирає голий <mxGraphModel> як одну сторінку', () => {
    const diagram = parseDrawio(SIMPLE_MODEL);
    expect(diagram.pages).toHaveLength(1);
    expect(diagram.pages[0]!.name).toBe('Сторінка 1');
    expect(diagram.pages[0]!.nodes.map((node) => node.label)).toEqual(['Старт', 'Фініш']);
  });

  it('пише «?» замість відсутнього кінця й «#id» для вершини без мітки', () => {
    const model = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="a" value="" vertex="1" parent="1"/>
      <mxCell id="b" value="B" vertex="1" parent="1"/>
      <mxCell id="ab" edge="1" parent="1" source="a" target="b"/>
      <mxCell id="loose" value="вихід" edge="1" parent="1" source="b"/>
    </root></mxGraphModel>`;
    expect(drawioToText(parseDrawio(model))).toBe('Сторінка: Сторінка 1\n#a → B\nB → ? (вихід)');
  });
});

describe('parseDrawio — порожній і зіпсований вхід', () => {
  it('повертає порожню схему для порожнього рядка', () => {
    expect(parseDrawio('')).toEqual({ pages: [] });
    expect(drawioToText({ pages: [] })).toBe('');
  });

  it('не кидає на нерозпізнаному стиснутому вмісті — сторінка просто порожня', () => {
    const diagram = parseDrawio('<mxfile><diagram name="Биті дані">не-base64!!!</diagram></mxfile>');
    expect(diagram).toEqual({ pages: [{ name: 'Биті дані', nodes: [], edges: [] }] });
  });

  it('не знаходить сторінок у XML, що не є draw.io', () => {
    expect(parseDrawio('<html><body>привіт</body></html>')).toEqual({ pages: [] });
  });
});

describe('htmlToPlainText', () => {
  it('склеює блоки й декодує числові сутності', () => {
    expect(htmlToPlainText('<div>Крок&#160;1</div><div>Крок&#x20;2<br/>кінець</div>')).toBe(
      'Крок 1 Крок 2 кінець',
    );
  });
});
