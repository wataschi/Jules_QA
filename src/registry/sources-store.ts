/** Сховище джерел вимог (`sources`) і блоків тексту (`blocks`). */
import { createHash } from 'node:crypto';
import { execute, nowIso, query, queryOne, tx, type Row } from './db.js';
import { newId } from './ids.js';
import { blockSchema, sourceSchema, type Block, type Source, type SourceKind } from './types.js';

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
