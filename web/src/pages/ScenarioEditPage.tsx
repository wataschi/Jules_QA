import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  arrayToLines,
  linesToArray,
  type ScenarioForm,
} from '../api';
import PageHeader from '../components/PageHeader';

const empty: ScenarioForm = {
  name: '',
  goal: '',
  hints: [],
  steps: [],
  success_criteria: [],
  navigation: { type: 'deterministic' },
};

export default function ScenarioEditPage() {
  const { filename } = useParams<{ filename: string }>();
  const isNew = filename === 'new';
  const navigate = useNavigate();

  const [form, setForm] = useState<ScenarioForm>(empty);
  const [hintsText, setHintsText] = useState('');
  const [stepsText, setStepsText] = useState('');
  const [criteriaText, setCriteriaText] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [existingPath, setExistingPath] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);

  useEffect(() => {
    async function load() {
      if (isNew) {
        const tpl = await api.getScenarioTemplate();
        setForm(tpl);
        setHintsText(arrayToLines(tpl.hints));
        setStepsText(arrayToLines(tpl.steps));
        setCriteriaText(arrayToLines(tpl.success_criteria));
        return;
      }
      const path = `scenarios/${decodeURIComponent(filename!)}`;
      const data = await api.getScenario(path);
      setExistingPath(data.path);
      setForm({
        name: data.name,
        goal: data.goal,
        target_url: data.target_url,
        tags: data.tags,
        group: data.group,
        hints: data.hints,
        steps: data.steps,
        success_criteria: data.success_criteria,
        navigation: data.navigation ?? { type: 'deterministic' },
      });
      setHintsText(arrayToLines(data.hints));
      setStepsText(arrayToLines(data.steps));
      setCriteriaText(arrayToLines(data.success_criteria));
      setTagsText((data.tags ?? []).join(', '));
    }
    load().catch((e) => setError(String(e)));
  }, [filename, isNew]);

  function buildPayload(): ScenarioForm {
    return {
      ...form,
      hints: linesToArray(hintsText),
      steps: linesToArray(stepsText),
      success_criteria: linesToArray(criteriaText),
      tags: tagsText.split(',').map((t) => t.trim()).filter(Boolean),
      target_url: form.target_url?.trim() || undefined,
      navigation: {
        type: form.navigation?.type ?? 'deterministic',
        url: form.navigation?.url?.trim() || undefined,
        instruction: form.navigation?.instruction?.trim() || undefined,
      },
    };
  }

  async function handleAiEnhance(focus: 'hints' | 'steps' | 'criteria' | 'all') {
    setAiLoading(true);
    setError('');
    try {
      const enhanced = await api.enhanceScenario(buildPayload(), focus);
      if (enhanced.hints) {
        setHintsText(arrayToLines(enhanced.hints));
        setForm((f) => ({ ...f, hints: enhanced.hints! }));
      }
      if (enhanced.steps) {
        setStepsText(arrayToLines(enhanced.steps));
        setForm((f) => ({ ...f, steps: enhanced.steps! }));
      }
      if (enhanced.success_criteria) {
        setCriteriaText(arrayToLines(enhanced.success_criteria));
        setForm((f) => ({ ...f, success_criteria: enhanced.success_criteria! }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiLoading(false);
    }
  }

  async function handleDelete() {
    if (!existingPath) return;
    if (!confirm(`Видалити сценарій «${form.name}»? Цю дію не можна скасувати.`)) return;
    setDeleting(true);
    setError('');
    try {
      await api.deleteScenario(existingPath);
      navigate('/scenarios');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    const payload = buildPayload();
    try {
      if (isNew) {
        await api.createScenario(payload);
      } else if (existingPath) {
        await api.updateScenario(existingPath, payload);
      }
      navigate('/scenarios');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader
        title={isNew ? 'Новий сценарій' : `Редагування: ${form.name}`}
        subtitle="YAML-сценарій для AI browser agent (Midscene + Playwright)"
        actions={<Link to="/scenarios" className="btn btn-ghost btn-sm">← Сценарії</Link>}
      />

      <div className="grid-2 editor-grid">
        <form onSubmit={handleSubmit} className="card">
          <div className="field">
            <label htmlFor="name">ID / name</label>
            <input id="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required disabled={!isNew} />
          </div>

          <div className="field">
            <label htmlFor="goal">Мета (goal)</label>
            <textarea id="goal" className="textarea" rows={3} value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })} required />
          </div>

          <div className="grid-2">
            <div className="field">
              <label htmlFor="group">Група</label>
              <input id="group" value={form.group ?? ''} onChange={(e) => setForm({ ...form, group: e.target.value || undefined })} placeholder="smoke, auth, universal…" />
            </div>
            <div className="field">
              <label htmlFor="tags">Теги (через кому)</label>
              <input id="tags" value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="e2e, critical, ai-generated" />
            </div>
          </div>

          <div className="field">
            <label htmlFor="hints">Підказки (hints)</label>
            <textarea id="hints" className="textarea" rows={3} value={hintsText} onChange={(e) => setHintsText(e.target.value)} />
          </div>

          <div className="field">
            <label htmlFor="steps">Кроки (steps)</label>
            <textarea id="steps" className="textarea" rows={5} value={stepsText} onChange={(e) => setStepsText(e.target.value)} placeholder="Порожньо = AI згенерує з goal" />
          </div>

          <div className="field">
            <label htmlFor="criteria">Критерії успіху</label>
            <textarea id="criteria" className="textarea" rows={4} value={criteriaText} onChange={(e) => setCriteriaText(e.target.value)} />
          </div>

          <div className="grid-2">
            <div className="field">
              <label htmlFor="navType">Навігація</label>
              <select
                id="navType"
                value={form.navigation?.type ?? 'deterministic'}
                onChange={(e) => setForm({ ...form, navigation: { ...form.navigation, type: e.target.value as 'deterministic' | 'ai' } })}
              >
                <option value="deterministic">deterministic</option>
                <option value="ai">ai (Stagehand)</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="navUrl">Navigation URL</label>
              <input id="navUrl" type="url" value={form.navigation?.url ?? ''} onChange={(e) => setForm({ ...form, navigation: { ...form.navigation, type: form.navigation?.type ?? 'deterministic', url: e.target.value || undefined } })} />
            </div>
          </div>

          {error && <div className="alert alert-err">{error}</div>}

          <div className="actions">
            <button type="submit" className="btn btn-primary" disabled={saving || deleting}>{saving ? 'Збереження…' : 'Зберегти'}</button>
            {!isNew && (
              <button type="button" className="btn btn-danger" disabled={saving || deleting} onClick={handleDelete}>
                {deleting ? 'Видалення…' : 'Видалити'}
              </button>
            )}
          </div>
        </form>

        <div className="card ai-assist-panel">
          <h2>AI-асистент</h2>
          <p className="field-hint">Покращення hints, steps та criteria через LLM. Потрібен підключений AI endpoint.</p>
          <div className="actions stacked-actions">
            <button type="button" className="btn btn-ghost" disabled={aiLoading} onClick={() => handleAiEnhance('all')}>
              {aiLoading ? '…' : '✦ Покращити все'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={aiLoading} onClick={() => handleAiEnhance('steps')}>+ Steps</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={aiLoading} onClick={() => handleAiEnhance('criteria')}>+ Criteria</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={aiLoading} onClick={() => handleAiEnhance('hints')}>+ Hints</button>
          </div>
          <Link to="/ai-lab" className="btn btn-primary" style={{ marginTop: '1rem', width: '100%', justifyContent: 'center' }}>
            Згенерувати новий сценарій з нуля
          </Link>
        </div>
      </div>
    </>
  );
}
