import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseFigmaLink,
  splitIntoBlocks,
  splitIntoBlocksWithAssets,
} from '../../../src/integrations/confluence.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../fixtures/confluence/dc-8.5-assets.storage.html');
const ACTS_FIXTURE = path.resolve(import.meta.dirname, '../../fixtures/confluence-acts-page.storage.html');

describe('parseFigmaLink', () => {
  it('розбирає file/design/proto/board і переводить node-id у формат API', () => {
    expect(parseFigmaLink('https://www.figma.com/design/AbC123/Payments?node-id=12-345&t=x')).toEqual({
      url: 'https://www.figma.com/design/AbC123/Payments?node-id=12-345&t=x',
      fileKey: 'AbC123',
      nodeId: '12:345',
    });
    expect(parseFigmaLink('https://figma.com/file/KEY1/Name')?.fileKey).toBe('KEY1');
    expect(parseFigmaLink('https://www.figma.com/proto/KEY2/Flow?node-id=1%3A2')?.nodeId).toBe('1:2');
    expect(parseFigmaLink('https://www.figma.com/board/KEY3/Jam')).toEqual({
      url: 'https://www.figma.com/board/KEY3/Jam',
      fileKey: 'KEY3',
    });
  });

  it('для гілки бере ключ гілки, для embed — вкладене посилання', () => {
    expect(parseFigmaLink('https://www.figma.com/design/MAIN1/branch/BR4NCH/Name')?.fileKey).toBe('BR4NCH');
    const embed = `https://www.figma.com/embed?embed_host=share&url=${encodeURIComponent(
      'https://www.figma.com/file/EMB1/X?node-id=3-4',
    )}`;
    expect(parseFigmaLink(embed)).toMatchObject({ fileKey: 'EMB1', nodeId: '3:4' });
  });

  it('повертає null для не-Figma і некоректних адрес', () => {
    expect(parseFigmaLink('https://evilfigma.com/file/KEY/x')).toBeNull();
    expect(parseFigmaLink('https://www.figma.com/community/file/123')).toBeNull();
    expect(parseFigmaLink('javascript:alert(1)')).toBeNull();
    expect(parseFigmaLink('не посилання')).toBeNull();
    expect(parseFigmaLink('')).toBeNull();
  });
});

describe('splitIntoBlocksWithAssets (storage Confluence 8.5)', () => {
  const blocks = splitIntoBlocksWithAssets(readFileSync(FIXTURE, 'utf-8'));
  const byHeading = (heading: string) => blocks.find((block) => block.heading === heading);

  it('лишає блоки, у яких є лише картинка чи схема, і нумерує підряд', () => {
    expect(blocks.map((block) => block.heading)).toEqual([
      'Платіжні доручення',
      'Створення доручення',
      'Процес погодження',
      'Модель даних',
      'Послідовність викликів',
      'Макети',
      'Зовнішній знімок',
      'Тільки картинка',
      "Пов'язані задачі",
    ]);
    expect(blocks.map((block) => block.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('картинка-вкладення: ім’я файлу, alt і плейсхолдер на місці', () => {
    const block = byHeading('Створення доручення')!;
    expect(block.assets).toEqual([
      { kind: 'image', source: 'attachment', name: 'payment-form.png', alt: 'Форма створення доручення' },
    ]);
    expect(block.text).toBe(
      'Форма створення показана на знімку:\n\n[Зображення: payment-form.png]\n\nСума доручення більше нуля. Див. також [Jira: PAY-102]',
    );
  });

  it('вкладення з іншої сторінки й зовнішня картинка за URL', () => {
    expect(byHeading('Тільки картинка')?.assets).toEqual([
      {
        kind: 'image',
        source: 'attachment',
        name: 'empty-state.png',
        page: { title: 'Спільні макети', spaceKey: 'UX' },
      },
    ]);
    expect(byHeading('Зовнішній знімок')?.assets).toEqual([
      {
        kind: 'image',
        source: 'url',
        name: 'bank statement.png',
        url: 'https://static.corp.local/img/bank%20statement.png',
        alt: 'Банківська виписка',
      },
    ]);
  });

  it('draw.io і inc-drawio: diagramName, pageId і плейсхолдери', () => {
    const block = byHeading('Процес погодження')!;
    expect(block.assets).toEqual([
      { kind: 'diagram', diagramType: 'drawio', name: 'approval-flow', macro: 'drawio', pageId: '229376001' },
      { kind: 'diagram', diagramType: 'drawio', name: 'statuses', macro: 'inc-drawio', pageId: '229300500' },
    ]);
    expect(block.text).toContain('[Схема draw.io: approval-flow]');
    expect(block.text).toContain('[Схема draw.io: statuses]');
  });

  it('gliffy бере параметр name', () => {
    expect(byHeading('Модель даних')?.assets).toEqual([
      { kind: 'diagram', diagramType: 'gliffy', name: 'payments-er', macro: 'gliffy' },
    ]);
    expect(byHeading('Модель даних')?.text).toBe('[Схема Gliffy: payments-er]');
  });

  it('plantuml і mermaid зберігають текст діаграми з CDATA', () => {
    const [plantuml, mermaid] = byHeading('Послідовність викликів')!.assets;
    expect(plantuml).toMatchObject({ kind: 'diagram', diagramType: 'plantuml', macro: 'plantuml' });
    expect(plantuml && 'source' in plantuml ? plantuml.source : '').toBe(
      '@startuml\nБухгалтер -> UI: Зберегти\nUI -> API: POST /payments\nAPI --> UI: 201\n@enduml',
    );
    expect(mermaid).toMatchObject({
      diagramType: 'mermaid',
      source: 'graph TD; Draft-->Approved; Approved-->Paid',
    });
  });

  it('Widget Connector із Figma дає посилання на кадр, YouTube-віджет ігнорується, lucidchart → other', () => {
    const block = byHeading('Макети')!;
    expect(block.figmaLinks).toEqual([
      {
        url: 'https://www.figma.com/file/FiLeKey42/Payments-Flow?type=design&node-id=7-89&mode=design',
        fileKey: 'FiLeKey42',
        nodeId: '7:89',
      },
    ]);
    expect(block.text).not.toContain('youtube');
    expect(block.assets).toEqual([
      { kind: 'diagram', diagramType: 'other', name: 'Інтеграція з банком', macro: 'lucidchart' },
    ]);
  });

  it('посилання на Figma в <a href> і ac:link лишають текст і прив’язуються до свого блоку', () => {
    const intro = byHeading('Платіжні доручення')!;
    expect(intro.figmaLinks).toEqual([
      {
        url: 'https://www.figma.com/design/AbC123xYz/Payments?node-id=12-345&t=9xQ-0',
        fileKey: 'AbC123xYz',
        nodeId: '12:345',
      },
    ]);
    expect(intro.text).toContain('Макет екрана: Payments — список.');
    const related = byHeading("Пов'язані задачі")!;
    expect(related.figmaLinks).toEqual([{ url: 'https://figma.com/proto/PrOtO77/Old', fileKey: 'PrOtO77' }]);
    expect(related.text).toContain('Стара версія макета: прототип');
  });

  it('ключі Jira з макросів (у тексті, info і таблиці), JQL-макрос без ключа пропускається', () => {
    expect(byHeading('Платіжні доручення')?.jiraKeys).toEqual(['PAY-101']);
    expect(byHeading('Створення доручення')?.jiraKeys).toEqual(['PAY-102']);
    const related = byHeading("Пов'язані задачі")!;
    expect(related.jiraKeys).toEqual(['PAY-103']);
    expect(related.text).toContain('Задача: [Jira: PAY-103]');
    expect(related.text).not.toContain('project = PAY');
  });

  it('у тексті немає службових маркерів, тегів і параметрів макросів', () => {
    const all = blocks.map((block) => `${block.heading}\n${block.text}`).join('\n');
    expect(all).not.toMatch(/[\u0001-\u0005]/);
    expect(all).not.toMatch(/<[a-z/!]/i);
    expect(all).not.toContain('diagramDisplayName');
    expect(all).not.toContain('maxLevel');
    expect(all).not.toContain('@startuml');
  });

  it('звичайний splitIntoBlocks на тій самій сторінці працює як раніше', () => {
    const plain = splitIntoBlocks(readFileSync(FIXTURE, 'utf-8'));
    expect(plain.map((block) => block.heading)).toEqual([
      'Платіжні доручення',
      'Створення доручення',
      'Процес погодження',
      "Пов'язані задачі",
    ]);
    expect(plain.map((block) => block.text).join('\n')).not.toContain('[Зображення');
  });
});

describe('splitIntoBlocksWithAssets (крайні випадки)', () => {
  it('для сторінки без ресурсів дає ті самі блоки, що й splitIntoBlocks', () => {
    // Із фікстури актів прибираємо єдину картинку — решта (таблиці, макроси, сутності) лишається.
    const html = readFileSync(ACTS_FIXTURE, 'utf-8').replace(/<ac:image\b[\s\S]*?<\/ac:image>/g, '');
    expect(html).not.toContain('ac:image');
    const withAssets = splitIntoBlocksWithAssets(html);
    const plain = splitIntoBlocks(html);
    expect(withAssets.map(({ heading, anchor, text, position }) => ({ heading, anchor, text, position }))).toEqual(
      plain.map(({ heading, anchor, text, position }) => ({ heading, ...(anchor ? { anchor } : {}), text, position })),
    );
  });

  it('картинка в заголовку не псує anchor і прив’язується до блоку', () => {
    const blocks = splitIntoBlocksWithAssets(
      '<h2>Логотип <ac:image><ri:attachment ri:filename="logo.png" /></ac:image></h2><p>Текст.</p>',
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.heading).toBe('Логотип');
    expect(blocks[0]?.anchor).toBe('Логотип');
    expect(blocks[0]?.assets).toEqual([{ kind: 'image', source: 'attachment', name: 'logo.png' }]);
  });

  it('ресурси в навігаційному макросі відкидаються разом із ним', () => {
    const blocks = splitIntoBlocksWithAssets(
      '<h2>Розділ</h2><p>Текст.</p><ac:structured-macro ac:name="children"><ac:rich-text-body><ac:image><ri:attachment ri:filename="x.png" /></ac:image></ac:rich-text-body></ac:structured-macro>',
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.assets).toEqual([]);
    expect(blocks[0]?.text).toBe('Текст.');
  });

  it('екранує спецсимволи в імені файлу плейсхолдера', () => {
    const blocks = splitIntoBlocksWithAssets(
      '<p><ac:image><ri:attachment ri:filename="a&amp;b &lt;1&gt;.png" /></ac:image></p>',
    );
    expect(blocks[0]?.text).toBe('[Зображення: a&b <1>.png]');
    expect(blocks[0]?.assets[0]).toMatchObject({ name: 'a&b <1>.png' });
  });

  it('порожній вхід → порожній масив', () => {
    expect(splitIntoBlocksWithAssets('')).toEqual([]);
    expect(splitIntoBlocksWithAssets('   \n ')).toEqual([]);
  });

  it('markdown розбивається без ресурсів', () => {
    const blocks = splitIntoBlocksWithAssets('# Акти\n\nТекст.', { format: 'markdown' });
    expect(blocks).toEqual([
      { heading: 'Акти', anchor: 'Акти', text: 'Текст.', position: 0, assets: [], figmaLinks: [], jiraKeys: [] },
    ]);
  });
});
