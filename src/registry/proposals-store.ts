/**
 * Черга апрувів. Вихід AI-скілів і переімпорту вимог потрапляє сюди,
 * а не прямо в реєстр: інженер бачить diff, править формулювання й апрувить.
 */
import { execute, fromJson, nowIso, query, queryOne, scalar, toJson, tx, type Row } from './db.js';
import { newId } from './ids.js';
import { createCase, deleteCase, requireCase, setAutomation, updateCase, type CasePatch } from './cases-store.js';
import { linkCoverage } from './coverage-store.js';
import { runBulk } from './bulk.js';
import { addRevision } from './revisions-store.js';
import {
  bulkRequestSchema,
  caseInputSchema,
  proposalSchema,
  type CoverageKind,
  type Page,
  type Proposal,
  type ProposalKind,
  type ProposalState,
} from './types.js';

type OriginShape = NonNullable<Proposal['origin']>;

function rowToProposal(row: Row): Proposal {
  return proposalSchema.parse({
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    state: row.state,
    title: row.title,
    rationale: row.rationale ?? '',
    payload: fromJson<unknown>(row.payload, null),
    diff: fromJson<Proposal['diff']>(row.diff, {}),
    origin: fromJson<OriginShape>(row.origin, {}),
    coverageKind: row.coverage_kind ?? undefined,
    reviewer: row.reviewer ?? undefined,
    note: row.note ?? '',
    createdAt: row.created_at,
    decidedAt: row.decided_at ?? undefined,
  });
}

export interface CreateProposalInput {
  projectId: string;
  kind: ProposalKind;
  title: string;
  payload: unknown;
  rationale?: string;
  diff?: Proposal['diff'];
  origin?: OriginShape;
  coverageKind?: CoverageKind;
  note?: string;
}

export function createProposal(input: CreateProposalInput): Proposal {
  const id = newId('prp');
  execute(
    `INSERT INTO proposals
       (id, project_id, kind, state, title, rationale, payload, diff, origin, coverage_kind, note, created_at, source_id, block_id)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.projectId,
      input.kind,
      input.title,
      input.rationale ?? '',
      toJson(input.payload ?? null),
      toJson(input.diff ?? {}),
      toJson(input.origin ?? {}),
      input.coverageKind ?? null,
      input.note ?? '',
      nowIso(),
      input.origin?.sourceId ?? null,
      input.origin?.blockId ?? null,
    ],
  );
  return requireProposal(id);
}

export function getProposal(id: string): Proposal | null {
  const row = queryOne<Row>('SELECT * FROM proposals WHERE id = ?', [id]);
  return row ? rowToProposal(row) : null;
}

export function requireProposal(id: string): Proposal {
  const proposal = getProposal(id);
  if (!proposal) throw new Error(`Пропозицію «${id}» не знайдено`);
  return proposal;
}

export interface ListProposalsOptions {
  projectId: string;
  state?: ProposalState;
  kind?: ProposalKind;
  sourceId?: string;
  blockId?: string;
  page?: number;
  limit?: number;
}

export function listProposals(options: ListProposalsOptions): Page<Proposal> {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 50)));
  const where = ['project_id = ?'];
  const params: unknown[] = [options.projectId];

  if (options.state) {
    where.push('state = ?');
    params.push(options.state);
  }
  if (options.kind) {
    where.push('kind = ?');
    params.push(options.kind);
  }
  if (options.sourceId) {
    where.push('source_id = ?');
    params.push(options.sourceId);
  }
  if (options.blockId) {
    where.push('block_id = ?');
    params.push(options.blockId);
  }
  const clause = where.join(' AND ');

  const total = Number(scalar<number>(`SELECT COUNT(*) FROM proposals WHERE ${clause}`, params) ?? 0);
  const items = query<Row>(
    `SELECT * FROM proposals WHERE ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, (page - 1) * limit],
  ).map(rowToProposal);
  return { items, total, page, limit };
}

export function countPendingProposals(projectId: string): number {
  return Number(
    scalar<number>(`SELECT COUNT(*) FROM proposals WHERE project_id = ? AND state = 'pending'`, [
      projectId,
    ]) ?? 0,
  );
}

export interface PatchProposalInput {
  payload?: unknown;
  title?: string;
  rationale?: string;
  note?: string;
  diff?: Proposal['diff'];
  coverageKind?: CoverageKind;
}

/** Правка пропозиції перед апрувом (інженер редагує формулювання). */
export function patchProposal(id: string, patch: PatchProposalInput): Proposal {
  const existing = requireProposal(id);
  if (existing.state !== 'pending') {
    throw new Error(`Пропозиція вже в стані ${existing.state} — правити можна лише pending`);
  }
  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.payload !== undefined) {
    sets.push('payload = ?');
    params.push(toJson(patch.payload));
  }
  if (patch.title !== undefined) {
    sets.push('title = ?');
    params.push(patch.title);
  }
  if (patch.rationale !== undefined) {
    sets.push('rationale = ?');
    params.push(patch.rationale);
  }
  if (patch.note !== undefined) {
    sets.push('note = ?');
    params.push(patch.note);
  }
  if (patch.diff !== undefined) {
    sets.push('diff = ?');
    params.push(toJson(patch.diff));
  }
  if (patch.coverageKind !== undefined) {
    sets.push('coverage_kind = ?');
    params.push(patch.coverageKind);
  }
  if (sets.length === 0) return existing;

  params.push(id);
  execute(`UPDATE proposals SET ${sets.join(', ')} WHERE id = ?`, params);
  return requireProposal(id);
}

export function deleteProposal(id: string): void {
  requireProposal(id);
  execute('DELETE FROM proposals WHERE id = ?', [id]);
}

export interface ApproveResult {
  approved: string[];
  created: string[];
  updated: string[];
  errors: Array<{ id: string; error: string }>;
}

/**
 * Апрув пачки пропозицій в одній транзакції.
 * `case_create` → кейс + зв'язок покриття; `case_update` → нова ревізія кейса;
 * `bulk_edit` → `BulkRequest` із `dryRun=false`; `locator_update` → прив'язка
 * сценарію + ревізія кейса.
 */
export function approveProposals(ids: readonly string[], reviewer?: string): ApproveResult {
  const result: ApproveResult = { approved: [], created: [], updated: [], errors: [] };
  const at = nowIso();

  tx(() => {
    for (const id of ids) {
      try {
        const proposal = requireProposal(id);
        if (proposal.state !== 'pending') {
          throw new Error(`Пропозиція вже в стані ${proposal.state}`);
        }
        applyProposal(proposal, reviewer, result);
        execute('UPDATE proposals SET state = ?, reviewer = ?, decided_at = ? WHERE id = ?', [
          'approved',
          reviewer ?? 'local',
          at,
          id,
        ]);
        result.approved.push(id);
      } catch (error) {
        result.errors.push({ id, error: error instanceof Error ? error.message : 'невідома помилка' });
      }
    }
  });

  return result;
}

function applyProposal(proposal: Proposal, reviewer: string | undefined, result: ApproveResult): void {
  const author = reviewer ?? 'local';
  const reason = `апрув пропозиції ${proposal.id}`;

  switch (proposal.kind) {
    case 'case_create': {
      const payload = proposal.payload as Record<string, unknown>;
      const input = caseInputSchema.parse(payload);
      const created = createCase(proposal.projectId, input, { author, reason });
      result.created.push(created.id);
      const blockId = proposal.origin?.blockId;
      if (blockId) {
        linkCoverage({
          blockId,
          caseId: created.id,
          kind: proposal.coverageKind ?? 'quote',
          confirmed: true,
          note: proposal.rationale,
        });
      }
      return;
    }

    case 'case_update': {
      const payload = (proposal.payload ?? {}) as { caseId?: string; changes?: CasePatch };
      const caseId = payload.caseId ?? proposal.origin?.caseId;
      if (!caseId) throw new Error('У пропозиції case_update немає caseId');
      requireCase(caseId);
      const changes = payload.changes ?? ({} as CasePatch);
      const updated = updateCase(caseId, changes, { author, reason });
      result.updated.push(updated.id);
      return;
    }

    case 'case_delete': {
      const payload = (proposal.payload ?? {}) as { caseId?: string; hard?: boolean };
      const caseId = payload.caseId ?? proposal.origin?.caseId;
      if (!caseId) throw new Error('У пропозиції case_delete немає caseId');
      deleteCase(caseId, { hard: Boolean(payload.hard) }, { author, reason });
      result.updated.push(caseId);
      return;
    }

    case 'bulk_edit': {
      const request = bulkRequestSchema.parse({
        ...(proposal.payload as Record<string, unknown>),
        projectId: proposal.projectId,
        dryRun: false,
        author,
        reason: proposal.title,
      });
      const bulk = runBulk(request);
      result.updated.push(...bulk.preview.map((row) => row.caseId));
      return;
    }

    case 'locator_update': {
      const payload = (proposal.payload ?? {}) as {
        caseId?: string;
        scenarioPath?: string;
        before?: unknown;
        after?: unknown;
      };
      const caseId = payload.caseId ?? proposal.origin?.caseId;
      if (!caseId) throw new Error('У пропозиції locator_update немає caseId');
      const target = requireCase(caseId);
      if (payload.scenarioPath && payload.scenarioPath !== target.automation.scenarioPath) {
        setAutomation(
          caseId,
          { status: target.automation.status, scenarioPath: payload.scenarioPath },
          { author, reason },
        );
      } else {
        addRevision({
          caseId,
          version: target.version,
          author,
          reason: `${reason}: оновлено кеш локаторів`,
          patch: { locators: { before: payload.before ?? null, after: payload.after ?? null } },
        });
      }
      result.updated.push(caseId);
      return;
    }

    default: {
      const never: never = proposal.kind;
      throw new Error(`Невідомий тип пропозиції: ${String(never)}`);
    }
  }
}

export interface RejectResult {
  rejected: string[];
  errors: Array<{ id: string; error: string }>;
}

export function rejectProposals(
  ids: readonly string[],
  note?: string,
  reviewer?: string,
): RejectResult {
  const result: RejectResult = { rejected: [], errors: [] };
  const at = nowIso();
  tx(() => {
    for (const id of ids) {
      try {
        const proposal = requireProposal(id);
        if (proposal.state !== 'pending') {
          throw new Error(`Пропозиція вже в стані ${proposal.state}`);
        }
        execute(
          'UPDATE proposals SET state = ?, reviewer = ?, note = ?, decided_at = ? WHERE id = ?',
          ['rejected', reviewer ?? 'local', note ?? proposal.note, at, id],
        );
        result.rejected.push(id);
      } catch (error) {
        result.errors.push({ id, error: error instanceof Error ? error.message : 'невідома помилка' });
      }
    }
  });
  return result;
}
