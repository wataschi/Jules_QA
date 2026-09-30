/**
 * Деталі кейса: заголовок, передумови, `checks` із редагуванням по одному
 * елементу (додати / видалити / вгору / вниз), теги, зв'язок із вимогою,
 * вкладки «Історія» і «Автоматизація».
 *
 * Зміни не пишуться на кожне натискання: збираємо чернетку й зберігаємо
 * одним `PATCH /cases/:id` — сервер на кожен PATCH створює ревізію.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Async, ErrorState, Loading } from '../../components/states';
import {
  AutomationChip,
  CaseStatusChip,
  Chip,
  CoverageKindChip,
  ItemStatusChip,
  KindChip,
  PriorityChip,
  SelectField,
  TextArea,
  TextField,
} from '../../components/ui';
import { useToast } from '../../context/AppContext';
import { messageOf, useAsync } from '../../hooks/useAsync';
import {
  S,
  automationStatusLabel,
  caseKindLabel,
  casePriorityLabel,
  caseStatusLabel,
} from '../../strings';
import type { AutomationStatus, CaseDetail, CaseKind, CasePriority, CaseStatus } from '../../types';
import { AUTOMATION_STATUSES, CASE_KINDS, CASE_PRIORITIES, CASE_STATUSES } from '../../types';
import { flakeTone, formatAgo, formatDateTime, formatPercent, parseTags, stringifyValue } from '../../utils/format';

type Tab = 'fields' | 'history' | 'automation';

interface Draft {
  title: string;
  preconditions: string;
  checks: string[];
  tags: string[];
  kind: CaseKind;
  priority: CasePriority;
  status: CaseStatus;
}

function draftOf(item: CaseDetail): Draft {
  return {
    title: item.title,
    preconditions: item.preconditions,
    checks: [...item.checks],
    tags: [...item.tags],
    kind: item.kind,
    priority: item.priority,
    status: item.status,
  };
}

export default function CaseDetailPanel({
  caseId,
  onClose,
  onSaved,
}: {
  caseId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const state = useAsync((signal) => api.getCase(caseId, signal), [caseId], Boolean(caseId));

  return (
    <section className="card case-detail" aria-label={S.cases.detailTitle}>
      <div className="card-head">
        <h2>{S.cases.detailTitle}</h2>
        <span className="spacer" />
        <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label={S.common.close}>
          <span aria-hidden="true">✕</span>
        </button>
      </div>
      {state.loading && state.data === undefined ? (
        <Loading rows={6} />
      ) : state.error && state.data === undefined ? (
        <ErrorState message={state.error} status={state.status} onRetry={state.reload} />
      ) : state.data ? (
        <CaseBody item={state.data} onReload={state.reload} onSaved={onSaved} />
      ) : null}
    </section>
  );
}

function CaseBody({
  item,
  onReload,
  onSaved,
}: {
  item: CaseDetail;
  onReload: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('fields');
  const [draft, setDraft] = useState<Draft>(() => draftOf(item));
  const [tagInput, setTagInput] = useState('');
  const [checkInput, setCheckInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(draftOf(item));
    setError(null);
  }, [item.id, item.version, item]);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(draftOf(item)), [draft, item]);

  function patchDraft(patch: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function moveCheck(index: number, delta: number) {
    setDraft((current) => {
      const next = [...current.checks];
      const target = index + delta;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return { ...current, checks: next };
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.patchCase(item.id, {
        title: draft.title,
        preconditions: draft.preconditions,
        checks: draft.checks,
        tags: draft.tags,
        kind: draft.kind,
        priority: draft.priority,
        status: draft.status,
      });
      toast({ text: S.common.saved, tone: 'good' });
      onReload();
      onSaved();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="card-body" style={{ gap: 'var(--sp-2)', paddingBottom: 0 }}>
        <div className="row-wrap">
          <span className="chip mono accent">{item.id}</span>
          <PriorityChip priority={item.priority} />
          <KindChip kind={item.kind} />
          <CaseStatusChip status={item.status} />
          <AutomationChip status={item.automation.status} reason={item.automation.quarantineReason} />
        </div>
        <p className="muted text-xs">{item.sectionPath}</p>
      </div>

      <div className="tabs" role="tablist" aria-label={S.cases.detailTitle}>
        <button
          type="button"
          className="tab"
          role="tab"
          aria-selected={tab === 'fields'}
          onClick={() => setTab('fields')}
        >
          {S.cases.detailTitle}
        </button>
        <button
          type="button"
          className="tab"
          role="tab"
          aria-selected={tab === 'history'}
          onClick={() => setTab('history')}
        >
          {S.cases.tabHistory}
        </button>
        <button
          type="button"
          className="tab"
          role="tab"
          aria-selected={tab === 'automation'}
          onClick={() => setTab('automation')}
        >
          {S.cases.tabAutomation}
        </button>
      </div>

      {tab === 'fields' && (
        <div className="card-body">
          <TextField label={S.cases.colTitle} value={draft.title} onChange={(next) => patchDraft({ title: next })} />

          <div className="grid grid-2">
            <SelectField
              label={S.cases.colKind}
              value={draft.kind}
              onChange={(next) => patchDraft({ kind: next as CaseKind })}
              options={CASE_KINDS.map((k) => ({ value: k, label: caseKindLabel[k] }))}
            />
            <SelectField
              label={S.cases.colPriority}
              value={draft.priority}
              onChange={(next) => patchDraft({ priority: next as CasePriority })}
              options={CASE_PRIORITIES.map((p) => ({ value: p, label: casePriorityLabel[p] }))}
            />
            <SelectField
              label={S.cases.colStatus}
              value={draft.status}
              onChange={(next) => patchDraft({ status: next as CaseStatus })}
              options={CASE_STATUSES.map((s) => ({ value: s, label: caseStatusLabel[s] }))}
            />
          </div>

          <TextArea
            label={S.cases.preconditions}
            value={draft.preconditions}
            onChange={(next) => patchDraft({ preconditions: next })}
            rows={3}
          />

          {/* ── перевірки: редагування по одному елементу ── */}
          <div>
            <h3 className="muted text-xs" style={{ marginBottom: 'var(--sp-1)' }}>
              {S.cases.checks}
            </h3>
            <ul className="check-list">
              {draft.checks.map((check, index) => (
                <li className="check-item" key={`${index}-${check.slice(0, 12)}`}>
                  <span className="check-num" aria-hidden="true">
                    {index + 1}
                  </span>
                  <label className="visually-hidden" htmlFor={`check-${item.id}-${index}`}>
                    {S.cases.checks} {index + 1}
                  </label>
                  <textarea
                    id={`check-${item.id}-${index}`}
                    className="check-text"
                    rows={2}
                    value={check}
                    onChange={(event) => {
                      const next = [...draft.checks];
                      next[index] = event.target.value;
                      patchDraft({ checks: next });
                    }}
                  />
                  <span className="check-tools">
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon btn-sm"
                      onClick={() => moveCheck(index, -1)}
                      disabled={index === 0}
                      aria-label={S.cases.checkUp}
                      title={S.cases.checkUp}
                    >
                      <span aria-hidden="true">↑</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon btn-sm"
                      onClick={() => moveCheck(index, 1)}
                      disabled={index === draft.checks.length - 1}
                      aria-label={S.cases.checkDown}
                      title={S.cases.checkDown}
                    >
                      <span aria-hidden="true">↓</span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon btn-sm"
                      onClick={() => patchDraft({ checks: draft.checks.filter((_, i) => i !== index) })}
                      aria-label={S.cases.checkDelete}
                      title={S.cases.checkDelete}
                    >
                      <span aria-hidden="true">✕</span>
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            <div className="row" style={{ marginTop: 'var(--sp-2)' }}>
              <label className="visually-hidden" htmlFor={`new-check-${item.id}`}>
                {S.cases.checksNew}
              </label>
              <input
                id={`new-check-${item.id}`}
                type="text"
                value={checkInput}
                placeholder={S.cases.checksNew}
                onChange={(event) => setCheckInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && checkInput.trim()) {
                    event.preventDefault();
                    patchDraft({ checks: [...draft.checks, checkInput.trim()] });
                    setCheckInput('');
                  }
                }}
              />
              <button
                type="button"
                className="btn btn-sm"
                disabled={!checkInput.trim()}
                onClick={() => {
                  patchDraft({ checks: [...draft.checks, checkInput.trim()] });
                  setCheckInput('');
                }}
              >
                {S.cases.checksAdd}
              </button>
            </div>
          </div>

          {/* ── теги ── */}
          <div>
            <h3 className="muted text-xs" style={{ marginBottom: 'var(--sp-1)' }}>
              {S.cases.tags}
            </h3>
            <div className="row-wrap">
              {draft.tags.map((tag) => (
                <span className="tag" key={tag}>
                  {tag}
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon btn-sm"
                    onClick={() => patchDraft({ tags: draft.tags.filter((t) => t !== tag) })}
                    aria-label={`${S.common.remove}: ${tag}`}
                  >
                    <span aria-hidden="true">✕</span>
                  </button>
                </span>
              ))}
            </div>
            <div className="row" style={{ marginTop: 'var(--sp-2)' }}>
              <label className="visually-hidden" htmlFor={`new-tag-${item.id}`}>
                {S.cases.tagNew}
              </label>
              <input
                id={`new-tag-${item.id}`}
                type="text"
                className="input-mono"
                value={tagInput}
                placeholder={S.cases.tagNew}
                onChange={(event) => setTagInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    const tags = parseTags(tagInput);
                    if (tags.length) patchDraft({ tags: Array.from(new Set([...draft.tags, ...tags])) });
                    setTagInput('');
                  }
                }}
              />
              <button
                type="button"
                className="btn btn-sm"
                disabled={!tagInput.trim()}
                onClick={() => {
                  const tags = parseTags(tagInput);
                  if (tags.length) patchDraft({ tags: Array.from(new Set([...draft.tags, ...tags])) });
                  setTagInput('');
                }}
              >
                {S.common.add}
              </button>
            </div>
          </div>

          {/* ── зв'язок із вимогою ── */}
          <div>
            <h3 className="muted text-xs" style={{ marginBottom: 'var(--sp-1)' }}>
              {S.cases.requirement}
            </h3>
            {item.coverage.quote + item.coverage.derived === 0 ? (
              <p className="muted text-sm">{S.coverage.gap}</p>
            ) : (
              <div className="row-wrap">
                {item.coverage.quote > 0 && (
                  <span className="row">
                    <CoverageKindChip kind="quote" />
                    <span className="mono text-xs">{item.coverage.quote}</span>
                  </span>
                )}
                {item.coverage.derived > 0 && (
                  <span className="row">
                    <CoverageKindChip kind="derived" />
                    <span className="mono text-xs">{item.coverage.derived}</span>
                  </span>
                )}
              </div>
            )}
            <Link className="text-sm" to={`/coverage?case=${encodeURIComponent(item.id)}`}>
              {S.dashboard.goCoverage} →
            </Link>
          </div>

          <dl className="kv">
            <dt>{S.cases.version}</dt>
            <dd className="mono">{item.version}</dd>
            <dt>{S.cases.owner}</dt>
            <dd>{item.owner ?? S.common.none}</dd>
            <dt>{S.cases.updated}</dt>
            <dd title={formatDateTime(item.updatedAt)}>
              {formatAgo(item.updatedAt)} · {item.updatedBy ?? S.common.unknown}
            </dd>
            <dt>{S.cases.created}</dt>
            <dd>{formatDateTime(item.createdAt)}</dd>
          </dl>

          {error && <div className="alert bad">{error}</div>}

          <div className="row">
            {dirty && <span className="chip warn">{S.cases.unsaved}</span>}
            <span className="spacer" />
            <button type="button" className="btn btn-sm" onClick={() => setDraft(draftOf(item))} disabled={!dirty}>
              {S.common.reset}
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={!dirty || saving}>
              {S.cases.saveCase}
            </button>
          </div>
        </div>
      )}

      {tab === 'history' && <HistoryTab caseId={item.id} />}
      {tab === 'automation' && <AutomationTab item={item} onReload={onReload} />}
    </>
  );
}

/* ────────────────────────────── історія ──────────────────────────────── */

function HistoryTab({ caseId }: { caseId: string }) {
  const state = useAsync((signal) => api.getCaseHistory(caseId, signal), [caseId]);

  return (
    <div className="card-body">
      <Async
        state={state}
        skeletonRows={4}
        empty={{ title: S.empty.history, hint: S.empty.historyHint }}
      >
        {(data) => (
          <>
            <h3 className="muted text-xs">{S.cases.revisions}</h3>
            {data.revisions.length === 0 ? (
              <p className="muted text-sm">{S.empty.history}</p>
            ) : (
              <ul className="col" style={{ listStyle: 'none', padding: 0, gap: 'var(--sp-2)' }}>
                {data.revisions.map((revision) => (
                  <li key={revision.id} className="card" style={{ boxShadow: 'none' }}>
                    <div className="card-body" style={{ padding: 'var(--sp-2)', gap: 'var(--sp-1)' }}>
                      <div className="row-wrap text-xs">
                        <span className="chip mono">v{revision.version}</span>
                        <span className="muted">{formatDateTime(revision.at)}</span>
                        <span className="muted">{revision.author}</span>
                      </div>
                      {revision.reason && <p className="text-sm">{revision.reason}</p>}
                      {Object.keys(revision.patch).length > 0 && (
                        <div className="diff">
                          {Object.entries(revision.patch).map(([field, change]) => (
                            <div className="diff-row" key={field}>
                              <span className="diff-cell diff-key">{field}</span>
                              <span className="diff-cell diff-before">{stringifyValue(change.before)}</span>
                              <span className="diff-cell diff-after">{stringifyValue(change.after)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <h3 className="muted text-xs">{S.cases.results}</h3>
            {data.results.length === 0 ? (
              <p className="muted text-sm">{S.empty.runs}</p>
            ) : (
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th scope="col">{S.nav.runs}</th>
                      <th scope="col">{S.cases.colStatus}</th>
                      <th scope="col">{S.cases.updated}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.results.map((result) => (
                      <tr key={result.id}>
                        <td className="cell-id">
                          <Link to={`/runs/${encodeURIComponent(result.runId)}`}>{result.runId}</Link>
                        </td>
                        <td>
                          <ItemStatusChip status={result.status} />
                        </td>
                        <td className="nowrap text-xs">{formatDateTime(result.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Async>
    </div>
  );
}

/* ──────────────────────────── автоматизація ──────────────────────────── */

function AutomationTab({ item, onReload }: { item: CaseDetail; onReload: () => void }) {
  const toast = useToast();
  const scenarios = useAsync((signal) => api.legacyListScenarios(signal), []);
  const [status, setStatus] = useState<AutomationStatus>(item.automation.status);
  const [scenarioPath, setScenarioPath] = useState(item.automation.scenarioPath ?? '');
  const [reason, setReason] = useState(item.automation.quarantineReason ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.setAutomation(item.id, {
        status,
        scenarioPath: scenarioPath || undefined,
        quarantineReason: status === 'quarantined' ? reason || undefined : undefined,
      });
      toast({ text: S.common.saved, tone: 'good' });
      onReload();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  const options = (scenarios.data ?? []).map((scenario) => ({
    value: scenario.path,
    label: `${scenario.name} — ${scenario.path}`,
  }));

  return (
    <div className="card-body">
      <SelectField
        label={S.cases.colAutomation}
        value={status}
        onChange={(next) => setStatus(next as AutomationStatus)}
        options={AUTOMATION_STATUSES.map((value) => ({ value, label: automationStatusLabel[value] }))}
      />

      {scenarios.error ? (
        <TextField label={S.cases.scenario} value={scenarioPath} onChange={setScenarioPath} mono />
      ) : (
        <SelectField
          label={S.cases.scenario}
          value={scenarioPath}
          onChange={setScenarioPath}
          options={options}
          allLabel={S.cases.scenarioNone}
        />
      )}

      {status === 'quarantined' && (
        <TextField label={S.cases.quarantineReason} value={reason} onChange={setReason} />
      )}

      <dl className="kv">
        <dt>{S.cases.lastAutoRun}</dt>
        <dd>
          {item.automation.lastAutoRunId ? (
            <span className="row-wrap">
              <span className="mono text-xs">{item.automation.lastAutoRunId}</span>
              {item.automation.lastAutoStatus && (
                <Chip tone={item.automation.lastAutoStatus === 'passed' ? 'good' : 'bad'}>
                  {item.automation.lastAutoStatus}
                </Chip>
              )}
              <span className="muted text-xs">{formatAgo(item.automation.lastAutoAt)}</span>
            </span>
          ) : (
            S.runs.engineNoRun
          )}
        </dd>
        <dt>{S.dashboard.flakeScore}</dt>
        <dd>
          {item.automation.flakeScore === undefined ? (
            S.common.none
          ) : (
            <Chip tone={flakeTone(item.automation.flakeScore)} mono>
              {formatPercent(item.automation.flakeScore)}
            </Chip>
          )}
        </dd>
        {item.automation.quarantineReason && (
          <>
            <dt>{S.cases.quarantine}</dt>
            <dd>{item.automation.quarantineReason}</dd>
          </>
        )}
      </dl>

      {error && <div className="alert bad">{error}</div>}

      <div className="row">
        <span className="spacer" />
        <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={busy}>
          {S.cases.automationSave}
        </button>
      </div>
    </div>
  );
}
