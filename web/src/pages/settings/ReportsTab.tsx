/**
 * Вкладка «Звіти»: тижневий звіт (перегляд і публікація в Jira з висновками),
 * журнал сповіщень із перевіркою Telegram і перегляд QA_STATUS.md.
 * Вибраний тиждень живе в адресі (`week=2026-W41`).
 */

import { useState } from 'react';
import { api } from '../../api';
import { Async, ErrorState, Loading } from '../../components/states';
import { Chip, SelectField, TextArea } from '../../components/ui';
import { useApp, useToast } from '../../context/AppContext';
import { messageOf, useAsync } from '../../hooks/useAsync';
import { useQueryParams } from '../../hooks/useQueryParams';
import { formatAgo, formatDateTime } from '../../utils/format';
import { Markdown } from './Markdown';
import { SS } from './strings';

/** ISO-тиждень, як на сервері (`src/reporting/weekly-report.ts`). */
export function isoWeekLabel(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const year = day.getUTCFullYear();
  const week = Math.ceil(((day.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function recentWeeks(count = 10): string[] {
  const now = Date.now();
  const weeks: string[] = [];
  for (let back = 1; back <= count; back += 1) weeks.push(isoWeekLabel(new Date(now - back * 7 * 86_400_000)));
  return weeks;
}

export function ReportsTab() {
  return (
    <>
      <WeeklyCard />
      <NotificationsCard />
      <StatusCard />
    </>
  );
}

/* ─────────────────────────── тижневий звіт ───────────────────────────── */

function WeeklyCard() {
  const { projectId } = useApp();
  const toast = useToast();
  const params = useQueryParams();
  const weekParam = params.get('week');
  const week = /^\d{4}-W\d{2}$/.test(weekParam) ? weekParam : '';
  const state = useAsync((signal) => api.getWeekly(projectId, week || undefined, signal), [projectId, week], Boolean(projectId));
  const [insights, setInsights] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ week: string; text: string; url?: string; tone: 'good' | 'warn' } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const weeks = recentWeeks();
  const shown = state.data?.week ?? (week || weeks[0]);
  const options = (weeks.includes(shown) ? weeks : [shown, ...weeks]).map((value) => ({
    value,
    label: value === weeks[0] ? SS.weekLast(value) : value,
  }));

  async function publish() {
    const target = state.data?.week ?? (week || undefined);
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await api.publishWeekly(projectId, { week: target, insights: insights.trim() || undefined });
      if (response.jira) {
        setResult({ week: response.week, text: SS.publishedOk(response.jira.key, response.jira.created), url: response.jira.url, tone: 'good' });
        toast({ text: SS.publishedOk(response.jira.key, response.jira.created), tone: 'good' });
        if (state.data) state.setData({ ...state.data, published: { key: response.jira.key, url: response.jira.url } });
      } else {
        setResult({ week: response.week, text: SS.publishedNoJira, tone: 'warn' });
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="weekly-title">
      <div className="card-head">
        <h2 id="weekly-title">{SS.weekly}</h2>
        <span className="muted text-xs">{SS.weeklySub}</span>
        <span className="spacer" />
        {state.data &&
          (state.data.published ? (
            state.data.published.url ? (
              <a href={state.data.published.url} target="_blank" rel="noreferrer">
                <Chip tone="good" mono>
                  {SS.published(state.data.published.key)}
                </Chip>
              </a>
            ) : (
              <Chip tone="good" mono>
                {SS.published(state.data.published.key)}
              </Chip>
            ))
          : (
            <Chip tone="neutral">{SS.notPublished}</Chip>
          ))}
      </div>
      <div className="card-body">
        <div className="weekly-pick">
          <SelectField
            label={SS.week}
            value={shown}
            options={options}
            onChange={(next) => {
              setResult(null);
              params.set({ week: next === weeks[0] ? null : next });
            }}
          />
        </div>
        <Async state={state} skeletonRows={6}>
          {(weekly) => (
            <div className="weekly-preview">
              <p className="text-sm">
                <strong>{weekly.summary}</strong> <span className="muted text-xs mono">· {weekly.label}</span>
              </p>
              <Markdown source={weekly.markdown} />
            </div>
          )}
        </Async>
        <form
          className="weekly-publish"
          onSubmit={(event) => {
            event.preventDefault();
            void publish();
          }}
        >
          <TextArea label={SS.insights} value={insights} onChange={setInsights} hint={SS.insightsHint} rows={4} />
          {error && <div className="alert bad" role="alert">{error}</div>}
          {result && (
            <div className={`alert ${result.tone}`} role="status">
              {result.url ? (
                <a href={result.url} target="_blank" rel="noreferrer">
                  {result.text}
                </a>
              ) : (
                result.text
              )}
            </div>
          )}
          <div className="row">
            <span className="spacer" />
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !state.data}>
              {busy ? SS.publishing : SS.publish}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

/* ─────────────────────────────── сповіщення ──────────────────────────── */

function NotificationsCard() {
  const toast = useToast();
  const state = useAsync((signal) => api.listNotifications(signal), []);
  const [busy, setBusy] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);

  async function sendTest() {
    setBusy(true);
    setTestError(null);
    try {
      await api.testNotification();
      toast({ text: SS.testSent, tone: 'good' });
      state.reload();
    } catch (cause) {
      setTestError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="notifications-title">
      <div className="card-head">
        <h2 id="notifications-title">{SS.notifications}</h2>
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={sendTest} disabled={busy}>
          {SS.testSend}
        </button>
      </div>
      {(testError || (state.data && !state.data.configured)) && (
        <div className="card-body">
          {state.data && !state.data.configured && <div className="alert warn">{SS.notificationsOff}</div>}
          {testError && (
            <div className="alert bad" role="alert">
              {testError}
            </div>
          )}
        </div>
      )}
      {state.loading && !state.data ? (
        <div className="card-body">
          <Loading rows={3} />
        </div>
      ) : state.error && !state.data ? (
        <ErrorState message={state.error} status={state.status} onRetry={state.reload} />
      ) : state.data && state.data.items.length === 0 ? (
        <div className="card-body">
          <p className="muted text-sm">{SS.notificationsEmpty}</p>
        </div>
      ) : state.data ? (
        <div className="table-wrap">
          <table className="tbl tbl-narrow">
            <thead>
              <tr>
                <th scope="col">{SS.colKind}</th>
                <th scope="col">{SS.colAt}</th>
                <th scope="col">{SS.colSent}</th>
              </tr>
            </thead>
            <tbody>
              {state.data.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <span title={item.dedupKey}>{SS.notifyKinds[item.kind] ?? item.kind}</span>
                  </td>
                  <td className="nowrap text-xs muted" title={formatDateTime(item.createdAt)}>
                    {formatAgo(item.createdAt)}
                  </td>
                  <td>
                    {item.error ? (
                      <Chip tone="bad" title={item.error}>
                        {SS.failed}
                      </Chip>
                    ) : item.sentAt ? (
                      <Chip tone="good" title={formatDateTime(item.sentAt)}>
                        {SS.sent}
                      </Chip>
                    ) : (
                      <Chip tone="neutral">{SS.queued}</Chip>
                    )}
                    {item.error && <span className="muted text-xs"> {item.error}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

/* ─────────────────────────────── QA_STATUS.md ────────────────────────── */

function StatusCard() {
  const { projectId } = useApp();
  const state = useAsync((signal) => api.getStatusMarkdown(projectId, signal), [projectId], Boolean(projectId));
  return (
    <section className="card" aria-labelledby="status-title">
      <div className="card-head">
        <h2 id="status-title" className="mono">
          {SS.status}
        </h2>
        <span className="muted text-xs">{SS.statusSub}</span>
      </div>
      <div className="card-body">
        <Async state={state} skeletonRows={6}>
          {(text) =>
            text.trim() ? (
              <pre className="logs status-md" tabIndex={0} aria-label={SS.status}>
                {text}
              </pre>
            ) : (
              <p className="muted text-sm">{SS.statusEmpty}</p>
            )
          }
        </Async>
      </div>
    </section>
  );
}
