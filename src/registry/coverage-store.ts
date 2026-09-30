/** Зв'язки «блок вимоги ↔ кейс» і матриця покриття. */
import { execute, nowIso, query, queryOne, type Row } from './db.js';
import { newId } from './ids.js';
import { blockSchema, coverageSchema, type Coverage, type CoverageKind, type CoverageRow } from './types.js';

function rowToCoverage(row: Row): Coverage {
  return coverageSchema.parse({
    id: row.id,
    blockId: row.block_id,
    caseId: row.case_id,
    kind: row.kind,
    confirmed: Boolean(row.confirmed),
    note: row.note ?? '',
    createdAt: row.created_at,
  });
}

export interface LinkCoverageInput {
  blockId: string;
  caseId: string;
  kind?: CoverageKind;
  confirmed?: boolean;
  note?: string;
}

/** Ідемпотентний зв'язок: повторний виклик оновлює `kind`/`confirmed`/`note`. */
export function linkCoverage(input: LinkCoverageInput): Coverage {
  const existing = queryOne<Row>('SELECT * FROM coverage WHERE block_id = ? AND case_id = ?', [
    input.blockId,
    input.caseId,
  ]);
  if (existing) {
    execute('UPDATE coverage SET kind = ?, confirmed = ?, note = ? WHERE id = ?', [
      input.kind ?? existing.kind,
      input.confirmed === undefined ? existing.confirmed : input.confirmed,
      input.note ?? existing.note ?? '',
      existing.id,
    ]);
    return rowToCoverage(
      queryOne<Row>('SELECT * FROM coverage WHERE id = ?', [existing.id]) as Row,
    );
  }

  const id = newId('cov');
  execute(
    `INSERT INTO coverage (id, block_id, case_id, kind, confirmed, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, input.blockId, input.caseId, input.kind ?? 'quote', input.confirmed ?? false, input.note ?? '', nowIso()],
  );
  return rowToCoverage(queryOne<Row>('SELECT * FROM coverage WHERE id = ?', [id]) as Row);
}

export function unlinkCoverage(id: string): boolean {
  const changes = execute('DELETE FROM coverage WHERE id = ?', [id]);
  return Number(changes.changes) > 0;
}

export function listCoverageForCase(caseId: string): Coverage[] {
  return query<Row>('SELECT * FROM coverage WHERE case_id = ? ORDER BY created_at', [caseId]).map(
    rowToCoverage,
  );
}

export interface CoverageStats {
  blocks: number;
  coveredBlocks: number;
  gaps: number;
  quoteLinks: number;
  derivedLinks: number;
  derivedShare: number;
  confirmed: number;
}

export interface CoverageMatrix {
  rows: CoverageRow[];
  stats: CoverageStats;
}

/**
 * Матриця покриття: блоки джерел проєкту з прив'язаними кейсами.
 * Агрегати рахує SQL, у JS лише склеювання рядків.
 */
export function coverageMatrix(projectId: string, sourceId?: string): CoverageMatrix {
  const params: unknown[] = [projectId];
  let filter = 's.project_id = ?';
  if (sourceId) {
    filter += ' AND s.id = ?';
    params.push(sourceId);
  }

  const blockRows = query<Row>(
    `SELECT b.* FROM blocks b JOIN sources s ON s.id = b.source_id
     WHERE ${filter} AND b.change_state <> 'removed'
     ORDER BY s.imported_at, b.position`,
    params,
  );

  const links = query<Row>(
    `SELECT cv.block_id, cv.case_id, cv.kind, cv.confirmed, c.title
     FROM coverage cv
     JOIN blocks b ON b.id = cv.block_id
     JOIN sources s ON s.id = b.source_id
     LEFT JOIN cases c ON c.id = cv.case_id
     WHERE ${filter}`,
    params,
  );

  const byBlock = new Map<string, CoverageRow['cases']>();
  for (const link of links) {
    const bucket = byBlock.get(String(link.block_id)) ?? [];
    bucket.push({
      caseId: String(link.case_id),
      title: String(link.title ?? '(кейс видалено)'),
      kind: link.kind as CoverageKind,
      confirmed: Boolean(link.confirmed),
    });
    byBlock.set(String(link.block_id), bucket);
  }

  const rows: CoverageRow[] = blockRows.map((row) => {
    const block = blockSchema.parse({
      id: row.id,
      sourceId: row.source_id,
      position: Number(row.position ?? 0),
      heading: row.heading ?? '',
      anchor: row.anchor ?? undefined,
      text: row.text,
      hash: row.hash,
      changeState: row.change_state ?? 'new',
    });
    const cases = byBlock.get(block.id) ?? [];
    return { block, cases, gap: cases.length === 0 };
  });

  const quoteLinks = links.filter((l) => l.kind === 'quote').length;
  const derivedLinks = links.filter((l) => l.kind === 'derived').length;
  const coveredBlocks = rows.filter((r) => !r.gap).length;

  return {
    rows,
    stats: {
      blocks: rows.length,
      coveredBlocks,
      gaps: rows.length - coveredBlocks,
      quoteLinks,
      derivedLinks,
      derivedShare: quoteLinks + derivedLinks > 0 ? derivedLinks / (quoteLinks + derivedLinks) : 0,
      confirmed: links.filter((l) => Boolean(l.confirmed)).length,
    },
  };
}
