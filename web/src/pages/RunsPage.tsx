/** Список прогонів — ручні й автоматичні в одній історії, з фільтрами в адресі. */

import { Link } from 'react-router-dom';
import { api } from '../api';
import { Async } from '../components/states';
import { Chip, Pager, PageHead, RunStateChip, SelectField, SummaryBar } from '../components/ui';
import { useApp } from '../context/AppContext';
import { useResource } from '../hooks/useAsync';
import { useQueryParams } from '../hooks/useQueryParams';
import { S, runKindLabel, runStateLabel } from '../strings';
import type { RunKind, RunState } from '../types';
import { RUN_KINDS, RUN_STATES } from '../types';
import { formatAgo, formatDateTime, formatPercent } from '../utils/format';

const LIMIT = 25;

export default function RunsPage() {
  const { projectId } = useApp();
  const params = useQueryParams();

  const kind = params.get('kind');
  const state = params.get('state');
  const page = params.getNum('page', 1);

  const listState = useResource(
    (signal) =>
      api.listRuns(
        {
          projectId,
          kind: (kind || undefined) as RunKind | undefined,
          state: (state || undefined) as RunState | undefined,
          page,
          limit: LIMIT,
        },
        signal,
      ),
    [projectId, kind, state, page],
    { enabled: Boolean(projectId), pollMs: 20_000 },
  );

  return (
    <>
      <PageHead
        title={S.runs.title}
        sub={S.runs.sub}
        actions={
          <Link className="btn btn-primary btn-sm" to="/cases">
            {S.cases.bulkCreateRun}
          </Link>
        }
      />

      <section className="card">
        <div className="filters">
          <SelectField
            label={S.runs.filterKind}
            value={kind}
            onChange={(next) => params.set({ kind: next || null, page: null })}
            options={RUN_KINDS.map((value) => ({ value, label: runKindLabel[value] }))}
            allLabel={S.common.all}
          />
          <SelectField
            label={S.runs.filterState}
            value={state}
            onChange={(next) => params.set({ state: next || null, page: null })}
            options={RUN_STATES.map((value) => ({ value, label: runStateLabel[value] }))}
            allLabel={S.common.all}
          />
        </div>

        <Async
          state={listState}
          skeletonRows={6}
          empty={{
            title: S.empty.runs,
            hint: S.empty.runsHint,
            action: (
              <Link className="btn btn-sm" to="/cases">
                {S.dashboard.goCases}
              </Link>
            ),
          }}
        >
          {(data) => (
            <>
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th scope="col">{S.runs.colTitle}</th>
                      <th scope="col">{S.runs.colKind}</th>
                      <th scope="col">{S.runs.colState}</th>
                      <th scope="col">{S.runs.colProgress}</th>
                      <th scope="col">{S.runs.colSummary}</th>
                      <th scope="col">{S.runs.colStarted}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((run) => {
                      const done = run.summary.total - run.summary.untested;
                      const passRate = done > 0 ? run.summary.passed / done : null;
                      return (
                        <tr key={run.id}>
                          <td>
                            <Link to={`/runs/${encodeURIComponent(run.id)}`}>{run.title}</Link>
                            {run.env.label && <span className="tag" style={{ marginLeft: 6 }}>{run.env.label}</span>}
                          </td>
                          <td>{runKindLabel[run.kind]}</td>
                          <td>
                            <RunStateChip state={run.state} />
                          </td>
                          <td style={{ minWidth: 120 }}>
                            <SummaryBar summary={run.summary} />
                            <span className="mono text-xs muted">
                              {done} / {run.summary.total}
                            </span>
                          </td>
                          <td className="nowrap">
                            <Chip tone={passRate === null ? 'neutral' : passRate >= 0.9 ? 'good' : passRate >= 0.7 ? 'warn' : 'bad'} mono>
                              {formatPercent(passRate)}
                            </Chip>
                          </td>
                          <td className="nowrap text-xs muted" title={formatDateTime(run.startedAt)}>
                            {formatAgo(run.startedAt)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
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
    </>
  );
}
