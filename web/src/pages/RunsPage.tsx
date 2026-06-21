import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDate, modeLabel, runTypeLabel, type RunSummary } from '../api';
import PageHeader from '../components/PageHeader';
import StatusBadge from '../components/StatusBadge';

export default function RunsPage() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    const load = () => api.getRuns().then(setRuns).catch((e) => setError(String(e)));
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  const filtered = useMemo(() => {
    return runs
      .filter((r) => r.runType !== 'suite-step')
      .filter((r) => statusFilter === 'all' || r.status === statusFilter)
      .filter((r) => {
        if (!search) return true;
        const q = search.toLowerCase();
        return (
          r.qaTargetUrl.toLowerCase().includes(q) ||
          (r.scenarioName ?? '').toLowerCase().includes(q) ||
          r.id.includes(q)
        );
      });
  }, [runs, statusFilter, search]);

  return (
    <>
      <PageHeader title="Прогони" subtitle="Історія, фільтрація та моніторинг усіх test runs" />

      {error && <div className="alert alert-err">{error}</div>}

      <div className="card">
        <div className="filters-bar">
          <input
            type="search"
            placeholder="Пошук за URL, сценарієм, ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">Усі статуси</option>
            <option value="passed">Успішно</option>
            <option value="failed">Помилка</option>
            <option value="running">Виконується</option>
            <option value="queued">У черзі</option>
            <option value="cancelled">Скасовано</option>
          </select>
        </div>

        <p className="muted filter-count">{filtered.length} прогонів</p>

        {filtered.length === 0 ? (
          <p className="muted">Немає прогонів за обраними фільтрами.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Статус</th>
                <th>Тип</th>
                <th>Сайт</th>
                <th>Сценарій / набір</th>
                <th>Режим</th>
                <th>Логи</th>
                <th>Час</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((run) => (
                <tr key={run.id}>
                  <td><StatusBadge status={run.status} /></td>
                  <td>{runTypeLabel(run.runType)}</td>
                  <td className="cell-ellipsis" title={run.qaTargetUrl}>{run.qaTargetUrl}</td>
                  <td>
                    {run.scenarioName ?? run.qaScenarioPath}
                    {run.runType === 'suite' && run.totalSteps ? ` (${run.totalSteps})` : ''}
                  </td>
                  <td>{modeLabel(run.qaMode)}</td>
                  <td>{run.logCount}</td>
                  <td>{formatDate(run.startedAt)}</td>
                  <td>
                    <Link to={`/runs/${run.id}`}>{run.active ? 'Live →' : 'Деталі'}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
