/**
 * Розбір схем Gliffy (JSON-вкладення макроса Gliffy в Confluence) у ту саму
 * структуру, що й draw.io, щоб далі текст будувався одним кодом.
 *
 * Формат Gliffy: `stage.objects[]` (у новіших файлах — `pages[].scene.objects`);
 * фігура має `graphic.type = 'Shape'`, її текст лежить у дочірньому об'єкті з
 * `graphic.Text.html`; лінія — `graphic.type = 'Line'`, кінці — у
 * `constraints.startConstraint.StartPositionConstraint.nodeId` та
 * `constraints.endConstraint.EndPositionConstraint.nodeId`. Групи вкладають
 * фігури в `children`.
 *
 * Незнайомий чи зіпсований формат — порожній результат, без винятку.
 */
import {
  drawioToText,
  htmlToPlainText,
  type DrawioDiagram,
  type DrawioEdge,
  type DrawioNode,
  type DrawioPage,
} from './drawio.js';

export type { DrawioDiagram as GliffyDiagram, DrawioEdge, DrawioNode, DrawioPage };

interface GliffyObject {
  id?: number | string;
  uid?: string;
  graphic?: {
    type?: string;
    Text?: { html?: string };
  } | null;
  children?: GliffyObject[] | null;
  constraints?: {
    startConstraint?: { StartPositionConstraint?: { nodeId?: number | string } } | null;
    endConstraint?: { EndPositionConstraint?: { nodeId?: number | string } } | null;
  } | null;
}

function asObjects(value: unknown): GliffyObject[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
}

function idOf(object: GliffyObject): string | undefined {
  return object.id === undefined || object.id === null ? undefined : String(object.id);
}

function textOf(object: GliffyObject): string {
  const html = object.graphic?.Text?.html;
  return typeof html === 'string' ? htmlToPlainText(html) : '';
}

/** Текст фігури чи лінії — з дочірніх `Text`-об'єктів. */
function childText(object: GliffyObject): string {
  return asObjects(object.children)
    .filter((childObject) => childObject.graphic?.type === 'Text')
    .map(textOf)
    .filter(Boolean)
    .join(' ');
}

function constraintNode(value: number | string | undefined): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

function parseObjects(objects: GliffyObject[], name: string): DrawioPage {
  const nodes: DrawioNode[] = [];
  const edges: DrawioEdge[] = [];

  const visit = (object: GliffyObject, parent?: string) => {
    const id = idOf(object);
    const type = object.graphic?.type;
    if (type === 'Line') {
      if (!id) return;
      const edge: DrawioEdge = { id, label: childText(object) };
      const source = constraintNode(
        object.constraints?.startConstraint?.StartPositionConstraint?.nodeId,
      );
      const target = constraintNode(object.constraints?.endConstraint?.EndPositionConstraint?.nodeId);
      if (source) edge.source = source;
      if (target) edge.target = target;
      edges.push(edge);
      return;
    }
    if (type === 'Text') {
      // Вільний напис на полотні (не дитина фігури) — окремий елемент.
      if (id) nodes.push({ id, label: textOf(object), ...(parent ? { parent } : {}) });
      return;
    }

    const isGroup = !type || /group/i.test(object.uid ?? '');
    if (id && !isGroup) {
      nodes.push({ id, label: childText(object), ...(parent ? { parent } : {}) });
    }
    for (const childObject of asObjects(object.children)) {
      if (childObject.graphic?.type === 'Text' && !isGroup) continue;
      visit(childObject, isGroup ? (id ?? parent) : id);
    }
  };
  for (const object of objects) visit(object);

  // Кінці ліній, що вказують на неіснуючі об'єкти, відкидаємо — як і в draw.io.
  const known = new Set(nodes.map((node) => node.id));
  for (const edge of edges) {
    if (edge.source && !known.has(edge.source)) delete edge.source;
    if (edge.target && !known.has(edge.target)) delete edge.target;
  }
  // Група не є вершиною, тож parent лишаємо лише на справжніх вершинах.
  for (const node of nodes) if (node.parent && !known.has(node.parent)) delete node.parent;
  return { name, nodes, edges };
}

/** Розбирає Gliffy JSON. Незнайомий формат → `{ pages: [] }`. */
export function parseGliffy(json: string): DrawioDiagram {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { pages: [] };
  }
  if (!data || typeof data !== 'object') return { pages: [] };
  const doc = data as {
    stage?: { objects?: unknown };
    pages?: Array<{ title?: string; name?: string; scene?: { objects?: unknown }; stage?: { objects?: unknown } }>;
  };

  if (Array.isArray(doc.pages) && doc.pages.length > 0) {
    const pages = doc.pages
      .filter((page) => page && typeof page === 'object')
      .map((page, index) =>
        parseObjects(
          asObjects(page.scene?.objects ?? page.stage?.objects),
          page.title?.trim() || page.name?.trim() || `Сторінка ${index + 1}`,
        ),
      );
    return { pages };
  }
  if (doc.stage && Array.isArray(doc.stage.objects)) {
    return { pages: [parseObjects(asObjects(doc.stage.objects), 'Сторінка 1')] };
  }
  return { pages: [] };
}

/** Текст схеми Gliffy — той самий формат, що й у draw.io. */
export function gliffyToText(diagram: DrawioDiagram): string {
  return drawioToText(diagram);
}
