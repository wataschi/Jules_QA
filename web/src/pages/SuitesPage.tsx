import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { api, type SuiteDefinition } from '../api';
import PageHeader from '../components/PageHeader';

export default function SuitesPage() {
  const [suites, setSuites] = useState<SuiteDefinition[]>([]);
  const [error, setError] = useState('');

  async function load() {
    setSuites(await api.getSuites());
  }

  useEffect(() => {
    load().catch((e) => setError(String(e)));
  }, []);

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Видалити набір «${name}»?`)) return;
    try {
      await api.deleteSuite(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <PageHeader
        title="Набори сценаріїв"
        subtitle="Послідовні smoke / regression suites на одному URL"
        actions={<Link to="/suites/new" className="btn btn-primary btn-sm">+ Новий набір</Link>}
      />

      {error && <div className="alert alert-err">{error}</div>}

      <div className="card">
        {suites.length === 0 ? (
          <p className="muted">Створіть набір — наприклад universal-smoke з 5 universal-сценаріїв.</p>
        ) : (
          <div className="scenario-cards">
            {suites.map((s) => (
              <article key={s.id} className="scenario-card">
                <div className="scenario-card-head">
                  <strong>{s.name}</strong>
                  <span className="tag">{s.scenarioPaths.length} кроків</span>
                </div>
                <p className="scenario-goal">{s.description || 'Без опису'}</p>
                <ul className="suite-steps-preview">
                  {s.scenarioPaths.map((p, i) => (
                    <li key={p}>
                      <span className="chain-num">{i + 1}</span>
                      <span className="suite-step-name">{p.replace('scenarios/', '')}</span>
                    </li>
                  ))}
                </ul>
                <p className="scenario-card-meta field-hint">
                  stopOnFailure: {s.stopOnFailure ? 'так' : 'ні'}
                </p>
                <div className="scenario-card-actions">
                  <Link to={`/launch?suite=${encodeURIComponent(s.id)}`} className="btn btn-primary btn-sm">Запустити</Link>
                  <Link to={`/suites/${s.id}`} className="btn btn-ghost btn-sm">Редагувати</Link>
                  <button type="button" className="btn-link" onClick={() => handleDelete(s.id, s.name)}>Видалити</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
