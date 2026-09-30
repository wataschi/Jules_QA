/** Сховище секцій (дерево модулів проєкту). */
import { execute, nowIso, query, queryOne, scalar, tx, type Row } from './db.js';
import { generateSectionCode, newId } from './ids.js';
import { sectionInputSchema, sectionSchema, type Section, type SectionNode } from './types.js';

function rowToSection(row: Row): Section {
  return sectionSchema.parse({
    id: row.id,
    projectId: row.project_id,
    parentId: row.parent_id ?? null,
    name: row.name,
    code: row.code,
    position: Number(row.position ?? 0),
    testrailSectionId: row.testrail_section_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function listSections(projectId: string): Section[] {
  return query<Row>(
    'SELECT * FROM sections WHERE project_id = ? ORDER BY position, name',
    [projectId],
  ).map(rowToSection);
}

export function getSection(id: string): Section | null {
  const row = queryOne<Row>('SELECT * FROM sections WHERE id = ?', [id]);
  return row ? rowToSection(row) : null;
}

export function requireSection(id: string): Section {
  const section = getSection(id);
  if (!section) throw new Error(`Секцію «${id}» не знайдено`);
  return section;
}

export function getSectionByCode(projectId: string, code: string): Section | null {
  const row = queryOne<Row>('SELECT * FROM sections WHERE project_id = ? AND code = ?', [
    projectId,
    code.toUpperCase(),
  ]);
  return row ? rowToSection(row) : null;
}

export function getSectionByName(projectId: string, name: string, parentId: string | null = null): Section | null {
  const row = queryOne<Row>(
    `SELECT * FROM sections
     WHERE project_id = ? AND name = ? AND (parent_id IS ? OR parent_id = ?)`,
    [projectId, name, parentId, parentId],
  );
  return row ? rowToSection(row) : null;
}

export function takenCodes(projectId: string): string[] {
  return query<{ code: string }>('SELECT code FROM sections WHERE project_id = ?', [projectId]).map(
    (r) => r.code,
  );
}

export interface CreateSectionInput {
  projectId: string;
  name: string;
  parentId?: string | null;
  code?: string;
  position?: number;
  testrailSectionId?: number;
}

export function createSection(input: CreateSectionInput): Section {
  const parsed = sectionInputSchema.parse(input);
  return tx(() => {
    const code = (parsed.code ?? generateSectionCode(parsed.name, takenCodes(parsed.projectId))).toUpperCase();
    if (getSectionByCode(parsed.projectId, code)) {
      throw new Error(`Код секції «${code}» уже використано в проєкті`);
    }
    const id = newId('sec');
    const at = nowIso();
    const position =
      parsed.position ??
      Number(
        scalar<number>(
          `SELECT COALESCE(MAX(position), -1) + 1 FROM sections
           WHERE project_id = ? AND (parent_id IS ? OR parent_id = ?)`,
          [parsed.projectId, parsed.parentId ?? null, parsed.parentId ?? null],
        ) ?? 0,
      );

    execute(
      `INSERT INTO sections
         (id, project_id, parent_id, name, code, position, testrail_section_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        parsed.projectId,
        parsed.parentId ?? null,
        parsed.name,
        code,
        position,
        parsed.testrailSectionId ?? null,
        at,
        at,
      ],
    );
    return requireSection(id);
  });
}

export interface UpdateSectionPatch {
  name?: string;
  parentId?: string | null;
  position?: number;
  testrailSectionId?: number;
}

export function updateSection(id: string, patch: UpdateSectionPatch): Section {
  const existing = requireSection(id);
  if (patch.parentId && patch.parentId === id) {
    throw new Error('Секція не може бути власним батьком');
  }
  if (patch.parentId && descendantIds(id).includes(patch.parentId)) {
    throw new Error('Не можна перемістити секцію в її ж підсекцію');
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    params.push(patch.name);
  }
  if ('parentId' in patch) {
    sets.push('parent_id = ?');
    params.push(patch.parentId ?? null);
  }
  if (patch.position !== undefined) {
    sets.push('position = ?');
    params.push(patch.position);
  }
  if (patch.testrailSectionId !== undefined) {
    sets.push('testrail_section_id = ?');
    params.push(patch.testrailSectionId);
  }
  if (sets.length === 0) return existing;

  sets.push('updated_at = ?');
  params.push(nowIso(), id);
  execute(`UPDATE sections SET ${sets.join(', ')} WHERE id = ?`, params);
  // `code` навмисно не оновлюється: ID уже виданих кейсів на нього спираються.
  return requireSection(id);
}

/** ID усіх нащадків секції (без самої секції). */
export function descendantIds(sectionId: string): string[] {
  return query<{ id: string }>(
    `WITH RECURSIVE subtree(id) AS (
       SELECT id FROM sections WHERE parent_id = ?
       UNION
       SELECT s.id FROM sections s JOIN subtree t ON s.parent_id = t.id
     )
     SELECT id FROM subtree`,
    [sectionId],
  ).map((r) => r.id);
}

export interface DeleteSectionOptions {
  moveCasesTo?: string;
}

export function deleteSection(id: string, options: DeleteSectionOptions = {}): void {
  const section = requireSection(id);
  tx(() => {
    const children = Number(
      scalar<number>('SELECT COUNT(*) FROM sections WHERE parent_id = ?', [id]) ?? 0,
    );
    if (children > 0) {
      throw new Error('Секція має дочірні секції — спершу перенесіть або видаліть їх');
    }
    const caseCount = Number(
      scalar<number>('SELECT COUNT(*) FROM cases WHERE section_id = ?', [id]) ?? 0,
    );
    if (caseCount > 0) {
      if (!options.moveCasesTo) {
        throw new Error('Секція містить кейси — передайте ?moveCasesTo=<sectionId>');
      }
      const target = requireSection(options.moveCasesTo);
      if (target.projectId !== section.projectId) {
        throw new Error('Перенести кейси можна лише в секцію того самого проєкту');
      }
      execute('UPDATE cases SET section_id = ?, updated_at = ? WHERE section_id = ?', [
        target.id,
        nowIso(),
        id,
      ]);
    }
    execute('DELETE FROM case_counters WHERE section_id = ?', [id]);
    execute('DELETE FROM sections WHERE id = ?', [id]);
  });
}

/** `id → «Кібер / Карта договору / Акти»` для всіх секцій проєкту. */
export function sectionPathMap(projectId: string): Map<string, string> {
  const sections = listSections(projectId);
  const byId = new Map(sections.map((s) => [s.id, s]));
  const cache = new Map<string, string>();

  const resolve = (id: string, guard = 0): string => {
    if (cache.has(id)) return cache.get(id) as string;
    const section = byId.get(id);
    if (!section || guard > 50) return '';
    const path = section.parentId
      ? `${resolve(section.parentId, guard + 1)} / ${section.name}`
      : section.name;
    cache.set(id, path);
    return path;
  };

  for (const section of sections) resolve(section.id);
  return cache;
}

export function sectionPath(sectionId: string): string {
  const section = getSection(sectionId);
  if (!section) return '';
  return sectionPathMap(section.projectId).get(sectionId) ?? section.name;
}

/** Дерево з лічильниками кейсів — відповідь `GET /sections`. */
export function sectionTree(projectId: string): SectionNode[] {
  const sections = listSections(projectId);
  const direct = new Map(
    query<{ section_id: string; n: number }>(
      'SELECT section_id, COUNT(*) AS n FROM cases WHERE project_id = ? GROUP BY section_id',
      [projectId],
    ).map((r) => [r.section_id, Number(r.n)]),
  );
  const paths = sectionPathMap(projectId);

  const nodes = new Map<string, SectionNode>();
  for (const section of sections) {
    nodes.set(section.id, {
      ...section,
      path: paths.get(section.id) ?? section.name,
      caseCount: direct.get(section.id) ?? 0,
      caseCountDeep: 0,
      children: [],
    });
  }

  const roots: SectionNode[] = [];
  for (const section of sections) {
    const node = nodes.get(section.id) as SectionNode;
    const parent = section.parentId ? nodes.get(section.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const deep = (node: SectionNode): number => {
    node.children.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    node.caseCountDeep = node.caseCount + node.children.reduce((sum, child) => sum + deep(child), 0);
    return node.caseCountDeep;
  };
  roots.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  for (const root of roots) deep(root);

  return roots;
}
