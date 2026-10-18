/**
 * Вкладення вимог: картинки, схеми й знімки кадрів Figma.
 *
 * Файл лежить у `data/assets/<sha256>`: однакова картинка на кількох сторінках
 * зберігається один раз, а погоджене QA прочитання переноситься на нову копію
 * за хешем — поки картинка не змінилась, агент її не перечитує.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getAssetsDir } from '../server/data-paths.js';
import { execute, nowIso, placeholders, query, queryOne, tx, type Row } from './db.js';
import { newId } from './ids.js';
import { assetSchema, type Asset, type AssetKind, type ReadingState } from './types.js';

function rowToAsset(row: Row): Asset {
  return assetSchema.parse({
    id: row.id,
    projectId: row.project_id,
    sourceId: row.source_id ?? undefined,
    blockId: row.block_id ?? undefined,
    kind: row.kind,
    name: row.name,
    diagramType: row.diagram_type ?? undefined,
    mediaType: row.media_type ?? undefined,
    sha256: row.sha256 ?? undefined,
    size: row.size ?? undefined,
    originUrl: row.origin_url ?? undefined,
    extractedText: row.extracted_text ?? '',
    reading: row.reading ?? undefined,
    readingBy: row.reading_by ?? undefined,
    readingState: row.reading_state ?? 'none',
    readingDecidedBy: row.reading_decided_by ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/** Пише байти у сховище за хешем; повторний запис того самого вмісту — без змін. */
export function storeAssetFile(data: Buffer): { sha256: string; size: number } {
  const sha256 = createHash('sha256').update(data).digest('hex');
  const dir = getAssetsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, sha256);
  if (!fs.existsSync(file)) fs.writeFileSync(file, data);
  return { sha256, size: data.length };
}

export function assetFilePath(asset: Pick<Asset, 'sha256'>): string | null {
  if (!asset.sha256 || !/^[a-f0-9]{64}$/.test(asset.sha256)) return null;
  const file = path.join(getAssetsDir(), asset.sha256);
  return fs.existsSync(file) ? file : null;
}

export interface UpsertAssetInput {
  projectId: string;
  sourceId?: string;
  blockId?: string;
  kind: AssetKind;
  name: string;
  diagramType?: string;
  mediaType?: string;
  sha256?: string;
  size?: number;
  originUrl?: string;
  extractedText?: string;
  error?: string;
}

/**
 * Створює або оновлює вкладення блоку (ключ — блок + вид + назва). Якщо текст
 * без моделі витягти не вдалося, зміст лишається лише в картинці — потрібне
 * прочитання. Погоджене прочитання того самого файлу переноситься.
 */
export function upsertAsset(input: UpsertAssetInput): { asset: Asset; needsReading: boolean } {
  return tx(() => {
    const at = nowIso();
    const existing = queryOne<Row>(
      'SELECT * FROM assets WHERE project_id = ? AND block_id IS ? AND kind = ? AND name = ?',
      [input.projectId, input.blockId ?? null, input.kind, input.name],
    );
    const extracted = (input.extractedText ?? '').trim();
    const sameFile = existing && existing.sha256 && existing.sha256 === input.sha256;

    let reading: string | null = sameFile ? ((existing?.reading as string | null) ?? null) : null;
    let readingBy: string | null = sameFile ? ((existing?.reading_by as string | null) ?? null) : null;
    let readingState: ReadingState = sameFile ? ((existing?.reading_state as ReadingState) ?? 'none') : 'none';
    let decidedBy: string | null = sameFile ? ((existing?.reading_decided_by as string | null) ?? null) : null;

    if (!sameFile && input.sha256) {
      const approved = queryOne<Row>(
        `SELECT reading, reading_by, reading_decided_by FROM assets
         WHERE project_id = ? AND sha256 = ? AND reading_state = 'approved' LIMIT 1`,
        [input.projectId, input.sha256],
      );
      if (approved) {
        reading = (approved.reading as string) ?? null;
        readingBy = (approved.reading_by as string) ?? null;
        decidedBy = (approved.reading_decided_by as string) ?? null;
        readingState = 'approved';
      }
    }
    // Картинку завжди читають: підпис (alt) — лише підказка, полів і станів він не описує.
    // Схеми, з яких текст уже витягнуто без моделі, прочитання не потребують.
    const contentOnlyInPixels = input.kind === 'image' || (input.kind === 'diagram' && !extracted);
    if (readingState === 'none' && contentOnlyInPixels && !input.error && input.sha256) {
      readingState = 'needed';
    }

    const values = [
      input.sourceId ?? null,
      input.diagramType ?? null,
      input.mediaType ?? null,
      input.sha256 ?? null,
      input.size ?? null,
      input.originUrl ?? null,
      extracted,
      reading,
      readingBy,
      readingState,
      decidedBy,
      input.error ?? null,
      at,
    ];
    let id: string;
    if (existing) {
      id = String(existing.id);
      execute(
        `UPDATE assets SET source_id = ?, diagram_type = ?, media_type = ?, sha256 = ?, size = ?, origin_url = ?,
           extracted_text = ?, reading = ?, reading_by = ?, reading_state = ?, reading_decided_by = ?, error = ?, updated_at = ?
         WHERE id = ?`,
        [...values, id],
      );
    } else {
      id = newId('ast');
      execute(
        `INSERT INTO assets (source_id, diagram_type, media_type, sha256, size, origin_url, extracted_text, reading,
           reading_by, reading_state, reading_decided_by, error, updated_at, id, project_id, block_id, kind, name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [...values, id, input.projectId, input.blockId ?? null, input.kind, input.name, at],
      );
    }
    const asset = requireAsset(id);
    const changedFile = !existing || !sameFile;
    return { asset, needsReading: asset.readingState === 'needed' && changedFile };
  });
}

export function getAsset(id: string): Asset | null {
  const row = queryOne<Row>('SELECT * FROM assets WHERE id = ?', [id]);
  return row ? rowToAsset(row) : null;
}

export function requireAsset(id: string): Asset {
  const asset = getAsset(id);
  if (!asset) throw new Error(`Вкладення «${id}» не знайдено`);
  return asset;
}

export function listAssetsForBlocks(blockIds: readonly string[]): Asset[] {
  if (blockIds.length === 0) return [];
  return query<Row>(`SELECT * FROM assets WHERE block_id IN (${placeholders(blockIds.length)}) ORDER BY name`, [
    ...blockIds,
  ]).map(rowToAsset);
}

export function listAssets(projectId: string, options: { readingState?: ReadingState; sourceId?: string } = {}): Asset[] {
  const where = ['project_id = ?'];
  const params: unknown[] = [projectId];
  if (options.readingState) {
    where.push('reading_state = ?');
    params.push(options.readingState);
  }
  if (options.sourceId) {
    where.push('source_id = ?');
    params.push(options.sourceId);
  }
  return query<Row>(`SELECT * FROM assets WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`, params).map(rowToAsset);
}

/** Прибирає вкладення блоку, яких немає в новій версії сторінки. */
export function pruneBlockAssets(blockId: string, keep: Array<{ kind: AssetKind; name: string }>): number {
  const keys = new Set(keep.map((item) => `${item.kind}:${item.name}`));
  const rows = query<Row>('SELECT id, kind, name FROM assets WHERE block_id = ?', [blockId]);
  let removed = 0;
  for (const row of rows) {
    if (keys.has(`${row.kind}:${row.name}`)) continue;
    execute('DELETE FROM assets WHERE id = ?', [row.id]);
    removed += 1;
  }
  return removed;
}

/** Агент описав картинку — опис чекає на рішення QA. */
export function proposeReading(id: string, reading: string, by: string): Asset {
  const asset = requireAsset(id);
  if (asset.readingState === 'approved' && asset.reading === reading) return asset;
  execute(
    `UPDATE assets SET reading = ?, reading_by = ?, reading_state = 'proposed', reading_decided_by = NULL, updated_at = ? WHERE id = ?`,
    [reading, by, nowIso(), id],
  );
  return requireAsset(id);
}

/** Рішення QA щодо прочитання; правку тексту можна внести разом із погодженням. */
export function decideReading(id: string, approve: boolean, by: string, editedReading?: string): Asset {
  const asset = requireAsset(id);
  if (asset.readingState !== 'proposed') throw new Error('Прочитання ще не запропоноване або вже вирішене');
  execute('UPDATE assets SET reading = ?, reading_state = ?, reading_decided_by = ?, updated_at = ? WHERE id = ?', [
    editedReading ?? asset.reading ?? null,
    approve ? 'approved' : 'rejected',
    by,
    nowIso(),
    id,
  ]);
  return requireAsset(id);
}

/** Текст вкладення для агента: витягнуте без моделі або погоджене прочитання. */
export function assetText(asset: Asset): string {
  const reading = asset.readingState === 'approved' && asset.reading ? asset.reading : '';
  return [asset.extractedText, reading].filter(Boolean).join('\n');
}
