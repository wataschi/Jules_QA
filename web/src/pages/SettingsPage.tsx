import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, modeHint, modeLabel, type ScenarioMeta, type UiSettings } from '../api';
import PageHeader from '../components/PageHeader';
import { useLlm } from '../context/AppContext';

export default function SettingsPage() {
  const llm = useLlm();
  const [settings, setSettings] = useState<UiSettings | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioMeta[]>([]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getSettings().then(setSettings).catch((e) => setError(String(e)));
    api.getScenarios().then(setScenarios).catch(() => undefined);
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setError('');
    try {
      await api.saveSettings(settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!settings) return <p className="muted">Завантаження…</p>;

  return (
    <>
      <PageHeader title="Налаштування" subtitle="Defaults, AI-модель, діагностика та режими виконання" />

      <form onSubmit={handleSave}>
        <div className="card">
          <h2>Запуск за замовчуванням</h2>
          <div className="field">
            <label htmlFor="defaultUrl">URL сайту</label>
            <input id="defaultUrl" type="url" value={settings.qaTargetUrl} onChange={(e) => setSettings({ ...settings, qaTargetUrl: e.target.value })} />
          </div>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="defaultMode">Режим AI</label>
              <select id="defaultMode" value={settings.qaMode} onChange={(e) => setSettings({ ...settings, qaMode: e.target.value as UiSettings['qaMode'] })}>
                <option value="warm-up">{modeLabel('warm-up')}</option>
                <option value="regression">{modeLabel('regression')}</option>
              </select>
              <p className="field-hint">{modeHint(settings.qaMode)}</p>
            </div>
            <div className="field">
              <label htmlFor="defaultScenario">Сценарій</label>
              <select id="defaultScenario" value={settings.qaScenarioPath} onChange={(e) => setSettings({ ...settings, qaScenarioPath: e.target.value })}>
                {scenarios.map((s) => (
                  <option key={s.path} value={s.path}>{s.name}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="field checkbox-row">
            <input id="debugCache" type="checkbox" checked={settings.debugCache} onChange={(e) => setSettings({ ...settings, debugCache: e.target.checked })} />
            <label htmlFor="debugCache">DEBUG midscene:cache (діагностика кешу локаторів)</label>
          </div>
        </div>

        <div className="card">
          <h2>AI / LLM</h2>
          <div className={`llm-status-banner ${llm.ok ? 'ok' : 'err'}`}>
            {llm.checking ? 'Перевірка зʼєднання…' : llm.ok ? '✓ Модель доступна для planning та execution' : '✗ LLM недоступний — перевірте .env та Tailscale'}
          </div>
          <div className="meta-grid">
            <div className="meta-item"><span>Endpoint</span><strong>{settings.llmBaseUrl ?? '—'}</strong></div>
            <div className="meta-item"><span>Модель</span><strong>{settings.llmModelName ?? '—'}</strong></div>
          </div>
          {llm.models.length > 0 && (
            <div className="field">
              <label>Доступні моделі</label>
              <ul className="model-list">
                {llm.models.map((m) => <li key={m}><code>{m}</code></li>)}
              </ul>
            </div>
          )}
          <p className="field-hint">
            Змінні <code>MIDSCENE_MODEL_*</code>, <code>PLANNER_MODEL_*</code> у файлі <code>.env</code>.
            Після змін перезапустіть контейнер: <code>docker compose restart qa</code>
          </p>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => llm.refresh()}>Оновити статус AI</button>
        </div>

        <div className="card">
          <h2>Довідка QA-інженеру</h2>
          <ul className="help-list">
            <li><strong>Warm-up</strong> — перший прохід, AI будує cache XPath-локаторів</li>
            <li><strong>Regression</strong> — повтор з read-only cache, мінімум LLM викликів</li>
            <li><strong>Universal scenarios</strong> — працюють на будь-якому публічному URL</li>
            <li><strong>AI Lab</strong> — генерація сценаріїв з опису українською</li>
          </ul>
        </div>

        {error && <div className="alert alert-err">{error}</div>}
        {saved && <div className="alert alert-ok">Збережено</div>}

        <button type="submit" className="btn btn-primary">Зберегти налаштування</button>
      </form>
    </>
  );
}
