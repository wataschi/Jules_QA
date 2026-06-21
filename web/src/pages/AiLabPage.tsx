import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, arrayToLines, linesToArray, type ScenarioForm } from '../api';
import PageHeader from '../components/PageHeader';

const TEST_TYPES = [
  { id: 'e2e', label: 'E2E функціональний' },
  { id: 'smoke', label: 'Smoke' },
  { id: 'regression', label: 'Regression' },
  { id: 'accessibility', label: 'Accessibility' },
  { id: 'security', label: 'Security' },
] as const;

export default function AiLabPage() {
  const navigate = useNavigate();
  const [description, setDescription] = useState('');
  const [targetUrl, setTargetUrl] = useState('https://example.com');
  const [testType, setTestType] = useState<(typeof TEST_TYPES)[number]['id']>('e2e');
  const [ideas, setIdeas] = useState<string[]>([]);
  const [generated, setGenerated] = useState<ScenarioForm | null>(null);
  const [loading, setLoading] = useState<'generate' | 'ideas' | 'save' | null>(null);
  const [error, setError] = useState('');

  async function handleGenerate() {
    setLoading('generate');
    setError('');
    try {
      const scenario = await api.generateScenario({
        description,
        targetUrl: targetUrl || undefined,
        testType,
      });
      setGenerated(scenario);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(null);
    }
  }

  async function handleSuggestIdeas() {
    if (!targetUrl) return;
    setLoading('ideas');
    setError('');
    try {
      const { ideas: list } = await api.suggestIdeas(targetUrl, description || undefined);
      setIdeas(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(null);
    }
  }

  async function handleSaveAndRun() {
    if (!generated) return;
    setLoading('save');
    setError('');
    try {
      const saved = await api.createScenario(generated);
      const settings = await api.getSettings();
      await api.saveSettings({
        ...settings,
        qaTargetUrl: targetUrl,
        qaMode: settings.qaMode ?? 'warm-up',
        qaScenarioPath: saved.path,
      });
      const run = await api.startRun({
        qaTargetUrl: targetUrl,
        qaMode: settings.qaMode ?? 'warm-up',
        qaScenarioPath: saved.path,
      });
      navigate(`/runs/${run.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(null);
    }
  }

  function applyIdea(idea: string) {
    setDescription(idea);
  }

  return (
    <>
      <PageHeader
        title="AI Лабораторія"
        subtitle="Генерація тест-сценаріїв, ідей перевірок та покращення кроків за допомогою LLM"
      />

      <div className="help-banner">
        Опишіть що перевірити — AI згенерує <strong>goal, hints, steps, success_criteria</strong> для Midscene/Playwright.
        Потрібен підключений LLM (див. статус у боковій панелі).
      </div>

      {error && <div className="alert alert-err">{error}</div>}

      <div className="grid-2 ai-lab-grid">
        <div className="card">
          <h2>Генератор сценарію</h2>

          <div className="field">
            <label htmlFor="ai-url">URL сайту (контекст)</label>
            <input id="ai-url" type="url" value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} />
          </div>

          <div className="field">
            <label htmlFor="ai-type">Тип тестування</label>
            <select id="ai-type" value={testType} onChange={(e) => setTestType(e.target.value as typeof testType)}>
              {TEST_TYPES.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="ai-desc">Опис тесту природною мовою</label>
            <textarea
              id="ai-desc"
              className="textarea"
              rows={6}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Наприклад: Перевірити реєстрацію з невалідним паролем — має зʼявитись повідомлення про помилку українською"
            />
          </div>

          <div className="actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={loading !== null || description.length < 10}
              onClick={handleGenerate}
            >
              {loading === 'generate' ? 'Генерація…' : '✦ Згенерувати сценарій'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={loading !== null || !targetUrl}
              onClick={handleSuggestIdeas}
            >
              {loading === 'ideas' ? '…' : '💡 Ідеї тестів'}
            </button>
          </div>

          {ideas.length > 0 && (
            <div className="ideas-list">
              <h3>Ідеї для {targetUrl}</h3>
              <ul>
                {ideas.map((idea, i) => (
                  <li key={i}>
                    <button type="button" className="idea-btn" onClick={() => applyIdea(idea)}>
                      {idea}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="card">
          <h2>Попередній перегляд</h2>
          {!generated ? (
            <p className="muted">Згенерований сценарій зʼявиться тут. Можна редагувати перед збереженням.</p>
          ) : (
            <>
              <div className="meta-grid">
                <div className="meta-item"><span>name</span><strong>{generated.name}</strong></div>
                <div className="meta-item"><span>group</span><strong>{generated.group ?? 'ai-lab'}</strong></div>
              </div>
              <div className="field">
                <label>goal</label>
                <textarea className="textarea" rows={2} value={generated.goal} onChange={(e) => setGenerated({ ...generated, goal: e.target.value })} />
              </div>
              <div className="field">
                <label>hints ({generated.hints.length})</label>
                <textarea className="textarea" rows={3} value={arrayToLines(generated.hints)} onChange={(e) => setGenerated({ ...generated, hints: linesToArray(e.target.value) })} />
              </div>
              <div className="field">
                <label>steps ({generated.steps.length})</label>
                <textarea className="textarea" rows={5} value={arrayToLines(generated.steps)} onChange={(e) => setGenerated({ ...generated, steps: linesToArray(e.target.value) })} />
              </div>
              <div className="field">
                <label>success_criteria</label>
                <textarea className="textarea" rows={4} value={arrayToLines(generated.success_criteria)} onChange={(e) => setGenerated({ ...generated, success_criteria: linesToArray(e.target.value) })} />
              </div>
              <div className="actions">
                <button type="button" className="btn btn-primary" disabled={loading === 'save'} onClick={handleSaveAndRun}>
                  {loading === 'save' ? 'Збереження…' : 'Зберегти і запустити'}
                </button>
                <Link to={`/scenarios/new`} className="btn btn-ghost">Редактор YAML</Link>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
