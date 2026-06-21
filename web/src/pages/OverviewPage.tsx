import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDate, modeLabel, runTypeLabel } from '../api';
import LaunchForm from '../components/LaunchForm';
import PageHeader from '../components/PageHeader';
import StatCard from '../components/StatCard';
import StatusBadge from '../components/StatusBadge';
import { useLlm } from '../context/AppContext';

export default function OverviewPage() {
  const llm = useLlm();
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.getStats>> | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getStats().then(setStats).catch((e) => setError(String(e)));
    const id = setInterval(() => api.getStats().then(setStats).catch(() => undefined), 8000);
    return () => clearInterval(id);
  }, []);

  return (
    <>
      <PageHeader
        title="Огляд"
        subtitle="Статистика прогонів, швидкий запуск та стан AI QA-платформи"
      />

      {error && <div className="alert alert-err">{error}</div>}

      {!llm.ok && !llm.checking && (
        <div className="alert alert-err">
          AI-модель недоступна. Перевірте LM Studio / Ollama та <Link to="/settings">налаштування</Link>.
        </div>
      )}

      <div className="stat-grid">
        <StatCard label="Успішність" value={stats?.passRate != null ? `${stats.passRate}%` : '—'} tone="ok" hint="Завершені прогони" />
        <StatCard label="Прогонів" value={stats?.totalRuns ?? '—'} tone="accent" hint={`${stats?.last7dRuns ?? 0} за 7 днів`} />
        <StatCard label="Активні" value={stats?.running ?? 0} tone="warn" hint="У черзі / виконуються" />
        <StatCard label="Сценарії" value={stats?.scenariosCount ?? '—'} hint={`${stats?.suitesCount ?? 0} наборів`} />
      </div>

      <div className="grid-2 overview-grid">
        <LaunchForm compact />

        <div className="card">
          <h2>Швидкі дії</h2>
          <div className="quick-actions">
            <Link to="/ai-lab" className="quick-action">
              <strong>✦ AI: написати тест</strong>
              <span>Генерація сценарію з опису природною мовою</span>
            </Link>
            <Link to="/scenarios/new" className="quick-action">
              <strong>+ Новий сценарій</strong>
              <span>YAML-сценарій вручну або з AI-підказками</span>
            </Link>
            <Link to="/suites/new" className="quick-action">
              <strong>⊞ Новий набір</strong>
              <span>Smoke / regression suite з кількох сценаріїв</span>
            </Link>
            <Link to="/reports" className="quick-action">
              <strong>▤ Звіти</strong>
              <span>Midscene, Playwright, aggregate HTML</span>
            </Link>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header-row">
          <h2>Останні прогони</h2>
          <Link to="/runs" className="btn btn-ghost btn-sm">Усі прогони →</Link>
        </div>
        {!stats?.recentRuns.length ? (
          <p className="muted">Ще немає прогонів. Запустіть перший тест вище.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Статус</th>
                <th>Тип</th>
                <th>Сайт</th>
                <th>Сценарій</th>
                <th>Режим</th>
                <th>Час</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {stats.recentRuns.map((run) => (
                <tr key={run.id}>
                  <td><StatusBadge status={run.status} /></td>
                  <td>{runTypeLabel(run.runType)}</td>
                  <td className="cell-ellipsis" title={run.qaTargetUrl}>{run.qaTargetUrl}</td>
                  <td>{run.scenarioName ?? run.qaScenarioPath}</td>
                  <td>{modeLabel(run.qaMode)}</td>
                  <td>{formatDate(run.startedAt)}</td>
                  <td><Link to={`/runs/${run.id}`}>Деталі</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
