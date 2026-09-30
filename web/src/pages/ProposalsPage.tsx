/**
 * Черга апрувів. Головна вимога екрана: завжди видно, де цитата вимоги,
 * а де домисел AI — це різні кольори рамки, різні блоки й окремий чип.
 *
 * Дії: затвердити вибрані, відхилити вибрані (з причиною), правити перед
 * апрувом (інлайн-редактор заголовка й перевірок → `PATCH /proposals/:id`).
 */

import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Dialog } from '../components/Dialog';
import { Async } from '../components/states';
import { Chip, CoverageKindChip, Pager, PageHead, ProposalStateChip, SelectField, TextArea } from '../components/ui';
import { useApp, useToast } from '../context/AppContext';
import { messageOf, useResource } from '../hooks/useAsync';
import { useKeyMap } from '../hooks/useKeyboard';
import { useQueryParams } from '../hooks/useQueryParams';
import { S, proposalKindLabel, skillNameLabel, proposalStateLabel } from '../strings';
import type { Proposal, ProposalKind, ProposalState } from '../types';
import { PROPOSAL_KINDS, PROPOSAL_STATES } from '../types';
import { formatAgo, formatDateTime, linesToArray, stringifyValue } from '../utils/format';

const LIMIT = 25;

export default function ProposalsPage() {
  const { projectId } = useApp();
  const toast = useToast();
  const params = useQueryParams();

  const state = params.getOr('state', 'pending');
  const kind = params.get('kind');
  const page = params.getNum('page', 1);

  const listState = useResource(
    (signal) =>
      api.listProposals(
        {
          projectId,
          state: (state || undefined) as ProposalState | undefined,
          kind: (kind || undefined) as ProposalKind | undefined,
          page,
          limit: LIMIT,
        },
        signal,
      ),
    [projectId, state, kind, page],
    { enabled: Boolean(projectId), pollMs: 45_000 },
  );

  const items = listState.data?.items ?? [];
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rejecting, setRejecting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const selectedIds = useMemo(() => Array.from(selected), [selected]);

  const toggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  useKeyMap({
    Escape: () => {
      setRejecting(false);
      setConfirming(false);
    },
  });

  async function approve() {
    if (selectedIds.length === 0) return;
    setConfirming(false);
    setBusy(true);
    try {
      const result = await api.approveProposals(selectedIds);
      const errors = result.errors?.length ?? 0;
      toast({
        text:
          S.proposals.approvedToast(result.approved) +
          (errors ? ` · ${S.proposals.partialErrors(errors)}` : ''),
        tone: errors ? 'warn' : 'good',
      });
      setSelected(new Set());
      listState.reload();
    } catch (cause) {
      toast({ text: messageOf(cause), tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }

  /*
   * Погодження створює кейси в реєстрі, і відкотити це нічим — `undo` є лише
   * для масових правок. Одну пропозицію погоджуємо одразу, пачку — тільки
   * після явного підтвердження, де видно, що саме зʼявиться в реєстрі.
   */
  function requestApprove(): void {
    if (selectedIds.length === 0) return;
    if (selectedIds.length === 1) void approve();
    else setConfirming(true);
  }

  async function reject(note: string) {
    setBusy(true);
    try {
      const result = await api.rejectProposals(selectedIds, note || undefined);
      toast({ text: S.proposals.rejectedToast(result.rejected ?? selectedIds.length), tone: 'good' });
      setSelected(new Set());
      setRejecting(false);
      listState.reload();
    } catch (cause) {
      toast({ text: messageOf(cause), tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHead title={S.proposals.title} sub={S.proposals.sub} />

      <section className="card">
        <div className="filters">
          <SelectField
            label={S.proposals.filterState}
            value={state}
            onChange={(next) => params.set({ state: next || null, page: null })}
            options={PROPOSAL_STATES.map((value) => ({ value, label: proposalStateLabel[value] }))}
            allLabel={S.common.all}
          />
          <SelectField
            label={S.proposals.filterKind}
            value={kind}
            onChange={(next) => params.set({ kind: next || null, page: null })}
            options={PROPOSAL_KINDS.map((value) => ({ value, label: proposalKindLabel[value] }))}
            allLabel={S.common.all}
          />
          <span className="spacer" />
          <div className="row-wrap">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setSelected(new Set(items.map((item) => item.id)))}
              disabled={items.length === 0}
            >
              {S.common.selectAll}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={requestApprove}
              disabled={selectedIds.length === 0 || busy}
            >
              {S.proposals.approveSelected} ({selectedIds.length})
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => setRejecting(true)}
              disabled={selectedIds.length === 0 || busy}
            >
              {S.proposals.rejectSelected}
            </button>
          </div>
        </div>

        <Async
          state={listState}
          skeletonRows={6}
          empty={{
            title: S.empty.proposals,
            hint: S.empty.proposalsHint,
            action: (
              <Link className="btn btn-sm" to="/coverage">
                {S.dashboard.goCoverage}
              </Link>
            ),
          }}
        >
          {(data) => (
            <>
              <div className="card-body">
                {data.items.map((proposal) => (
                  <ProposalCard
                    key={proposal.id}
                    proposal={proposal}
                    checked={selected.has(proposal.id)}
                    onToggle={() => toggle(proposal.id)}
                    onChanged={listState.reload}
                  />
                ))}
              </div>
              <Pager
                page={data.page || page}
                limit={data.limit || LIMIT}
                total={data.total}
                onPage={(next) => params.set({ page: next === 1 ? null : next })}
              />
            </>
          )}
        </Async>
      </section>

      {rejecting && (
        <RejectDialog count={selectedIds.length} busy={busy} onClose={() => setRejecting(false)} onReject={reject} />
      )}
      {confirming && (
        <ApproveDialog
          proposals={items.filter((item) => selected.has(item.id))}
          busy={busy}
          onClose={() => setConfirming(false)}
          onApprove={() => void approve()}
        />
      )}
    </>
  );
}

/* ────────────────────── підтвердження погодження ──────────────────────── */

function ApproveDialog({
  proposals,
  busy,
  onClose,
  onApprove,
}: {
  proposals: Proposal[];
  busy: boolean;
  onClose: () => void;
  onApprove: () => void;
}) {
  // Показуємо розклад за типами: «12 нових кейсів і 3 оновлення» зрозуміліше,
  // ніж «15 пропозицій».
  const byKind = new Map<ProposalKind, number>();
  for (const proposal of proposals) {
    byKind.set(proposal.kind, (byKind.get(proposal.kind) ?? 0) + 1);
  }

  return (
    <Dialog
      title={S.proposals.confirmTitle}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button type="button" className="btn btn-sm" onClick={onClose} disabled={busy}>
            {S.common.cancel}
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={onApprove} disabled={busy}>
            {S.proposals.confirmApprove(proposals.length)}
          </button>
        </>
      }
    >
      <p className="text-sm">{S.proposals.confirmBody}</p>
      <ul className="plain-list text-sm">
        {Array.from(byKind).map(([kind, count]) => (
          <li key={kind}>
            {proposalKindLabel[kind]}: <strong>{count}</strong>
          </li>
        ))}
      </ul>
      <p className="muted text-xs">{S.proposals.confirmHint}</p>
    </Dialog>
  );
}

/* ─────────────────────────── картка пропозиції ───────────────────────── */

function ProposalCard({
  proposal,
  checked,
  onToggle,
  onChanged,
}: {
  proposal: Proposal;
  checked: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [showDiff, setShowDiff] = useState(false);
  const [editing, setEditing] = useState(false);
  const derived = proposal.coverageKind === 'derived';

  const payload = (proposal.payload ?? {}) as Record<string, unknown>;
  const payloadChecks = Array.isArray(payload.checks) ? (payload.checks as string[]) : [];
  const [title, setTitle] = useState(String(payload.title ?? proposal.title));
  const [checksText, setChecksText] = useState(payloadChecks.join('\n'));
  const [busy, setBusy] = useState(false);

  async function saveEdit() {
    setBusy(true);
    try {
      await api.patchProposal(proposal.id, {
        payload: { ...payload, title, checks: linesToArray(checksText) },
      });
      toast({ text: S.proposals.editedToast, tone: 'good' });
      setEditing(false);
      onChanged();
    } catch (cause) {
      toast({ text: messageOf(cause), tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={`proposal ${derived ? 'derived' : 'quote'}`}>
      <div className="proposal-head">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          aria-label={`${S.common.selectRow}: ${proposal.title}`}
          style={{ marginTop: 4 }}
        />
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <div className="proposal-title">{proposal.title}</div>
          <div className="proposal-meta">
            <Chip tone="neutral">{proposalKindLabel[proposal.kind]}</Chip>
            <ProposalStateChip state={proposal.state} />
            {proposal.coverageKind && <CoverageKindChip kind={proposal.coverageKind} />}
            {proposal.origin.skill && (
              <span className="tag">
                {S.proposals.originSkill}: {skillNameLabel[proposal.origin.skill]}
              </span>
            )}
            {proposal.origin.caseId && (
              <Link className="tag" to={`/cases?case=${encodeURIComponent(proposal.origin.caseId)}`}>
                {proposal.origin.caseId}
              </Link>
            )}
            {proposal.origin.runId && (
              <Link className="tag" to={`/runs/${encodeURIComponent(proposal.origin.runId)}`}>
                {S.proposals.originRun}
              </Link>
            )}
            <span className="muted text-xs" title={formatDateTime(proposal.createdAt)}>
              {formatAgo(proposal.createdAt)}
            </span>
          </div>
        </div>
      </div>

      <div style={{ padding: '0 var(--sp-3) var(--sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
        {/* ── звідки взялося: цитата чи домисел ── */}
        {proposal.blockText ? (
          derived ? (
            <div className="derived-box">
              <strong>{S.proposals.originDerived}</strong>
              <p className="text-sm" style={{ marginTop: 4 }}>
                {S.proposals.originBlock}: {proposal.blockHeading ?? proposal.origin.blockId} — «{proposal.blockText}»
              </p>
            </div>
          ) : (
            <div className="quote-box">
              <strong>{S.proposals.originQuote}</strong>
              <p className="text-sm" style={{ marginTop: 4 }}>
                {proposal.blockHeading ? `${proposal.blockHeading}: ` : ''}«{proposal.blockText}»
              </p>
            </div>
          )
        ) : (
          <div className={derived ? 'derived-box' : 'quote-box'}>
            <strong>{derived ? S.proposals.originDerived : S.proposals.originQuote}</strong>
            {proposal.origin.blockId && (
              <p className="text-xs mono" style={{ marginTop: 4 }}>
                {S.proposals.originBlock}: {proposal.origin.blockId}
              </p>
            )}
          </div>
        )}

        {proposal.rationale && (
          <div className="rationale">
            <span className="muted text-xs">{S.proposals.rationale}: </span>
            {proposal.rationale}
          </div>
        )}

        {editing ? (
          <>
            <div className="field">
              <label htmlFor={`edit-title-${proposal.id}`}>{S.proposals.editTitle}</label>
              <input
                id={`edit-title-${proposal.id}`}
                type="text"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <TextArea
              label={S.proposals.editChecks}
              value={checksText}
              onChange={setChecksText}
              rows={Math.max(4, checksText.split('\n').length + 1)}
            />
            <div className="row">
              <span className="spacer" />
              <button type="button" className="btn btn-sm" onClick={() => setEditing(false)}>
                {S.proposals.cancelEdit}
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={saveEdit} disabled={busy}>
                {S.proposals.saveEdit}
              </button>
            </div>
          </>
        ) : (
          <>
            {payloadChecks.length > 0 && (
              <ol className="text-sm" style={{ margin: 0 }}>
                {payloadChecks.map((check, index) => (
                  <li key={index}>{check}</li>
                ))}
              </ol>
            )}
            <div className="row-wrap">
              <button type="button" className="btn btn-sm" onClick={() => setShowDiff((open) => !open)}>
                {showDiff ? S.proposals.hideDiff : S.proposals.showDiff}
              </button>
              {(proposal.kind === 'case_create' || proposal.kind === 'case_update') && (
                <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
                  {S.proposals.editBefore}
                </button>
              )}
            </div>
          </>
        )}

        {showDiff && (
          <>
            {Object.keys(proposal.diff).length > 0 ? (
              <div className="diff">
                {Object.entries(proposal.diff).map(([field, change]) => (
                  <div className="diff-row" key={field}>
                    <span className="diff-cell diff-key">{field}</span>
                    <span className="diff-cell diff-before">{stringifyValue(change.before)}</span>
                    <span className="diff-cell diff-after">{stringifyValue(change.after)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <>
                <h3 className="muted text-xs">{S.proposals.payloadRaw}</h3>
                <pre className="logs">{stringifyValue(proposal.payload)}</pre>
              </>
            )}
          </>
        )}

        {proposal.note && <p className="muted text-sm">{proposal.note}</p>}
      </div>
    </article>
  );
}

function RejectDialog({
  count,
  busy,
  onClose,
  onReject,
}: {
  count: number;
  busy: boolean;
  onClose: () => void;
  onReject: (note: string) => void;
}) {
  const [note, setNote] = useState('');
  return (
    <Dialog
      title={S.proposals.rejectSelected}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {S.common.cancel}
          </button>
          <button type="button" className="btn btn-danger" onClick={() => onReject(note)} disabled={busy}>
            {S.proposals.rejectSelected} ({count})
          </button>
        </>
      }
    >
      <TextArea
        label={S.proposals.rejectNote}
        value={note}
        onChange={setNote}
        placeholder={S.proposals.rejectNotePlaceholder}
        rows={3}
      />
    </Dialog>
  );
}
