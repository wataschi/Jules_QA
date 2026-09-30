/** Лог запусків AI-скілів: вхід, вихід, токени, час, помилки. */
import { execute, fromJson, nowIso, query, queryOne, scalar, toJson, type Row } from './db.js';
import { newId } from './ids.js';
import { skillRunSchema, type Page, type SkillName, type SkillRun } from './types.js';

function rowToSkillRun(row: Row): SkillRun {
  return skillRunSchema.parse({
    id: row.id,
    projectId: row.project_id,
    skill: row.skill,
    state: row.state ?? 'running',
    input: fromJson<unknown>(row.input, null),
    output: fromJson<unknown>(row.output, undefined),
    model: row.model ?? undefined,
    proposalCount: Number(row.proposal_count ?? 0),
    promptTokens: row.prompt_tokens === null || row.prompt_tokens === undefined ? undefined : Number(row.prompt_tokens),
    completionTokens:
      row.completion_tokens === null || row.completion_tokens === undefined
        ? undefined
        : Number(row.completion_tokens),
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? undefined : Number(row.duration_ms),
    error: row.error ?? undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
  });
}

export function startSkillRun(projectId: string, skill: SkillName, input: unknown): SkillRun {
  const id = newId('skr');
  execute(
    `INSERT INTO skill_runs (id, project_id, skill, state, input, started_at)
     VALUES (?, ?, ?, 'running', ?, ?)`,
    [id, projectId, skill, toJson(input), nowIso()],
  );
  return requireSkillRun(id);
}

export interface FinishSkillRunInput {
  state: 'done' | 'failed';
  output?: unknown;
  model?: string;
  proposalCount?: number;
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
  error?: string;
}

export function finishSkillRun(id: string, input: FinishSkillRunInput): SkillRun {
  execute(
    `UPDATE skill_runs
       SET state = ?, output = ?, model = ?, proposal_count = ?, prompt_tokens = ?,
           completion_tokens = ?, duration_ms = ?, error = ?, finished_at = ?
     WHERE id = ?`,
    [
      input.state,
      input.output === undefined ? null : toJson(input.output),
      input.model ?? null,
      input.proposalCount ?? 0,
      input.promptTokens ?? null,
      input.completionTokens ?? null,
      input.durationMs ?? null,
      input.error ?? null,
      nowIso(),
      id,
    ],
  );
  return requireSkillRun(id);
}

export function getSkillRun(id: string): SkillRun | null {
  const row = queryOne<Row>('SELECT * FROM skill_runs WHERE id = ?', [id]);
  return row ? rowToSkillRun(row) : null;
}

export function requireSkillRun(id: string): SkillRun {
  const run = getSkillRun(id);
  if (!run) throw new Error(`Запуск скіла «${id}» не знайдено`);
  return run;
}

export interface ListSkillRunsOptions {
  projectId: string;
  skill?: SkillName;
  page?: number;
  limit?: number;
}

export function listSkillRuns(options: ListSkillRunsOptions): Page<SkillRun> {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 50)));
  const where = ['project_id = ?'];
  const params: unknown[] = [options.projectId];
  if (options.skill) {
    where.push('skill = ?');
    params.push(options.skill);
  }
  const clause = where.join(' AND ');
  const total = Number(scalar<number>(`SELECT COUNT(*) FROM skill_runs WHERE ${clause}`, params) ?? 0);
  const items = query<Row>(
    `SELECT * FROM skill_runs WHERE ${clause} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, (page - 1) * limit],
  ).map(rowToSkillRun);
  return { items, total, page, limit };
}
