/** Допоміжне для «Входів»: дерево джерел, назви модулів, зрозумілі помилки, підсумки оновлення. */
import { api } from '../../api';
import type { Asset, AssetView, SectionNode, SourceNode, SyncResult } from '../../types';
import { SI } from './strings';

/** Усі вузли дерева одним списком (дерево з бекенда або плаский список). */
export function flattenSources(nodes: SourceNode[]): SourceNode[] {
  const out: SourceNode[] = [];
  const walk = (list: SourceNode[]) => {
    for (const node of list) {
      out.push(node);
      if (node.children?.length) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/** Будує дерево за parentId. Порядок — як прийшов із сервера. */
export function buildTree(flat: SourceNode[]): SourceNode[] {
  const byId = new Map<string, SourceNode>();
  for (const node of flat) byId.set(node.id, { ...node, children: [] });
  const roots: SourceNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Змінює один вузол у дереві, не чіпаючи решти. */
export function patchNode(nodes: SourceNode[], id: string, patch: Partial<SourceNode>): SourceNode[] {
  return nodes.map((node) =>
    node.id === id
      ? { ...node, ...patch, children: node.children }
      : node.children?.length
        ? { ...node, children: patchNode(node.children, id, patch) }
        : node,
  );
}

export function sectionNames(sections: SectionNode[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (list: SectionNode[]) => {
    for (const section of list) {
      map.set(section.id, section.name);
      if (section.children?.length) walk(section.children);
    }
  };
  if (sections) walk(sections);
  return map;
}

/** Корені Confluence, з яких можна зробити модулі. */
export function confluenceRoots(tree: SourceNode[]): SourceNode[] {
  return tree.filter((node) => node.kind === 'confluence');
}

/**
 * Помилка бекенда людськими словами. Повідомлення сервера лишаємо як
 * «подробиці», щоб адміністратор бачив технічну причину.
 */
export function explainError(message: string, status?: number | null): { text: string; details?: string } {
  if (/не налаштовано/i.test(message)) return { text: `${message}. ${SI.errors.notConfigured}` };
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|fetch failed|getaddrinfo|socket hang up|timed? ?out/i.test(message)) {
    return { text: SI.errors.network, details: message };
  }
  if (status === 401 || status === 403 || /\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(message)) {
    return { text: SI.errors.auth, details: message };
  }
  if (/\b404\b|not found/i.test(message)) return { text: SI.errors.notFound, details: message };
  return { text: message };
}

export interface SyncTotals {
  sources: number;
  unchanged: number;
  changed: number;
  added: number;
  proposals: number;
  readTasks: number;
  errors: Array<{ title: string; error: string }>;
}

export function syncTotals(results: SyncResult[], errors: Array<{ title: string; error: string }> = []): SyncTotals {
  const totals: SyncTotals = { sources: results.length + errors.length, unchanged: 0, changed: 0, added: 0, proposals: 0, readTasks: 0, errors: [...errors] };
  for (const result of results) {
    if (result.unchanged) totals.unchanged += 1;
    totals.changed += result.changed;
    totals.added += result.added;
    totals.proposals += result.proposals;
    totals.readTasks += result.readTasks.length;
    for (const failure of result.assetErrors) totals.errors.push({ title: `${result.title} · ${failure.name}`, error: failure.error });
  }
  return totals;
}

/** Вкладення в одному вигляді: з перегляду джерела та/або зі списку вкладень. */
export interface AssetModel {
  id: string;
  kind: Asset['kind'];
  name: string;
  diagramType?: string;
  text: string;
  readingState: Asset['readingState'];
  reading?: string;
  readingBy?: string;
  error?: string;
  imageUrl?: string;
  sourceId?: string;
  blockId?: string;
}

export function assetModel(view: AssetView | undefined, asset: Asset | undefined): AssetModel | null {
  const id = view?.id ?? asset?.id;
  if (!id) return null;
  const hasFile = Boolean(view?.fileUrl ?? asset?.sha256);
  return {
    id,
    kind: (asset?.kind ?? view?.kind) as Asset['kind'],
    name: asset?.name ?? view?.name ?? id,
    diagramType: asset?.diagramType ?? view?.diagramType,
    text: view?.text || asset?.extractedText || '',
    // Список вкладень свіжіший: після рішення QA оновлюємо саме його.
    readingState: asset?.readingState ?? view?.readingState ?? 'none',
    reading: asset?.reading,
    readingBy: asset?.readingBy,
    error: asset?.error,
    imageUrl: hasFile ? api.assetFileUrl(id) : undefined,
    sourceId: asset?.sourceId,
    blockId: asset?.blockId,
  };
}
