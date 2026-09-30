/**
 * Деталі прогону — режим проходження чек-листа.
 *
 * Клавіатура: `1` пройдено, `2` впало, `3` заблоковано, `4` пропущено,
 * `Enter`/`j` далі, `k` назад. На `failed` відкривається коментар і чернетка
 * дефекту. Для кейсів з автопрогоном вбудований перегляд логів рушія (SSE).
 *
 * Список кейсів оновлюється опитуванням, логи — лише через SSE. Опитування
 * зупиняється, поки є незбережена чернетка, щоб не затирати введене.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import EngineLogs from '../components/EngineLogs';
import { Empty, ErrorState, Loading } from '../components/states';
import {
  Chip,
  ItemStatusChip,
  KindChip,
  PageHead,
  PriorityChip,
  RunStateChip,
  SelectField,
  SummaryBar,
  Tabs,
  TextField,
} from '../components/ui';
import { useToast } from '../context/AppContext';
import { messageOf, useResource } from '../hooks/useAsync';
import { useQueryParams } from '../hooks/useQueryParams';
import AutoRunResult from './runs/AutoRunResult';
import { clampIndex, useKeyMap } from '../hooks/useKeyboard';
import { S, defectSeverityLabel, itemStatusLabel, runKindLabel } from '../strings';
import type { DefectSeverity, ItemStatus } from '../types';
import { DEFECT_SEVERITIES } from '../types';
import { formatDateTime, formatPercent } from '../utils/format';

const STATUS_KEYS: Array<{ key: string; status: ItemStatus }> = [
  { key: '1', status: 'passed' },
  { key: '2', status: 'failed' },
  { key: '3', status: 'blocked' },
  { key: '4', status: 'skipped' },
];

interface Draft {
  caseId: string;
  comment: string;
  defectTitle: string;
  defectSeverity: DefectSeverity;
  createDefect: boolean;
}

export default function RunDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const toast = useToast();
  const navigate = useNavigate();
  const params = useQueryParams();

  const [cursor, setCursor] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [logsFor, setLogsFor] = useState<string | null>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);

  const dirty = Boolean(draft && (draft.comment || draft.defectTitle));

  const state = useResource((signal) => api.getRun(id, signal), [id], {
    enabled: Boolean(id),
    // Поки є незбережена чернетка — не оновлюємо, щоб не зникло введене.
    pollMs: dirty ? 0 : 15_000,
  });

  const run = state.data;
  const items = run?.items ?? [];
  const current = items[cursor];

  // Чернетка живе для одного кейса; при переході на інший — нова.
  useEffect(() => {
    if (!current) return;
    setDraft((previous) =>
      previous && previous.caseId === current.caseId
        ? previous
        : {
            caseId: current.caseId,
            comment: current.comment ?? '',
            defectTitle: '',
            defectSeverity: 'medium',
            createDefect: false,
          },
    );
  }, [current]);

  const setStatus = useCallback(
    async (status: ItemStatus) => {
      if (!run || !current) return;
      setBusy(true);
      try {
        await api.setRunItem(run.id, current.caseId, {
          status,
          comment: draft?.caseId === current.caseId ? draft.comment : current.comment,
        });
        state.reload();
        if (status === 'failed') {
          window.setTimeout(() => commentRef.current?.focus(), 0);
        } else {
          setCursor((c) => clampIndex(c + 1, items.length));
        }
      } catch (cause) {
        toast({ text: messageOf(cause), tone: 'bad' });
      } finally {
        setBusy(false);
      }
    },
    [run, current, draft, items.length, state, toast],
  );

  async function saveDraft() {
    if (!run || !current || !draft) return;
    setBusy(true);
    try {
      await api.setRunItem(run.id, current.caseId, {
        status: current.status === 'untested' ? 'failed' : current.status,
        comment: draft.comment,
        defect:
          draft.createDefect && draft.defectTitle
            ? { title: draft.defectTitle, severity: draft.defectSeverity }
            : undefined,
      });
      toast({ text: S.runs.itemSavedToast, tone: 'good' });
      setDraft({ ...draft, defectTitle: '', createDefect: false });
      state.reload();
    } catch (cause) {
      toast({ text: messageOf(cause), tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }

  async function complete() {
    if (!run) return;
    setBusy(true);
    try {
      await api.patchRun(run.id, { state: 'completed' });
      toast({ text: S.runs.completedToast, tone: 'good' });
      state.reload();
    } catch (cause) {
      toast({ text: messageOf(cause), tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }

  async function rerunFailed() {
    if (!run) return;
    setBusy(true);
    try {
      const created = await api.rerunFailed(run.id);
      toast({
        text: `${S.runs.rerunToast}: ${created.title}`,
        tone: 'good',
      });
      // Одразу відкриваємо новий прогін: раніше про нього лише повідомляли,
      // і його доводилось шукати руками в списку.
      navigate(`/runs/${encodeURIComponent(created.id)}`);
    } catch (cause) {
      toast({ text: messageOf(cause), tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }

  async function runAuto() {
    if (!run) return;
    const automated = items.filter((item) => item.case.automation.status === 'automated');
    if (automated.length === 0) {
      toast({ text: S.runs.noAutomated, tone: 'warn' });
      return;
    }
    setBusy(true);
    try {
      const result = await api.startAuto(
        run.id,
        automated.map((item) => item.caseId),
      );
      toast({ text: S.runs.autoStartedToast(result.queued ?? automated.length), tone: 'good' });
      state.reload();
    } catch (cause) {
      toast({ text: messageOf(cause), tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }

  useKeyMap({
    '1': () => void setStatus('passed'),
    '2': () => void setStatus('failed'),
    '3': () => void setStatus('blocked'),
    '4': () => void setStatus('skipped'),
    j: () => setCursor((c) => clampIndex(c + 1, items.length)),
    k: () => setCursor((c) => clampIndex(c - 1, items.length)),
    Enter: () => setCursor((c) => clampIndex(c + 1, items.length)),
    Escape: () => setLogsFor(null),
  });

  const progress = useMemo(() => {
    if (!run) return { done: 0, total: 0, pct: 0 };
    const total = run.summary.total || items.length;
    const done = total - run.summary.untested;
    return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
  }, [run, items.length]);

  if (state.loading && !run) return <Loading rows={8} />;
  if (state.error && !run) {
    return (
      <>
        <PageHead title={S.runs.title} />
        <ErrorState message={state.error} status={state.status} onRetry={state.reload} />
        <Link className="btn btn-sm" to="/runs">
          ← {S.nav.runs}
        </Link>
      </>
    );
  }
  if (!run) return <Loading rows={8} />;

  /*
   * Автоматичному прогону чек-лист із клавішами «1..4» не потрібен: людина
   * нічого не проставляє руками, їй треба бачити, що зробив рушій. Ручному —
   * навпаки. Тому вид за замовчуванням залежить від типу прогону, але
   * перемкнути можна завжди: у змішаному прогоні потрібні обидва.
   */
  const defaultView = run.kind === 'auto' ? 'results' : 'checklist';
  const requestedView = params.getOr('view', defaultView);
  const view = requestedView === 'results' || requestedView === 'checklist' ? requestedView : defaultView;
  const hasAuto = items.some((item) => item.autoRunId);

  return (
    <>
      <PageHead
        title={run.title}
        sub={[
          runKindLabel[run.kind],
          // Тільки закріплена адреса справді описує, куди пішов прогін.
          run.env.baseUrlPinned && run.env.baseUrl ? run.env.baseUrl : S.runs.targetsFromScenarios,
          run.env.label,
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={
          <>
            <Link className="btn btn-sm btn-ghost" to="/runs">
              ← {S.nav.runs}
            </Link>
            {/* Завершений прогін не приймає нових результатів: інакше рушій
                дописував би їх у закриту історію. */}
            <button
              type="button"
              className="btn btn-sm"
              onClick={runAuto}
              disabled={busy || run.state !== 'open'}
              title={run.state === 'open' ? undefined : S.runs.closedHint}
            >
              {S.runs.runAuto}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={rerunFailed}
              disabled={busy || run.summary.failed + run.summary.blocked === 0}
            >
              {S.runs.rerunFailed}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={complete}
              disabled={busy || run.state !== 'open'}
            >
              {S.runs.complete}
            </button>
          </>
        }
      />

      <div className="card">
        <div className="card-body" style={{ gap: 'var(--sp-2)' }}>
          <div className="row-wrap">
            <RunStateChip state={run.state} />
            <Chip tone="neutral" mono>
              {progress.done} / {progress.total}
            </Chip>
            <Chip tone="good">
              {itemStatusLabel.passed}: {run.summary.passed}
            </Chip>
            <Chip tone="bad">
              {itemStatusLabel.failed}: {run.summary.failed}
            </Chip>
            <Chip tone="warn">
              {itemStatusLabel.blocked}: {run.summary.blocked}
            </Chip>
            <Chip tone="neutral">
              {itemStatusLabel.skipped}: {run.summary.skipped}
            </Chip>
            <span className="spacer" />
            <span className="mono text-xs muted">{formatPercent(progress.total ? progress.done / progress.total : null)}</span>
          </div>
          <SummaryBar summary={run.summary} />
          {/* Для суто автоматичного прогону ручні клавіші — шум. */}
          {run.kind !== 'auto' && <p className="muted text-xs">{S.runs.keyboardHint}</p>}
          <dl className="kv">
            <dt>{S.runs.started}</dt>
            <dd>{formatDateTime(run.startedAt)}</dd>
            {run.finishedAt && (
              <>
                <dt>{S.runs.finished}</dt>
                <dd>{formatDateTime(run.finishedAt)}</dd>
              </>
            )}
            <dt>{S.runs.executor}</dt>
            <dd>{run.executor ?? S.common.none}</dd>
          </dl>
        </div>
      </div>

      {items.length > 0 && hasAuto && (
        <Tabs
          tabs={[
            { value: 'checklist', label: S.autoRun.tabChecklist },
            { value: 'results', label: S.autoRun.tabResults },
          ]}
          active={view}
          label={S.runs.title}
          onPick={(next) => params.set({ view: next === defaultView ? null : next })}
        />
      )}

      {items.length === 0 ? (
        <div className="card">
          <Empty title={S.empty.runItems} hint={S.empty.runItemsHint} />
        </div>
      ) : view === 'results' ? (
        <section className="card" aria-label={S.autoRun.tabResults}>
          <div className="card-body flush">
            {items.map((item) => (
              <div key={item.id} className="run-item">
                <div className="run-item-head">
                  <span className="mono text-xs">{item.caseId}</span>
                  <span className="run-item-title">{item.case.title}</span>
                  <span className="spacer" />
                  <ItemStatusChip status={item.status} />
                </div>
                {item.autoRunId ? (
                  <>
                    <AutoRunResult engineRunId={item.autoRunId} />
                    {item.defectId && (
                      <Link className="chip bad" to={`/defects?case=${encodeURIComponent(item.caseId)}`}>
                        {S.runs.defectLink}
                      </Link>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setLogsFor(logsFor === item.autoRunId ? null : item.autoRunId!)}
                    >
                      {S.runs.engineLogs}
                    </button>
                    {logsFor === item.autoRunId && <EngineLogs legacyRunId={item.autoRunId} />}
                  </>
                ) : (
                  <p className="muted text-sm">{S.autoRun.noAuto}</p>
                )}
              </div>
            ))}
          </div>
        </section>
      ) : (
        <div className="runner">
          {/* ── чек-лист ── */}
          <section className="card" aria-label={S.runs.checklist}>
            <div className="card-head">
              <h2>{S.runs.checklist}</h2>
              <span className="spacer" />
              <span className="muted text-xs">
                {S.runs.cursorHint}: {cursor + 1} / {items.length}
              </span>
            </div>
            <div className="card-body flush">
              {items.map((item, index) => (
                <div
                  key={item.id}
                  className={`run-item${index === cursor ? ' cursor' : ''}`}
                  onClick={() => setCursor(index)}
                >
                  <div className="run-item-head">
                    <span className="mono text-xs">{item.caseId}</span>
                    <span className="run-item-title">{item.case.title}</span>
                    <span className="spacer" />
                    <PriorityChip priority={item.case.priority} />
                    <KindChip kind={item.case.kind} />
                    <ItemStatusChip status={item.status} />
                  </div>

                  {index === cursor && (
                    <>
                      {item.case.preconditions && (
                        <p className="text-sm muted">
                          <strong>{S.cases.preconditions}: </strong>
                          {item.case.preconditions}
                        </p>
                      )}
                      {item.case.checks.length > 0 && (
                        <ol className="text-sm" style={{ margin: 0 }}>
                          {item.case.checks.map((check, i) => (
                            <li key={i}>{check}</li>
                          ))}
                        </ol>
                      )}
                      <div className="status-picker">
                        {STATUS_KEYS.map(({ key, status }) => (
                          <button
                            type="button"
                            key={status}
                            className={`status-btn ${status}${item.status === status ? ' on' : ''}`}
                            onClick={() => void setStatus(status)}
                            disabled={busy}
                          >
                            <span className="status-key" aria-hidden="true">
                              {key}
                            </span>
                            {itemStatusLabel[status]}
                          </button>
                        ))}
                        <span className="spacer" />
                        {item.autoRunId && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => setLogsFor(logsFor === item.autoRunId ? null : item.autoRunId!)}
                          >
                            {S.runs.engineLogs}
                          </button>
                        )}
                      </div>
                      {item.comment && <p className="text-sm">{item.comment}</p>}
                      {item.defectId && (
                        /* Раніше тут висів голий ідентифікатор, з якого не було
                           куди піти. Тепер це вхід на екран дефектів. */
                        <Link className="chip bad" to={`/defects?case=${encodeURIComponent(item.caseId)}`}>
                          {S.runs.defectLink}
                        </Link>
                      )}
                      {item.autoRunId && logsFor === item.autoRunId && (
                        <EngineLogs legacyRunId={item.autoRunId} />
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* ── бічна панель поточного кейса ── */}
          <section className="card" aria-label={S.runs.commentLabel}>
            <div className="card-head">
              <h2>{current?.caseId ?? S.common.none}</h2>
            </div>
            <div className="card-body">
              {current ? (
                <>
                  <p className="text-sm">{current.case.title}</p>
                  <p className="muted text-xs">{current.case.sectionPath}</p>
                  <div className="row-wrap">
                    <ItemStatusChip status={current.status} />
                    {current.case.automation.status === 'automated' && (
                      <Chip tone="good">{S.runs.autoRun}</Chip>
                    )}
                  </div>

                  {/* Коментар лишаємо «сирим», щоб після натискання «2» фокус ставився саме тут. */}
                  <div className="field">
                    <label htmlFor="run-comment">{S.runs.commentLabel}</label>
                    <textarea
                      id="run-comment"
                      ref={commentRef}
                      rows={3}
                      value={draft?.comment ?? ''}
                      placeholder={S.runs.commentPlaceholder}
                      onChange={(event) =>
                        setDraft((d) => (d ? { ...d, comment: event.target.value } : d))
                      }
                    />
                  </div>

                  {(current.status === 'failed' || draft?.createDefect) && (
                    <>
                      <h3 className="muted text-xs">{S.runs.defectTitle}</h3>
                      <TextField
                        label={S.runs.defectTitleLabel}
                        value={draft?.defectTitle ?? ''}
                        onChange={(next) =>
                          setDraft((d) => (d ? { ...d, defectTitle: next, createDefect: true } : d))
                        }
                      />
                      <SelectField
                        label={S.runs.defectSeverity}
                        value={draft?.defectSeverity ?? 'medium'}
                        onChange={(next) =>
                          setDraft((d) => (d ? { ...d, defectSeverity: next as DefectSeverity } : d))
                        }
                        options={DEFECT_SEVERITIES.map((value) => ({
                          value,
                          label: defectSeverityLabel[value],
                        }))}
                      />
                    </>
                  )}

                  <button type="button" className="btn btn-primary btn-sm" onClick={saveDraft} disabled={busy}>
                    {S.runs.saveItem}
                  </button>

                  <Link className="text-sm" to={`/cases?case=${encodeURIComponent(current.caseId)}`}>
                    {S.cases.detailTitle} →
                  </Link>
                </>
              ) : (
                <p className="muted text-sm">{S.cases.detailPickHint}</p>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
