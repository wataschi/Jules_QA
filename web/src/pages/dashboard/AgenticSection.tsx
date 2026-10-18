/**
 * «Цикл із агентами» на огляді: що чекає рішення QA, трасування від вимоги до
 * тесту, тести в коді, останній прогін на main, коміти повз PR, якість роботи
 * агентів за моделями і стан зовнішніх систем.
 *
 * Джерела: `GET /dashboard/agentic` (зведення) і `GET /push-checks` (коміти
 * повз PR, з дією «Бачив»). Зведення вантажиться окремо від старих KPI: якщо
 * його немає (старий сервер), решта огляду працює як раніше.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { ErrorState, Loading } from '../../components/states';
import { BarRow, Chip, SummaryBar } from '../../components/ui';
import { useApp, useToast } from '../../context/AppContext';
import { messageOf, useAsync, useResource } from '../../hooks/useAsync';
import { S2 } from '../../strings-v2';
import type { AgenticSummary, HealthCheck, PushCheck, TaskState } from '../../types';
import { formatAgo, formatDateTime } from '../../utils/format';
import { SD, formatSinceClock } from './strings';
import '../../styles/dashboard-v2.css';

const STATE_ORDER: TaskState[] = ['review', 'needs_info', 'new', 'queued', 'claimed', 'failed', 'done', 'rejected'];
const LEVELS = ['unit', 'integration', 'e2e', 'visual'];

/** Адреса екрана задач із фільтром за станами (повторюваний параметр `state`). */
export function tasksLink(states: TaskState[], extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  for (const state of states) params.append('state', state);
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return `/tasks?${params.toString()}`;
}

export function AgenticSection() {
  const { projectId, project } = useApp();
  const summary = useResource((signal) => api.getAgenticSummary(projectId, signal), [projectId], {
    enabled: Boolean(projectId),
    pollMs: 30_000,
  });
  const pushes = useAsync((signal) => api.listPushChecks(projectId, signal), [projectId], Boolean(projectId));
  const thresholds = {
    staleTaskHours: project?.settings?.thresholds?.staleTaskHours ?? 24,
    mutationP1: project?.settings?.thresholds?.mutationP1 ?? 60,
  };

  return (
    <section className="card agentic" aria-labelledby="agentic-title">
      <div className="card-head">
        <h2 id="agentic-title">{SD.title}</h2>
        <span className="muted text-xs">{SD.sub}</span>
        <span className="spacer" />
        {summary.data && <HealthChips checks={summary.data.health} />}
      </div>
      <div className="card-body">
        {summary.loading && !summary.data ? (
          <Loading rows={6} />
        ) : summary.error && !summary.data ? (
          <ErrorState message={`${SD.loadError}: ${summary.error}`} status={summary.status} onRetry={summary.reload} compact />
        ) : summary.data ? (
          <AgenticBody
            data={summary.data}
            pushes={pushes.data}
            pushesError={pushes.error}
            onPushesRetry={pushes.reload}
            onAcknowledged={(id) => {
              pushes.setData((pushes.data ?? []).filter((item) => item.id !== id));
              summary.reload();
            }}
            thresholds={thresholds}
          />
        ) : null}
      </div>
    </section>
  );
}

function AgenticBody({
  data,
  pushes,
  pushesError,
  onPushesRetry,
  onAcknowledged,
  thresholds,
}: {
  data: AgenticSummary;
  pushes: PushCheck[] | undefined;
  pushesError: string | null;
  onPushesRetry: () => void;
  onAcknowledged: (id: string) => void;
  thresholds: { staleTaskHours: number; mutationP1: number };
}) {
  const { tasks, traceability, tests, main } = data;
  const review = tasks.byState.review ?? 0;
  const needsInfo = tasks.byState.needs_info ?? 0;
  const decide = review + needsInfo;
  const directCount = pushes ? pushes.length : data.directPushes;
  const totalTasks = STATE_ORDER.reduce((sum, state) => sum + (tasks.byState[state] ?? 0), 0);

  return (
    <>
      {/* ── що чекає людей ── */}
      <div className="agentic-top">
        <Link
          to={tasksLink(['review', 'needs_info'])}
          className={`agentic-hero${decide > 0 ? ' attention' : ''}`}
          aria-label={`${SD.decide}: ${decide}`}
        >
          <span className="agentic-hero-label">{SD.decide}</span>
          <span className="agentic-hero-value">{decide}</span>
          <span className="agentic-hero-note">{decide > 0 ? SD.decideNote(review, needsInfo) : SD.decideNone}</span>
          <span className="agentic-hero-cta">{SD.decideGo} →</span>
        </Link>

        <div className="kpi">
          <span className="kpi-label">{SD.stale(thresholds.staleTaskHours)}</span>
          <span className="kpi-value">
            <Chip tone={tasks.stale > 0 ? 'warn' : 'good'} mono>
              {tasks.stale}
            </Chip>
          </span>
          {tasks.oldest.length > 0 ? (
            <ul className="agentic-oldest" aria-label={SD.oldest}>
              {tasks.oldest.slice(0, 3).map((item) => (
                <li key={item.id}>
                  <Link to={`/tasks/${encodeURIComponent(item.id)}`} className="truncate" title={item.title}>
                    {item.title}
                  </Link>
                  <span className="mono text-xs muted nowrap">{SD.ageHours(item.ageHours)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <span className="kpi-note">{SD.staleNone}</span>
          )}
          {tasks.stale > 0 && (
            <Link className="kpi-note" to={tasksLink(['queued'], { sort: 'age' })}>
              {SD.staleGo} →
            </Link>
          )}
        </div>

        <div className="kpi">
          <span className="kpi-label">{SD.questions}</span>
          <span className="kpi-value">
            <Chip tone={tasks.questions > 0 ? 'warn' : 'neutral'} mono>
              {tasks.questions}
            </Chip>
          </span>
          <span className="kpi-note">{SD.questionsNote}</span>
          {tasks.questions > 0 && (
            <Link className="kpi-note" to="/tasks?kind=question">
              {SD.questionsGo} →
            </Link>
          )}
        </div>

        <div className="kpi">
          <span className="kpi-label">{SD.pushes}</span>
          <span className="kpi-value">
            <Chip tone={directCount > 0 ? 'bad' : 'good'} mono>
              {directCount}
            </Chip>
          </span>
          <span className="kpi-note">{SD.pushesNote}</span>
        </div>
      </div>

      <div className="grid grid-2">
        {/* ── задачі за станами ── */}
        <div className="agentic-panel">
          <h3>{SD.byState}</h3>
          {totalTasks === 0 ? (
            <p className="muted text-sm">{SD.byStateEmpty}</p>
          ) : (
            <div className="bar-list">
              {STATE_ORDER.map((state) => (
                <LinkBarRow
                  key={state}
                  to={tasksLink([state])}
                  label={S2.taskState[state]}
                  value={tasks.byState[state] ?? 0}
                  max={totalTasks}
                  tone={
                    state === 'review' || state === 'needs_info'
                      ? 'warn'
                      : state === 'failed'
                        ? 'bad'
                        : state === 'done'
                          ? 'good'
                          : undefined
                  }
                />
              ))}
            </div>
          )}
        </div>

        {/* ── трасування ── */}
        <div className="agentic-panel">
          <h3>
            {SD.trace} <span className="muted text-xs">· {SD.traceSub}</span>
          </h3>
          {traceability.blocks + traceability.frames + traceability.approvedCases === 0 ? (
            <p className="muted text-sm">{SD.traceEmpty}</p>
          ) : (
            <div className="bar-list">
              <FunnelRow to="/coverage" label={SD.traceBlocks} part={traceability.blocksWithCases} total={traceability.blocks} />
              <FunnelRow to="/coverage" label={SD.traceFrames} part={traceability.framesWithCases} total={traceability.frames} />
              <FunnelRow
                to="/cases?status=approved"
                label={SD.traceCases}
                part={traceability.casesWithTests}
                total={traceability.approvedCases}
              />
            </div>
          )}
          <div className="row-wrap">
            <Link to="/cases?priority=P1&status=approved" className="agentic-flag">
              <Chip tone={traceability.p1WithoutTests > 0 ? 'bad' : 'good'} mono>
                {traceability.p1WithoutTests}
              </Chip>
              <span>{SD.p1NoTests}</span>
            </Link>
            <Link to="/inputs?reading=pending" className="agentic-flag">
              <Chip tone={traceability.readingsPending > 0 ? 'warn' : 'good'} mono>
                {traceability.readingsPending}
              </Chip>
              <span>{SD.readings}</span>
            </Link>
          </div>
        </div>

        {/* ── тести в коді ── */}
        <div className="agentic-panel">
          <h3>
            {SD.tests} <span className="muted text-xs">· {SD.testsTotal(tests.total)}</span>
          </h3>
          {tests.total === 0 ? (
            <p className="muted text-sm">{SD.testsEmpty}</p>
          ) : (
            <>
              <div className="bar-list">
                {[...LEVELS, ...Object.keys(tests.byLevel).filter((level) => !LEVELS.includes(level))].map((level) => (
                  <BarRow key={level} label={SD.level[level] ?? level} value={tests.byLevel[level] ?? 0} max={tests.total} />
                ))}
              </div>
              <dl className="agentic-stats">
                <div>
                  <dt>{SD.withoutCase}</dt>
                  <dd>
                    <Chip tone={tests.withoutCase > 0 ? 'warn' : 'good'} mono>
                      {tests.withoutCase}
                    </Chip>
                  </dd>
                </div>
                <div>
                  <dt>{SD.byAgent}</dt>
                  <dd>
                    <Chip tone="neutral" mono>
                      {tests.byAgent}
                    </Chip>
                  </dd>
                </div>
                <div>
                  <dt>{SD.quarantined}</dt>
                  <dd>
                    <Chip tone={tests.quarantined > 0 ? 'warn' : 'good'} mono>
                      {tests.quarantined}
                    </Chip>
                  </dd>
                </div>
              </dl>
            </>
          )}
        </div>

        {/* ── останній прогін на main ── */}
        <div className="agentic-panel">
          <h3>{SD.main}</h3>
          {!main ? (
            <p className="muted text-sm">{SD.mainNone}</p>
          ) : (
            <>
              <div className="row-wrap">
                <span className="muted text-xs">{SD.mainCommit}</span>
                {main.runUrl ? (
                  <a href={main.runUrl} target="_blank" rel="noreferrer" className="mono text-sm" title={SD.mainOpen}>
                    {main.sha.slice(0, 7)}
                  </a>
                ) : (
                  <span className="mono text-sm">{main.sha.slice(0, 7)}</span>
                )}
                <span className="muted text-xs" title={formatDateTime(main.startedAt)}>
                  {formatAgo(main.startedAt)}
                </span>
                <span className="spacer" />
                <Chip tone={main.failed > 0 ? 'bad' : 'good'}>{SD.mainFailed(main.failed, main.total)}</Chip>
              </div>
              <SummaryBar
                summary={{ total: main.total, passed: Math.max(0, main.total - main.failed), failed: main.failed, blocked: 0, skipped: 0 }}
              />
              <div className="row-wrap">
                <span className="muted text-xs">{SD.mainMutation}</span>
                {main.mutationScore === null ? (
                  <Chip tone="neutral">{SD.mainMutationNone}</Chip>
                ) : (
                  <Chip tone={main.mutationScore >= thresholds.mutationP1 ? 'good' : 'warn'} mono>
                    {main.mutationScore}%
                  </Chip>
                )}
                <span className="muted text-xs">{SD.mainMutationHint(thresholds.mutationP1)}</span>
              </div>
            </>
          )}
        </div>

        {/* ── коміти повз PR ── */}
        <div className="agentic-panel">
          <h3>{SD.direct}</h3>
          <p className="muted text-xs">{SD.directSub}</p>
          <DirectPushes items={pushes} error={pushesError} onRetry={onPushesRetry} onAcknowledged={onAcknowledged} />
        </div>

        {/* ── якість роботи агентів ── */}
        <div className="agentic-panel">
          <h3>
            {SD.acceptance} <span className="muted text-xs">· {SD.acceptanceSub}</span>
          </h3>
          {tasks.acceptance.length === 0 ? (
            <p className="muted text-sm">{SD.acceptanceEmpty}</p>
          ) : (
            <div className="bar-list">
              {tasks.acceptance.map((row) => (
                <FunnelRow key={row.model} label={row.model} part={row.firstTime} total={row.reported} mono />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/* ───────────────────────────── частини ───────────────────────────────── */

/** Як BarRow, але підпис — посилання на екран із фільтром. */
function LinkBarRow({
  to,
  label,
  value,
  max,
  tone,
}: {
  to: string;
  label: string;
  value: number;
  max: number;
  tone?: 'good' | 'warn' | 'bad';
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="bar-row">
      <Link to={to} className="truncate">
        {label}
      </Link>
      <span className="bar-track" aria-hidden="true">
        <span className={`bar-fill${tone ? ` ${tone}` : ''}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="bar-num">{value}</span>
    </div>
  );
}

/** Рядок воронки: «скільки з скількох» і частка. */
function FunnelRow({
  to,
  label,
  part,
  total,
  mono,
}: {
  to?: string;
  label: string;
  part: number;
  total: number;
  mono?: boolean;
}) {
  const share = total > 0 ? part / total : null;
  const pct = share === null ? 0 : Math.round(share * 100);
  const tone = share === null ? undefined : share >= 0.9 ? 'good' : share >= 0.6 ? 'warn' : 'bad';
  const text = <span className={`truncate${mono ? ' mono text-xs' : ''}`}>{label}</span>;
  return (
    <div className="bar-row funnel-row" title={`${label}: ${part} / ${total}`}>
      {to ? (
        <Link to={to} className="truncate">
          {label}
        </Link>
      ) : (
        text
      )}
      <span className="bar-track" aria-hidden="true">
        <span className={`bar-fill${tone ? ` ${tone}` : ''}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="bar-num nowrap">
        {SD.traceOf(part, total)} · {share === null ? '—' : `${pct}%`}
      </span>
    </div>
  );
}

function DirectPushes({
  items,
  error,
  onRetry,
  onAcknowledged,
}: {
  items: PushCheck[] | undefined;
  error: string | null;
  onRetry: () => void;
  onAcknowledged: (id: string) => void;
}) {
  const { projectId } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  if (!items && error) return <ErrorState message={error} onRetry={onRetry} compact />;
  if (!items) return <Loading rows={2} />;
  if (items.length === 0) return <p className="muted text-sm">{SD.directEmpty}</p>;

  async function acknowledge(item: PushCheck) {
    setBusy(item.id);
    try {
      await api.acknowledgePush(projectId, item.id);
      toast({ text: SD.directAcked, tone: 'good' });
      onAcknowledged(item.id);
    } catch (cause) {
      toast({ text: messageOf(cause), tone: 'bad' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <ul className="plain-list push-list">
      {items.map((item) => (
        <li key={item.id} className="push-item">
          <span className="mono text-sm">{item.sha.slice(0, 7)}</span>
          <span className="muted text-xs truncate">
            {item.branch}
            {item.author ? ` · ${SD.directBy(item.author)}` : ''} ·{' '}
            <span title={formatDateTime(item.createdAt)}>{formatAgo(item.createdAt)}</span>
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => acknowledge(item)}
            disabled={busy === item.id}
            aria-label={SD.directAckLabel(item.sha.slice(0, 7))}
          >
            {SD.directAck}
          </button>
        </li>
      ))}
    </ul>
  );
}

function HealthChips({ checks }: { checks: HealthCheck[] }) {
  if (checks.length === 0) {
    return (
      <Link to="/settings?tab=integrations" className="health-chips" aria-label={SD.healthGo}>
        <Chip tone="neutral">{SD.healthNone}</Chip>
      </Link>
    );
  }
  return (
    <Link to="/settings?tab=integrations" className="health-chips" title={SD.healthGo}>
      {checks.map((check) => {
        const name = SD.targets[check.target] ?? check.target;
        return (
          <Chip
            key={check.target}
            tone={check.ok ? 'good' : 'bad'}
            title={
              check.ok
                ? `${name}: ${SD.healthOk} з ${formatDateTime(check.since)}`
                : `${name}: ${check.error ?? ''} · з ${formatDateTime(check.since)}`
            }
          >
            {name} · {check.ok ? SD.healthOk : SD.healthDown(formatSinceClock(check.since))}
          </Chip>
        );
      })}
    </Link>
  );
}
