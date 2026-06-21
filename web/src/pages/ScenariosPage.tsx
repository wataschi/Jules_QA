import { Link } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import { api, formatDate, type ScenarioMeta } from '../api';
import PageHeader from '../components/PageHeader';

export default function ScenariosPage() {
  const [scenarios, setScenarios] = useState<ScenarioMeta[]>([]);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [groupFilter, setGroupFilter] = useState('all');
  const [view, setView] = useState<'table' | 'cards'>('cards');

  async function load() {
    setScenarios(await api.getScenarios());
  }

  useEffect(() => {
    load().catch((e) => setError(String(e)));
  }, []);

  const groups = useMemo(() => {
    const set = new Set(scenarios.map((s) => s.group ?? (s.name.startsWith('universal-') ? 'universal' : 'custom')));
    return ['all', ...Array.from(set).sort()];
  }, [scenarios]);

  const filtered = scenarios.filter((s) => {
    const g = s.group ?? (s.name.startsWith('universal-') ? 'universal' : 'custom');
    if (groupFilter !== 'all' && g !== groupFilter) return false;
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (
      s.name.toLowerCase().includes(q) ||
      s.goal.toLowerCase().includes(q) ||
      (s.tags ?? []).some((t) => t.toLowerCase().includes(q))
    );
  });

  async function handleDelete(path: string, name: string) {
    if (!confirm(`Видалити сценарій «${name}»?`)) return;
    try {
      await api.deleteScenario(path);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <PageHeader
        title="Сценарії"
        subtitle="YAML-тести: goal, hints, steps, success_criteria для AI-агента"
        actions={
          <>
            <Link to="/ai-lab" className="btn btn-ghost btn-sm">✦ AI генератор</Link>
            <Link to="/scenarios/new" className="btn btn-primary btn-sm">+ Новий</Link>
          </>
        }
      />

      {error && <div className="alert alert-err">{error}</div>}

      <div className="card">
        <div className="filters-bar">
          <input type="search" placeholder="Пошук…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
            {groups.map((g) => (
              <option key={g} value={g}>{g === 'all' ? 'Усі групи' : g}</option>
            ))}
          </select>
          <div className="tabs inline-tabs">
            <button type="button" className={`tab ${view === 'cards' ? 'tab-active' : ''}`} onClick={() => setView('cards')}>Картки</button>
            <button type="button" className={`tab ${view === 'table' ? 'tab-active' : ''}`} onClick={() => setView('table')}>Таблиця</button>
          </div>
        </div>

        {filtered.length === 0 ? (
          <p className="muted">Немає сценаріїв.</p>
        ) : view === 'cards' ? (
          <div className="scenario-cards">
            {filtered.map((s) => (
              <article key={s.path} className="scenario-card">
                <div className="scenario-card-head">
                  <strong>{s.name}</strong>
                  <span className="tag">{s.group ?? (s.name.startsWith('universal-') ? 'universal' : 'custom')}</span>
                </div>
                <p className="scenario-goal">{s.goal}</p>
                {(s.tags?.length ?? 0) > 0 && (
                  <div className="tag-row">
                    {s.tags!.map((t) => <span key={t} className="tag tag-sm">{t}</span>)}
                  </div>
                )}
                <div className="scenario-card-actions">
                  <Link to={`/launch?scenario=${encodeURIComponent(s.path)}`} className="btn btn-primary btn-sm">Запустити</Link>
                  <Link to={`/scenarios/${encodeURIComponent(s.path.replace(/^scenarios\//, ''))}`} className="btn btn-ghost btn-sm">Редагувати</Link>
                  <button type="button" className="btn-link" onClick={() => handleDelete(s.path, s.name)}>Видалити</button>
                </div>
                {s.updatedAt && <small className="muted">{formatDate(s.updatedAt)}</small>}
              </article>
            ))}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Назва</th>
                <th>Мета</th>
                <th>Теги</th>
                <th>Група</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.path}>
                  <td><strong>{s.name}</strong></td>
                  <td className="cell-ellipsis" style={{ maxWidth: 360 }} title={s.goal}>{s.goal}</td>
                  <td>{(s.tags ?? []).join(', ') || '—'}</td>
                  <td>{s.group ?? '—'}</td>
                  <td className="actions-inline">
                    <Link to={`/launch?scenario=${encodeURIComponent(s.path)}`}>Запуск</Link>
                    {' · '}
                    <Link to={`/scenarios/${encodeURIComponent(s.path.replace(/^scenarios\//, ''))}`}>Edit</Link>
                    {' · '}
                    <button type="button" className="btn-link" onClick={() => handleDelete(s.path, s.name)}>Видалити</button>
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
