/** Сховище проєктів реєстру. */
import { execute, nowIso, query, queryOne, type Row } from './db.js';
import { slugify } from './ids.js';
import { projectInputSchema, projectSchema, type Project, type ProjectInput } from './types.js';

function rowToProject(row: Row): Project {
  return projectSchema.parse({
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description ?? '',
    baseUrl: row.base_url ?? undefined,
    confluenceSpace: row.confluence_space ?? undefined,
    testrailProjectId: row.testrail_project_id ?? undefined,
    testrailSuiteId: row.testrail_suite_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function listProjects(): Project[] {
  return query<Row>('SELECT * FROM projects ORDER BY name').map(rowToProject);
}

export function getProject(id: string): Project | null {
  const row = queryOne<Row>('SELECT * FROM projects WHERE id = ?', [id]);
  return row ? rowToProject(row) : null;
}

export function getProjectByKey(key: string): Project | null {
  const row = queryOne<Row>('SELECT * FROM projects WHERE key = ?', [key.toUpperCase()]);
  return row ? rowToProject(row) : null;
}

/** Проєкт або помилка 404-рівня — зручно для маршрутів. */
export function requireProject(id: string): Project {
  const project = getProject(id);
  if (!project) throw new Error(`Проєкт «${id}» не знайдено`);
  return project;
}

export function createProject(input: ProjectInput): Project {
  const parsed = projectInputSchema.parse(input);
  const id = uniqueProjectId(parsed.id ?? slugify(parsed.key ?? parsed.name, 'project'));
  const at = nowIso();

  if (getProjectByKey(parsed.key)) {
    throw new Error(`Проєкт із ключем «${parsed.key}» уже існує`);
  }

  execute(
    `INSERT INTO projects
       (id, key, name, description, base_url, confluence_space, testrail_project_id, testrail_suite_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      parsed.key.toUpperCase(),
      parsed.name,
      parsed.description ?? '',
      parsed.baseUrl ?? null,
      parsed.confluenceSpace ?? null,
      parsed.testrailProjectId ?? null,
      parsed.testrailSuiteId ?? null,
      at,
      at,
    ],
  );
  return requireProject(id);
}

const PATCHABLE: Record<string, string> = {
  name: 'name',
  description: 'description',
  baseUrl: 'base_url',
  confluenceSpace: 'confluence_space',
  testrailProjectId: 'testrail_project_id',
  testrailSuiteId: 'testrail_suite_id',
  key: 'key',
};

export function updateProject(id: string, patch: Partial<ProjectInput>): Project {
  const existing = requireProject(id);
  const sets: string[] = [];
  const params: unknown[] = [];

  for (const [field, column] of Object.entries(PATCHABLE)) {
    if (!(field in patch)) continue;
    const value = (patch as Record<string, unknown>)[field];
    sets.push(`${column} = ?`);
    params.push(field === 'key' && typeof value === 'string' ? value.toUpperCase() : (value ?? null));
  }

  if (sets.length === 0) return existing;
  sets.push('updated_at = ?');
  params.push(nowIso(), id);
  execute(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`, params);
  return requireProject(id);
}

function uniqueProjectId(base: string): string {
  let candidate = base;
  let counter = 2;
  while (queryOne('SELECT id FROM projects WHERE id = ?', [candidate])) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  return candidate;
}
