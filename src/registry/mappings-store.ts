/** Профілі мапінгу TestRail. */
import { execute, fromJson, nowIso, query, queryOne, toJson, type Row } from './db.js';
import { newId } from './ids.js';
import { testrailMappingSchema, type TestrailMapping } from './types.js';

function rowToMapping(row: Row): TestrailMapping {
  return testrailMappingSchema.parse({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    template: row.template ?? 'checklist',
    fields: fromJson<Record<string, string>>(row.fields, {}),
    typeMap: fromJson<Record<string, number>>(row.type_map, {}),
    priorityMap: fromJson<Record<string, number>>(row.priority_map, {}),
    idField: row.id_field ?? 'custom_tc_id',
    delimiter: row.delimiter ?? ',',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function listMappings(projectId: string): TestrailMapping[] {
  return query<Row>('SELECT * FROM testrail_mappings WHERE project_id = ? ORDER BY name', [
    projectId,
  ]).map(rowToMapping);
}

export function getMapping(id: string): TestrailMapping | null {
  const row = queryOne<Row>('SELECT * FROM testrail_mappings WHERE id = ?', [id]);
  return row ? rowToMapping(row) : null;
}

export function requireMapping(id: string): TestrailMapping {
  const mapping = getMapping(id);
  if (!mapping) throw new Error(`Профіль мапінгу «${id}» не знайдено`);
  return mapping;
}

export type MappingInput = Omit<TestrailMapping, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };

export function createMapping(input: MappingInput): TestrailMapping {
  const id = input.id ?? newId('map');
  const at = nowIso();
  execute(
    `INSERT INTO testrail_mappings
       (id, project_id, name, template, fields, type_map, priority_map, id_field, delimiter, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.projectId,
      input.name,
      input.template ?? 'checklist',
      toJson(input.fields ?? {}),
      toJson(input.typeMap ?? {}),
      toJson(input.priorityMap ?? {}),
      input.idField ?? 'custom_tc_id',
      input.delimiter ?? ',',
      at,
      at,
    ],
  );
  return requireMapping(id);
}

export function updateMapping(id: string, patch: Partial<MappingInput>): TestrailMapping {
  const existing = requireMapping(id);
  const sets: string[] = [];
  const params: unknown[] = [];

  const simple: Array<[keyof MappingInput, string]> = [
    ['name', 'name'],
    ['template', 'template'],
    ['idField', 'id_field'],
    ['delimiter', 'delimiter'],
  ];
  for (const [field, column] of simple) {
    if (patch[field] === undefined) continue;
    sets.push(`${column} = ?`);
    params.push(patch[field]);
  }
  const jsonFields: Array<[keyof MappingInput, string]> = [
    ['fields', 'fields'],
    ['typeMap', 'type_map'],
    ['priorityMap', 'priority_map'],
  ];
  for (const [field, column] of jsonFields) {
    if (patch[field] === undefined) continue;
    sets.push(`${column} = ?`);
    params.push(toJson(patch[field]));
  }
  if (sets.length === 0) return existing;

  sets.push('updated_at = ?');
  params.push(nowIso(), id);
  execute(`UPDATE testrail_mappings SET ${sets.join(', ')} WHERE id = ?`, params);
  return requireMapping(id);
}
