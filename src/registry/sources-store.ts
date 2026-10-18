/** Сховище джерел вимог (`sources`) і блоків тексту (`blocks`). */
import { createHash } from 'node:crypto';
import { execute, fromJson, nowIso, query, queryOne, tx, type Row } from './db.js';
import { newId } from './ids.js';
import { blockSchema, sourceSchema, type Block, type BlockMeta, type Source, type SourceKind } from './types.js';

function rowToSource(row: Row): Source {
  return sourceSchema.parse({
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    url: row.url ?? undefined,
    externalId: row.external_id ?? undefined,
    externalVersion: row.external_version ?? undefined,
    contentHash: row.content_hash,
    parentId: row.parent_id ?? undefined,
    rootId: row.root_id ?? undefined,
    depth: Number(row.depth ?? 0),
    included: row.included === undefined ? true : Boolean(row.included),
    noAgents: Boolean(row.no_agents),
    spaceKey: row.space_key ?? undefined,
    sectionId: row.section_id ?? undefined,
    lastError: row.last_error ?? undefined,
    checkedAt: row.checked_at ?? undefined,
    importedAt: row.imported_at,
    updatedAt: row.updated_at,
  });
}

function rowToBlock(row: Row): Block {
  return blockSchema.parse({
    id: row.id,
    sourceId: row.source_id,
    position: Number(row.position ?? 0),
    heading: row.heading ?? '',
    anchor: row.anchor ?? undefined,
    text: row.text,
    hash: row.hash,
    changeState: row.change_state ?? 'new',
    nodeId: row.node_id ?? undefined,
    route: row.route ?? undefined,
    meta: fromJson<BlockMeta>(row.meta, {}),
  });
}

/** sha256, перші 16 символів — так само, як `hashBlock` в інтеграціях. */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

export interface SourceListItem extends Source {
  blockCount: number;
  gaps: number;
}

/** Джерела проєкту з кількістю блоків і прогалин (блоків без кейсів). */
export function listSources(projectId: string): SourceListItem[] {
  return query<Row>(
    `SELECT s.*,
       (SELECT COUNT(*) FROM blocks b WHERE b.source_id = s.id) AS block_count,
       (SELECT COUNT(*) FROM blocks b
          WHERE b.source_id = s.id
            AND b.change_state <> 'removed'
            AND NOT EXISTS (SELECT 1 FROM coverage cv WHERE cv.block_id = b.id)) AS gaps
     FROM sources s
     WHERE s.project_id = ?
     ORDER BY s.updated_at DESC`,
    [projectId],
  ).map((row) => ({
    ...rowToSource(row),
    blockCount: Number(row.block_count ?? 0),
    gaps: Number(row.gaps ?? 0),
  }));
}

export function getSource(id: string): Source | null {
  const row = queryOne<Row>('SELECT * FROM sources WHERE id = ?', [id]);
  return row ? rowToSource(row) : null;
}

export function requireSource(id: string): Source {
  const source = getSource(id);
  if (!source) throw new Error(`Джерело «${id}» не знайдено`);
  return source;
}

export function listBlocks(sourceId: string): Block[] {
  return query<Row>('SELECT * FROM blocks WHERE source_id = ? ORDER BY position', [sourceId]).map(
    rowToBlock,
  );
}

export function getBlock(id: string): Block | null {
  const row = queryOne<Row>('SELECT * FROM blocks WHERE id = ?', [id]);
  return row ? rowToBlock(row) : null;
}

export function getBlocksByIds(ids: readonly string[]): Block[] {
  if (ids.length === 0) return [];
  return query<Row>(
    `SELECT * FROM blocks WHERE id IN (${ids.map(() => '?').join(', ')}) ORDER BY position`,
    [...ids],
  ).map(rowToBlock);
}

export interface RawBlockInput {
  heading: string;
  anchor?: string;
  text: string;
  position: number;
}

export interface SaveSourceInput {
  projectId: string;
  kind: SourceKind;
  title: string;
  url?: string;
  externalId?: string;
  externalVersion?: string;
  blocks: RawBlockInput[];
}

/** Створює джерело разом із блоками. Усі блоки — `changeState='new'`. */
export function createSource(input: SaveSourceInput): { source: Source; blocks: Block[] } {
  return tx(() => {
    const id = newId('src');
    const at = nowIso();
    const contentHash = hashText(input.blocks.map((b) => b.text).join('\n'));
    execute(
      `INSERT INTO sources
         (id, project_id, kind, title, url, external_id, external_version, content_hash, imported_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.projectId,
        input.kind,
        input.title,
        input.url ?? null,
        input.externalId ?? null,
        input.externalVersion ?? null,
        contentHash,
        at,
        at,
      ],
    );
    for (const block of input.blocks) {
      insertBlock(id, block, 'new');
    }
    return { source: requireSource(id), blocks: listBlocks(id) };
  });
}

function insertBlock(sourceId: string, block: RawBlockInput, changeState: Block['changeState']): string {
  const id = newId('blk');
  execute(
    `INSERT INTO blocks (id, source_id, position, heading, anchor, text, hash, change_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, sourceId, block.position, block.heading ?? '', block.anchor ?? null, block.text, hashText(block.text), changeState],
  );
  return id;
}

export interface RefreshResult {
  changed: string[];
  added: string[];
  removed: string[];
  same: string[];
}

/**
 * Переімпорт джерела: блоки зіставляються за хешем/заголовком, для кожного
 * виставляється `changeState`. Видалені блоки лишаються в базі з
 * `changeState='removed'`, щоб не порвати зв'язки покриття.
 */
export function refreshSource(sourceId: string, blocks: RawBlockInput[]): RefreshResult {
  return tx(() => {
    const source = requireSource(sourceId);
    const existing = listBlocks(sourceId);
    const result: RefreshResult = { changed: [], added: [], removed: [], same: [] };

    const byHash = new Map(existing.map((b) => [b.hash, b]));
    const byHeading = new Map<string, Block[]>();
    for (const block of existing) {
      const bucket = byHeading.get(block.heading) ?? [];
      bucket.push(block);
      byHeading.set(block.heading, bucket);
    }

    const matched = new Set<string>();
    for (const incoming of blocks) {
      const hash = hashText(incoming.text);
      const sameBlock = byHash.get(hash);
      if (sameBlock && !matched.has(sameBlock.id)) {
        matched.add(sameBlock.id);
        execute('UPDATE blocks SET position = ?, heading = ?, anchor = ?, change_state = ? WHERE id = ?', [
          incoming.position,
          incoming.heading ?? '',
          incoming.anchor ?? null,
          'same',
          sameBlock.id,
        ]);
        result.same.push(sameBlock.id);
        continue;
      }

      const candidate = (byHeading.get(incoming.heading ?? '') ?? []).find((b) => !matched.has(b.id));
      if (candidate) {
        matched.add(candidate.id);
        execute(
          'UPDATE blocks SET position = ?, anchor = ?, text = ?, hash = ?, change_state = ? WHERE id = ?',
          [incoming.position, incoming.anchor ?? null, incoming.text, hash, 'changed', candidate.id],
        );
        result.changed.push(candidate.id);
        continue;
      }

      result.added.push(insertBlock(sourceId, incoming, 'new'));
    }

    for (const block of existing) {
      if (matched.has(block.id)) continue;
      execute('UPDATE blocks SET change_state = ? WHERE id = ?', ['removed', block.id]);
      result.removed.push(block.id);
    }

    execute('UPDATE sources SET content_hash = ?, updated_at = ? WHERE id = ?', [
      hashText(blocks.map((b) => b.text).join('\n')),
      nowIso(),
      source.id,
    ]);

    return result;
  });
}

export function setSourceVersion(sourceId: string, externalVersion: string): void {
  execute('UPDATE sources SET external_version = ?, updated_at = ? WHERE id = ?', [
    externalVersion,
    nowIso(),
    sourceId,
  ]);
}

/**
 * Видаляє джерело (блоки йдуть каскадом). Зв'язки покриття НЕ видаляються —
 * лишаються «сиротами», як вимагає контракт API.
 */
export function deleteSource(id: string): void {
  requireSource(id);
  execute('DELETE FROM sources WHERE id = ?', [id]);
}

/** ID кейсів, зв'язаних із переданими блоками. */
export function casesForBlocks(blockIds: readonly string[]): Array<{ blockId: string; caseId: string }> {
  if (blockIds.length === 0) return [];
  return query<{ block_id: string; case_id: string }>(
    `SELECT block_id, case_id FROM coverage WHERE block_id IN (${blockIds.map(() => '?').join(', ')})`,
    [...blockIds],
  ).map((r) => ({ blockId: r.block_id, caseId: r.case_id }));
}

/* ═══════════════ Jules 2.0: дерево сторінок, кадри, зв'язки з макетом ═════ */

export function findSourceByExternal(projectId: string, kind: SourceKind, externalId: string): Source | null {
  const row = queryOne<Row>('SELECT * FROM sources WHERE project_id = ? AND kind = ? AND external_id = ?', [
    projectId,
    kind,
    externalId,
  ]);
  return row ? rowToSource(row) : null;
}

export interface SourceStubInput {
  projectId: string;
  kind: SourceKind;
  title: string;
  url?: string;
  externalId: string;
  externalVersion?: string;
  parentId?: string | null;
  rootId?: string | null;
  depth?: number;
  spaceKey?: string;
  included?: boolean;
}

/**
 * Запис джерела без блоків (вузол дерева сторінок або файл макета). Повторний
 * виклик оновлює назву й місце в дереві, але не чіпає галочки людини.
 */
export function upsertSourceStub(input: SourceStubInput): Source {
  const existing = findSourceByExternal(input.projectId, input.kind, input.externalId);
  const at = nowIso();
  if (existing) {
    execute(
      `UPDATE sources SET title = ?, url = COALESCE(?, url), parent_id = ?, root_id = ?, depth = ?, space_key = COALESCE(?, space_key),
         updated_at = ? WHERE id = ?`,
      [input.title, input.url ?? null, input.parentId ?? null, input.rootId ?? null, input.depth ?? 0, input.spaceKey ?? null, at, existing.id],
    );
    return requireSource(existing.id);
  }
  const id = newId('src');
  execute(
    `INSERT INTO sources (id, project_id, kind, title, url, external_id, external_version, content_hash, imported_at, updated_at,
       parent_id, root_id, depth, space_key, included)
     VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.projectId,
      input.kind,
      input.title,
      input.url ?? null,
      input.externalId,
      input.externalVersion ?? null,
      at,
      at,
      input.parentId ?? null,
      input.rootId ?? null,
      input.depth ?? 0,
      input.spaceKey ?? null,
      input.included === false ? 0 : 1,
    ],
  );
  return requireSource(id);
}

export function setSourceTreePosition(id: string, parentId: string | null, rootId: string | null): void {
  execute('UPDATE sources SET parent_id = ?, root_id = ? WHERE id = ?', [parentId, rootId, id]);
}

export interface SourceFlags {
  included?: boolean;
  noAgents?: boolean;
  sectionId?: string | null;
}

export function setSourceFlags(id: string, flags: SourceFlags): Source {
  requireSource(id);
  const sets: string[] = [];
  const params: unknown[] = [];
  if (flags.included !== undefined) {
    sets.push('included = ?');
    params.push(flags.included ? 1 : 0);
  }
  if (flags.noAgents !== undefined) {
    sets.push('no_agents = ?');
    params.push(flags.noAgents ? 1 : 0);
  }
  if (flags.sectionId !== undefined) {
    sets.push('section_id = ?');
    params.push(flags.sectionId);
  }
  if (sets.length > 0) execute(`UPDATE sources SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...params, nowIso(), id]);
  return requireSource(id);
}

/** Час останньої перевірки й остання помилка — для екрана входів і моніторингу. */
export function markSourceChecked(id: string, error?: string): void {
  execute('UPDATE sources SET checked_at = ?, last_error = ? WHERE id = ?', [nowIso(), error ?? null, id]);
}

export function setBlockExtras(blockId: string, extras: { nodeId?: string; meta?: BlockMeta }): void {
  execute('UPDATE blocks SET node_id = COALESCE(?, node_id), meta = ? WHERE id = ?', [
    extras.nodeId ?? null,
    JSON.stringify(extras.meta ?? {}),
    blockId,
  ]);
}

/** Зіставлення кадру макета з маршрутом застосунку (для візуальних перевірок). */
export function setBlockRoute(blockId: string, route: string | null): Block {
  const block = getBlock(blockId);
  if (!block) throw new Error(`Блок «${blockId}» не знайдено`);
  execute('UPDATE blocks SET route = ? WHERE id = ?', [route, blockId]);
  return getBlock(blockId) as Block;
}

/** Блоки джерела, що лишилися після оновлення, у порядку позицій. */
export function liveBlocks(sourceId: string): Block[] {
  return listBlocks(sourceId).filter((block) => block.changeState !== 'removed');
}

export interface SourceTreeNode extends Source {
  blockCount: number;
  children: SourceTreeNode[];
}

/** Дерево джерел проєкту: сторінки Confluence за батьками, решта — коренями. */
export function sourceTree(projectId: string): SourceTreeNode[] {
  const items = listSources(projectId);
  const byId = new Map<string, SourceTreeNode>(items.map((item) => [item.id, { ...item, children: [] }]));
  const roots: SourceTreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (nodes: SourceTreeNode[]) => {
    nodes.sort((a, b) => a.title.localeCompare(b.title, 'uk'));
    for (const node of nodes) sort(node.children);
  };
  sort(roots);
  return roots;
}

/**
 * Чи закрите джерело для агентів: позначка «не віддавати агентам» на ньому
 * самому або на будь-якому предку в дереві (дочірні сторінки її успадковують).
 */
export function isNoAgents(sourceId: string | undefined | null): boolean {
  const seen = new Set<string>();
  let current = sourceId ?? null;
  while (current && !seen.has(current)) {
    seen.add(current);
    const row = queryOne<Row>('SELECT parent_id, no_agents FROM sources WHERE id = ?', [current]);
    if (!row) return false;
    if (Number(row.no_agents) === 1) return true;
    current = (row.parent_id as string | null) ?? null;
  }
  return false;
}

/** Нащадки джерела в дереві (без нього самого). */
export function descendantSourceIds(id: string): string[] {
  const out: string[] = [];
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const row of query<Row>('SELECT id FROM sources WHERE parent_id = ?', [current])) {
      out.push(String(row.id));
      queue.push(String(row.id));
    }
  }
  return out;
}

/* ─────────────────────── зв'язки «сторінка ↔ кадр Figma» ───────────────── */

export function upsertBlockLink(input: { projectId: string; fromBlockId: string; url: string; fileKey?: string; nodeId?: string }): void {
  execute(
    `INSERT INTO block_links (id, project_id, from_block_id, url, file_key, node_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(from_block_id, url) DO UPDATE SET file_key = excluded.file_key, node_id = excluded.node_id`,
    [newId('lnk'), input.projectId, input.fromBlockId, input.url, input.fileKey ?? null, input.nodeId ?? null, nowIso()],
  );
}

export function pruneBlockLinks(fromBlockId: string, keepUrls: string[]): void {
  const rows = query<Row>('SELECT id, url FROM block_links WHERE from_block_id = ?', [fromBlockId]);
  for (const row of rows) if (!keepUrls.includes(String(row.url))) execute('DELETE FROM block_links WHERE id = ?', [row.id]);
}

/**
 * Прив'язує посилання сторінок до кадрів імпортованих файлів Figma: за ключем
 * файлу і вузлом. Повертає кількість прив'язаних посилань.
 */
export function resolveFigmaLinks(projectId: string): number {
  const links = query<Row>('SELECT id, file_key, node_id FROM block_links WHERE project_id = ? AND file_key IS NOT NULL', [projectId]);
  let linked = 0;
  for (const link of links) {
    let target: Row | undefined;
    if (link.node_id) {
      target = queryOne<Row>(
        `SELECT b.id FROM blocks b JOIN sources s ON s.id = b.source_id
         WHERE s.project_id = ? AND s.kind = 'figma' AND s.external_id LIKE ? AND b.node_id = ? AND b.change_state <> 'removed'`,
        [projectId, `${link.file_key}%`, link.node_id],
      );
    }
    execute('UPDATE block_links SET to_block_id = ? WHERE id = ?', [target?.id ?? null, link.id]);
    if (target) linked += 1;
  }
  return linked;
}

export function listBlockLinks(blockIds: readonly string[]): Array<{ fromBlockId: string; toBlockId?: string; url: string; fileKey?: string; nodeId?: string }> {
  if (blockIds.length === 0) return [];
  return query<Row>(`SELECT * FROM block_links WHERE from_block_id IN (${blockIds.map(() => '?').join(', ')})`, [...blockIds]).map((row) => ({
    fromBlockId: String(row.from_block_id),
    toBlockId: (row.to_block_id as string | null) ?? undefined,
    url: String(row.url),
    fileKey: (row.file_key as string | null) ?? undefined,
    nodeId: (row.node_id as string | null) ?? undefined,
  }));
}
