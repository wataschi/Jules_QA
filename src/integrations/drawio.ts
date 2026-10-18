/**
 * Розбір схем draw.io (diagrams.net) без моделі: вузли, зв'язки й підписи
 * стають текстом «A → B (умова)», який далі йде в блок вимоги поряд із
 * текстом сторінки Confluence.
 *
 * Що підтримуємо:
 *  - `<mxfile>` з однією чи кількома `<diagram>` (сторінки схеми);
 *  - вміст `<diagram>` — або вкладений `<mxGraphModel>`, або стиснутий рядок
 *    (base64 → inflateRaw → decodeURIComponent), як зберігає draw.io за
 *    замовчуванням і як лежить вкладення макроса в Confluence;
 *  - голий `<mxGraphModel>` (експорт «без стиснення» одного аркуша);
 *  - мітки з атрибута `value` (часто HTML), а також `<UserObject label=…>` /
 *    `<object label=…>`;
 *  - підпис ребра окремою вершиною-міткою (`edgeLabel`, parent = id ребра).
 *
 * Модуль чистий: жодного I/O, нічого не кидає на зіпсованому вході —
 * нерозпізнана сторінка просто порожня.
 */
import { inflateRawSync } from 'node:zlib';
import { parseXml, type XmlNode } from './testrail-xml.js';

export interface DrawioNode {
  id: string;
  label: string;
  /** Контейнер чи група, у якій лежить вершина (шари `0`/`1` сюди не потрапляють). */
  parent?: string;
}

export interface DrawioEdge {
  id: string;
  source?: string;
  target?: string;
  label: string;
}

export interface DrawioPage {
  name: string;
  nodes: DrawioNode[];
  edges: DrawioEdge[];
}

export interface DrawioDiagram {
  pages: DrawioPage[];
}

/* ───────────────────────────── текст міток ───────────────────────────── */

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  laquo: '«',
  raquo: '»',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rarr: '→',
  larr: '←',
  copy: '©',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

const TAG_RE = /<\/?[a-z][^>]*>/i;

/**
 * HTML-мітку → один рядок тексту: `<br>` і межі блоків стають пробілами,
 * решта тегів вирізається, сутності декодуються. Спільне з розбором Gliffy.
 */
export function htmlToPlainText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(?:div|p|li|h[1-6]|tr|td|th)>/gi, ' ')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanLabel(raw: string | undefined, style: string | undefined): string {
  if (!raw) return '';
  // Без `html=1` draw.io показує значення буквально, тож «a < b» — це текст, а не тег.
  const isHtml = /(?:^|;)html=1(?:;|$)/.test(style ?? '') || TAG_RE.test(raw);
  return isHtml ? htmlToPlainText(raw) : raw.replace(/\s+/g, ' ').trim();
}

/* ───────────────────────────── розбір XML ────────────────────────────── */

function findFirst(node: XmlNode, name: string): XmlNode | undefined {
  for (const childNode of node.children) {
    if (childNode.name === name) return childNode;
    const nested = findFirst(childNode, name);
    if (nested) return nested;
  }
  return undefined;
}

function findAll(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const childNode of node.children) {
    if (childNode.name === name) out.push(childNode);
    else findAll(childNode, name, out);
  }
  return out;
}

/** Стиснутий вміст `<diagram>` → XML `mxGraphModel`; `null`, якщо це не він. */
function inflateDiagram(data: string): string | null {
  const compact = data.replace(/\s+/g, '');
  if (!compact) return null;
  let inflated: string;
  try {
    inflated = inflateRawSync(Buffer.from(compact, 'base64')).toString('latin1');
  } catch {
    return null;
  }
  // Сучасний draw.io кодує XML через encodeURIComponent перед стисненням, дуже старі версії — ні.
  try {
    return decodeURIComponent(inflated);
  } catch {
    return Buffer.from(inflated, 'latin1').toString('utf-8');
  }
}

interface RawCell {
  id: string;
  label: string;
  parent?: string;
  vertex: boolean;
  edge: boolean;
  source?: string;
  target?: string;
}

/** `mxCell` або `UserObject`/`object` з вкладеним `mxCell` → одна клітинка. */
function readCell(node: XmlNode): RawCell | null {
  let cellAttrs: Record<string, string>;
  let rawLabel: string | undefined;
  if (node.name === 'mxCell') {
    cellAttrs = node.attrs;
    rawLabel = node.attrs.value;
  } else {
    const inner = node.children.find((childNode) => childNode.name === 'mxCell');
    cellAttrs = inner?.attrs ?? {};
    rawLabel = node.attrs.label ?? node.attrs.value;
  }
  const id = node.attrs.id ?? cellAttrs.id;
  if (!id) return null;
  return {
    id,
    label: cleanLabel(rawLabel, cellAttrs.style),
    parent: cellAttrs.parent,
    vertex: cellAttrs.vertex === '1',
    edge: cellAttrs.edge === '1',
    source: cellAttrs.source || undefined,
    target: cellAttrs.target || undefined,
  };
}

function parseGraphModel(model: XmlNode, name: string): DrawioPage {
  const container = findFirst(model, 'root') ?? model;
  const cells: RawCell[] = [];
  for (const node of container.children) {
    if (node.name !== 'mxCell' && node.name !== 'UserObject' && node.name !== 'object') continue;
    const cell = readCell(node);
    if (cell) cells.push(cell);
  }

  const byId = new Map(cells.map((cell) => [cell.id, cell]));
  const edgeIds = new Set(cells.filter((cell) => cell.edge).map((cell) => cell.id));
  const vertexIds = new Set(cells.filter((cell) => cell.vertex).map((cell) => cell.id));

  // Підписи ребер, винесені в окремі вершини-мітки.
  const edgeLabelParts = new Map<string, string[]>();
  for (const cell of cells) {
    if (!cell.vertex || !cell.parent || !edgeIds.has(cell.parent) || !cell.label) continue;
    const parts = edgeLabelParts.get(cell.parent) ?? [];
    parts.push(cell.label);
    edgeLabelParts.set(cell.parent, parts);
  }

  const nodes: DrawioNode[] = [];
  const edges: DrawioEdge[] = [];
  for (const cell of cells) {
    if (cell.vertex) {
      if (cell.parent && edgeIds.has(cell.parent)) continue;
      const node: DrawioNode = { id: cell.id, label: cell.label };
      if (cell.parent && vertexIds.has(cell.parent)) node.parent = cell.parent;
      nodes.push(node);
    } else if (cell.edge) {
      const edge: DrawioEdge = {
        id: cell.id,
        label: cell.label || (edgeLabelParts.get(cell.id) ?? []).join(' '),
      };
      if (cell.source && byId.has(cell.source)) edge.source = cell.source;
      if (cell.target && byId.has(cell.target)) edge.target = cell.target;
      edges.push(edge);
    }
  }
  return { name, nodes, edges };
}

function parseDiagramElement(diagram: XmlNode, index: number): DrawioPage {
  const name = diagram.attrs.name?.trim() || `Сторінка ${index + 1}`;
  const nested = findFirst(diagram, 'mxGraphModel');
  if (nested) return parseGraphModel(nested, name);

  const xml = inflateDiagram(diagram.text);
  if (xml) {
    const model = findFirst(parseXml(xml), 'mxGraphModel');
    if (model) return parseGraphModel(model, name);
  }
  return { name, nodes: [], edges: [] };
}

/** Розбирає файл draw.io (`.drawio`, вкладення Confluence, експорт XML). */
export function parseDrawio(content: string): DrawioDiagram {
  if (!content || !content.trim()) return { pages: [] };
  let root: XmlNode;
  try {
    root = parseXml(content);
  } catch {
    return { pages: [] };
  }

  const diagrams = findAll(root, 'diagram');
  if (diagrams.length > 0) {
    return { pages: diagrams.map((diagram, index) => parseDiagramElement(diagram, index)) };
  }
  const models = findAll(root, 'mxGraphModel');
  return {
    pages: models.map((model, index) => parseGraphModel(model, `Сторінка ${index + 1}`)),
  };
}

/* ───────────────────────────── у текст ───────────────────────────────── */

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Порядок рядків не залежить від порядку клітинок у XML (draw.io переставляє
 * їх при зміні z-порядку): обхід у ширину від вузлів без вхідних зв'язків,
 * сусіди — за алфавітом. Так текст і його хеш стабільні, а читається він як флоу.
 */
function orderEdges(page: DrawioPage, nameOf: (id: string | undefined) => string): DrawioEdge[] {
  const edgeKey = (edge: DrawioEdge) =>
    `${nameOf(edge.source)}\u0000${nameOf(edge.target)}\u0000${edge.label}\u0000${edge.id}`;
  const outgoing = new Map<string, DrawioEdge[]>();
  const incoming = new Set<string>();
  const dangling: DrawioEdge[] = [];
  for (const edge of page.edges) {
    if (edge.target) incoming.add(edge.target);
    if (!edge.source) {
      dangling.push(edge);
      continue;
    }
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge);
    outgoing.set(edge.source, list);
  }
  for (const list of outgoing.values()) list.sort((a, b) => compare(edgeKey(a), edgeKey(b)));

  const sources = [...outgoing.keys()].sort(
    (a, b) => compare(nameOf(a), nameOf(b)) || compare(a, b),
  );
  const ordered: DrawioEdge[] = [];
  const visited = new Set<string>();
  const walk = (start: string) => {
    const queue = [start];
    visited.add(start);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of outgoing.get(current) ?? []) {
        ordered.push(edge);
        if (edge.target && !visited.has(edge.target)) {
          visited.add(edge.target);
          queue.push(edge.target);
        }
      }
    }
  };
  for (const source of sources) if (!incoming.has(source) && !visited.has(source)) walk(source);
  // Цикли без «входу»: починаємо з найменшого за назвою.
  for (const source of sources) if (!visited.has(source)) walk(source);

  dangling.sort((a, b) => compare(edgeKey(a), edgeKey(b)));
  return [...ordered, ...dangling];
}

/**
 * Схема → текст для блоку вимоги:
 * ```
 * Сторінка: Оплата
 * Кошик → Оплата (сума > 0)
 * Окремі елементи: Примітка
 * ```
 */
export function drawioToText(diagram: DrawioDiagram): string {
  const sections: string[] = [];
  for (const page of diagram.pages) {
    const labels = new Map(page.nodes.map((node) => [node.id, node.label]));
    const nameOf = (id: string | undefined) => {
      if (!id) return '?';
      return labels.get(id) || `#${id}`;
    };

    const lines = [`Сторінка: ${page.name}`];
    const connected = new Set<string>();
    for (const edge of orderEdges(page, nameOf)) {
      if (!edge.source && !edge.target && !edge.label) continue;
      if (edge.source) connected.add(edge.source);
      if (edge.target) connected.add(edge.target);
      const arrow = `${nameOf(edge.source)} → ${nameOf(edge.target)}`;
      lines.push(edge.label ? `${arrow} (${edge.label})` : arrow);
    }

    const standalone = page.nodes
      .filter((node) => node.label && !connected.has(node.id))
      .map((node) => node.label)
      .sort(compare);
    if (standalone.length > 0) lines.push(`Окремі елементи: ${standalone.join(', ')}`);
    sections.push(lines.join('\n'));
  }
  return sections.join('\n\n');
}
