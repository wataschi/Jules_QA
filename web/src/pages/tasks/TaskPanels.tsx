/**
 * Блоки сторінки задачі, що лише показують: опис агента («що перевіряє»),
 * стрічка подій і журнал робіт агента.
 */
import { Link } from 'react-router-dom';
import { Chip } from '../../components/ui';
import type { AgentJob, Task, TaskEvent } from '../../types';
import { formatAgo, formatDateTime } from '../../utils/format';
import { T } from './strings';

/* ─────────────────────────── що каже агент ─────────────────────────── */

export function ReportCard({ task }: { task: Task }) {
  const report = task.report;
  const prUrl = report?.prUrl ?? task.prUrl;
  const branch = report?.branch ?? task.branch;
  const isReading = task.kind === 'read_asset';

  return (
    <section className="card" aria-labelledby="task-report-title">
      <div className="card-head">
        <h2 id="task-report-title">{T.report.title}</h2>
        <span className="spacer" />
        {prUrl && (
          <a className="btn btn-sm" href={prUrl} target="_blank" rel="noreferrer">
            {task.prNumber ? T.report.prNumber(task.prNumber) : T.report.pr} ↗
          </a>
        )}
      </div>
      <div className="card-body">
        {!report ? (
          <p className="muted text-sm">{T.report.none}</p>
        ) : (
          <>
            {report.summary && (
              <div>
                <h3 className="tasks-label">{isReading ? T.report.reading : T.report.summary}</h3>
                <p className="pre-wrap text-sm">{report.summary}</p>
              </div>
            )}

            {!isReading && (
              <div className="tasks-checks" data-testid="task-checks">
                <h3 className="tasks-checks-title">{T.report.checks}</h3>
                <p className="text-xs muted">{T.report.checksHint}</p>
                {report.checks.length ? (
                  <ol className="tasks-checks-list">
                    {report.checks.map((check, index) => (
                      <li key={index}>{check}</li>
                    ))}
                  </ol>
                ) : (
                  <p className="alert warn">{T.report.noChecks}</p>
                )}
              </div>
            )}

            {report.tests.length > 0 && (
              <div>
                <h3 className="tasks-label">{T.report.tests}</h3>
                <ul className="tasks-tests">
                  {report.tests.map((test, index) => (
                    <li key={`${test.file}-${index}`}>
                      <span className="text-sm">{test.name}</span>
                      <span className="mono text-xs muted">{test.file}</span>
                      {test.caseIds.length > 0 && (
                        <span className="row-wrap">
                          {test.caseIds.map((caseId) => (
                            <Link key={caseId} className="mono text-xs" to={`/cases?case=${encodeURIComponent(caseId)}`}>
                              {caseId}
                            </Link>
                          ))}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}

        {(prUrl || branch) && (
          <dl className="kv">
            {prUrl && (
              <>
                <dt>{T.detail.pr}</dt>
                <dd>
                  <a href={prUrl} target="_blank" rel="noreferrer">
                    {prUrl}
                  </a>
                </dd>
              </>
            )}
            {branch && (
              <>
                <dt>{T.report.branch}</dt>
                <dd className="mono text-xs">{branch}</dd>
              </>
            )}
          </dl>
        )}
      </div>
    </section>
  );
}

/* ─────────────────────────── стрічка подій ─────────────────────────── */

const ACTOR_GLYPH: Record<TaskEvent['authorKind'], string> = {
  agent: 'AI',
  qa: 'QA',
  system: 'J',
  dev: 'Dev',
};

export function TimelineCard({ events }: { events: TaskEvent[] }) {
  return (
    <section className="card" aria-labelledby="task-events-title">
      <div className="card-head">
        <h2 id="task-events-title">{T.events.title}</h2>
      </div>
      <div className="card-body">
        {events.length === 0 ? (
          <p className="muted text-sm">{T.events.empty}</p>
        ) : (
          <ol className="tasks-timeline">
            {events.map((event) => (
              <li key={event.id} className={`tev tev-${event.authorKind} tev-${event.type}`}>
                <span className="tev-badge" aria-hidden="true">
                  {ACTOR_GLYPH[event.authorKind]}
                </span>
                <div className="tev-main">
                  <div className="tev-head">
                    <span className="tev-type">{T.events.type[event.type]}</span>
                    <span className="text-xs muted">
                      {T.events.actor[event.authorKind]} · {event.author}
                    </span>
                    <span className="spacer" />
                    <time className="text-xs muted nowrap" dateTime={event.at} title={formatDateTime(event.at)}>
                      {formatAgo(event.at)}
                    </time>
                  </div>
                  {event.text && <p className="tev-text pre-wrap">{event.text}</p>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

/* ─────────────────────────── журнал робіт ─────────────────────────── */

function givenSummary(given: AgentJob['given']): string {
  if (!given.length) return T.jobs.givenNone;
  const blocks = given.filter((item) => item.kind === 'block').length;
  const assets = given.filter((item) => item.kind === 'asset').length;
  const other = given.length - blocks - assets;
  return [blocks && T.jobs.givenBlocks(blocks), assets && T.jobs.givenAssets(assets), other && T.jobs.givenOther(other)]
    .filter(Boolean)
    .join(', ');
}

export function JobsCard({ jobs }: { jobs: AgentJob[] }) {
  return (
    <section className="card" aria-labelledby="task-jobs-title">
      <div className="card-head">
        <h2 id="task-jobs-title">{T.jobs.title}</h2>
      </div>
      <div className="card-body">
        {jobs.length === 0 ? (
          <p className="muted text-sm">{T.jobs.empty}</p>
        ) : (
          <ul className="tasks-jobs">
            {jobs.map((job) => (
              <li key={job.id} className="tasks-job">
                <div className="row-wrap">
                  <strong className="text-sm">{job.agent ?? job.holder}</strong>
                  {job.model && <Chip mono>{job.model}</Chip>}
                  <span className="spacer" />
                  <Chip tone={job.outcome === 'reported' ? 'good' : job.outcome === 'failed' ? 'bad' : job.outcome ? 'neutral' : 'accent'}>
                    {job.outcome ? (T.jobs.outcomes[job.outcome] ?? job.outcome) : T.jobs.running}
                  </Chip>
                </div>
                <dl className="kv">
                  <dt>{T.jobs.agent}</dt>
                  <dd className="text-xs">{job.holder}</dd>
                  <dt>{T.jobs.when}</dt>
                  <dd className="text-xs">
                    {formatDateTime(job.startedAt)}
                    {job.finishedAt ? ` → ${formatDateTime(job.finishedAt)}` : ''}
                  </dd>
                  <dt>{T.jobs.given}</dt>
                  <dd className="text-xs" title={job.given.map((item) => `${item.kind}:${item.id}`).join('\n')}>
                    {givenSummary(job.given)}
                  </dd>
                  {(job.prUrl || job.branch) && (
                    <>
                      <dt>{T.detail.pr}</dt>
                      <dd className="text-xs">
                        {job.prUrl ? (
                          <a href={job.prUrl} target="_blank" rel="noreferrer">
                            {job.prUrl}
                          </a>
                        ) : (
                          <span className="mono">{job.branch}</span>
                        )}
                      </dd>
                    </>
                  )}
                </dl>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
