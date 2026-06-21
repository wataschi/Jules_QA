import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDate, type RunSummary } from '../api';
import PageHeader from '../components/PageHeader';
import StatusBadge from '../components/StatusBadge';

export default function ReportsPage() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getRuns()
      .then((all) => setRuns(all.filter((r) => r.reportPaths && (r.status === 'passed' || r.status === 'failed'))))
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <>
      <PageHeader
        title="Звіти"
        subtitle="Aggregate, Playwright та Midscene HTML-звіти з завершених прогонів"
      />

      {error && <div className="alert alert-err">{error}</div>}

      <div className="card">
        {runs.length === 0 ? (
          <p className="muted">Немає звітів. Запустіть тест і дочекайтесь завершення.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Статус</th>
                <th>Сценарій</th>
                <th>Сайт</th>
                <th>Час</th>
                <th>Звіти</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {runs.slice(0, 50).map((run) => (
                <tr key={run.id}>
                  <td><StatusBadge status={run.status} /></td>
                  <td>{run.scenarioName ?? '—'}</td>
                  <td className="cell-ellipsis">{run.qaTargetUrl}</td>
                  <td>{run.finishedAt ? formatDate(run.finishedAt) : formatDate(run.startedAt)}</td>
                  <td className="actions-inline">
                    {run.reportPaths?.aggregate && (
                      <a href={run.reportPaths.aggregate} target="_blank" rel="noreferrer">Aggregate</a>
                    )}
                    {run.reportPaths?.playwright && (
                      <> · <a href={run.reportPaths.playwright} target="_blank" rel="noreferrer">Playwright</a></>
                    )}
                    {run.reportPaths?.midscene?.slice(0, 1).map((p) => (
                      <> · <a key={p} href={p} target="_blank" rel="noreferrer">Midscene</a></>
                    ))}
                  </td>
                  <td><Link to={`/runs/${run.id}`}>Прогін</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Довідка</h2>
        <ul className="help-list">
          <li><strong>Aggregate</strong> — зведений HTML з посиланнями на відео, plans, Midscene</li>
          <li><strong>Playwright</strong> — стандартний HTML report з traces</li>
          <li><strong>Midscene</strong> — vision AI покроковий звіт зі скріншотами</li>
        </ul>
      </div>
    </>
  );
}
