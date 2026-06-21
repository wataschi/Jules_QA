import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type ScenarioMeta, type SuiteForm } from '../api';

export default function SuiteEditPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id || id === 'new';
  const navigate = useNavigate();
  const [form, setForm] = useState<SuiteForm>({
    name: '',
    description: '',
    scenarioPaths: [],
    stopOnFailure: true,
  });
  const [scenarios, setScenarios] = useState<ScenarioMeta[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.getScenarios().then((list) => {
      if (!cancelled) setScenarios(list);
    }).catch((e) => {
      if (!cancelled) setError(String(e));
    });

    if (!isNew && id) {
      api.getSuite(id).then((s) => {
        if (cancelled) return;
        setForm({
          name: s.name,
          description: s.description,
          scenarioPaths: s.scenarioPaths,
          stopOnFailure: s.stopOnFailure,
        });
      }).catch((e) => {
        if (!cancelled) setError(String(e));
      });
    } else if (isNew) {
      api.getSuiteTemplate().then((template) => {
        if (cancelled) return;
        setForm((prev) => (
          prev.scenarioPaths.length > 0 || prev.name.trim()
            ? prev
            : template
        ));
      }).catch(() => undefined);
    }

    return () => {
      cancelled = true;
    };
  }, [id, isNew]);

  function toggleScenario(path: string) {
    setForm((prev) => {
      const has = prev.scenarioPaths.includes(path);
      return {
        ...prev,
        scenarioPaths: has
          ? prev.scenarioPaths.filter((p) => p !== path)
          : [...prev.scenarioPaths, path],
      };
    });
  }

  function moveScenario(index: number, dir: -1 | 1) {
    const next = [...form.scenarioPaths];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setForm({ ...form, scenarioPaths: next });
  }

  async function handleDelete() {
    if (isNew || !id) return;
    if (!confirm(`Видалити набір «${form.name}»? Цю дію не можна скасувати.`)) return;
    setDeleting(true);
    setError('');
    try {
      await api.deleteSuite(id);
      navigate('/suites');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const name = form.name.trim();
    if (!name) {
      setError('Вкажіть назву набору');
      return;
    }
    if (form.scenarioPaths.length === 0) {
      setError('Оберіть хоча б один сценарій');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const payload = { ...form, name };
      if (isNew) {
        const saved = await api.createSuite(payload);
        navigate(`/suites/${saved.id}`);
      } else if (id) {
        await api.updateSuite(id, payload);
        navigate('/suites');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className="actions" style={{ marginBottom: '1rem' }}>
        <Link to="/suites" className="btn btn-ghost">← Назад</Link>
      </div>

      <div className="help-banner">
        Набір виконує сценарії <strong>послідовно</strong> на одному URL. Порядок має значення — перетягніть стрілками ↑↓.
      </div>

      <div className="card">
        <h2>{isNew ? 'Новий набір' : 'Редагування набору'}</h2>

        <div className="field">
          <label htmlFor="name">Назва набору</label>
          <input
            id="name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="desc">Опис</label>
          <textarea
            id="desc"
            className="textarea"
            rows={2}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </div>

        <div className="field checkbox-row">
          <input
            id="stop"
            type="checkbox"
            checked={form.stopOnFailure}
            onChange={(e) => setForm({ ...form, stopOnFailure: e.target.checked })}
          />
          <label htmlFor="stop">
            Зупинити набір при першій помилці
            <span className="field-hint" style={{ display: 'block', marginTop: '0.25rem' }}>
              Увімкнено — для залежних кроків (логін → дія). Вимкнено — для smoke-наборів, щоб побачити всі помилки за один прогін.
            </span>
          </label>
        </div>
      </div>

      <div className="card">
        <h2>Сценарії в наборі ({form.scenarioPaths.length})</h2>
        <p className="field-hint">Відмітьте сценарії та встановіть порядок виконання.</p>

        <div className="scenario-picker">
          {scenarios.map((s) => (
            <label key={s.path} className="picker-row">
              <input
                type="checkbox"
                checked={form.scenarioPaths.includes(s.path)}
                onChange={() => toggleScenario(s.path)}
              />
              <span>
                <strong>{s.name}</strong>
                <small>{s.goal}</small>
              </span>
            </label>
          ))}
        </div>

        {form.scenarioPaths.length > 0 && (
          <div className="chain-list">
            <h3>Порядок виконання</h3>
            {form.scenarioPaths.map((path, i) => {
              const sc = scenarios.find((s) => s.path === path);
              return (
                <div key={path} className="chain-item">
                  <span className="chain-num">{i + 1}</span>
                  <span>{sc?.name ?? path}</span>
                  <div className="chain-actions">
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => moveScenario(i, -1)} disabled={i === 0}>↑</button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => moveScenario(i, 1)} disabled={i === form.scenarioPaths.length - 1}>↓</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {error && <div className="alert alert-err">{error}</div>}

      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={saving || deleting}>
          {saving ? 'Збереження…' : 'Зберегти набір'}
        </button>
        {!isNew && (
          <button type="button" className="btn btn-danger" disabled={saving || deleting} onClick={handleDelete}>
            {deleting ? 'Видалення…' : 'Видалити набір'}
          </button>
        )}
      </div>
    </form>
  );
}
