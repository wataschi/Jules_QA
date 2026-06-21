import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  api,
  modeHint,
  modeLabel,
  type SuiteDefinition,
  type UiSettings,
} from '../api';

type RunMode = 'single' | 'suite';

interface LaunchFormProps {
  compact?: boolean;
}

export default function LaunchForm({ compact }: LaunchFormProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const formTouched = useRef(false);

  const [settings, setSettings] = useState<UiSettings | null>(null);
  const [targetUrl, setTargetUrl] = useState('');
  const [mode, setMode] = useState<'warm-up' | 'regression'>('warm-up');
  const [scenario, setScenario] = useState('');
  const [suiteId, setSuiteId] = useState('');
  const [runMode, setRunMode] = useState<RunMode>('single');
  const [scenarios, setScenarios] = useState<Array<{ path: string; name: string; group?: string }>>([]);
  const [suites, setSuites] = useState<SuiteDefinition[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadInitial = useCallback(async () => {
    const [s, sc, su] = await Promise.all([api.getSettings(), api.getScenarios(), api.getSuites()]);
    setSettings(s);
    setScenarios(sc);
    setSuites(su);

    if (formTouched.current) return;

    const fromScenario = searchParams.get('scenario');
    const fromTarget = searchParams.get('targetUrl');
    const fromSuite = searchParams.get('suite');
    const st = location.state as { suiteId?: string } | null;
    const suiteFromNav = fromSuite || st?.suiteId;

    setTargetUrl(fromTarget || s.qaTargetUrl);
    setMode(s.qaMode);

    if (suiteFromNav && su.some((x) => x.id === suiteFromNav)) {
      setRunMode('suite');
      setSuiteId(suiteFromNav);
      setScenario(fromScenario && sc.some((x) => x.path === fromScenario) ? fromScenario : s.qaScenarioPath);
    } else if (fromScenario && sc.some((x) => x.path === fromScenario)) {
      setRunMode('single');
      setScenario(fromScenario);
      if (su.length > 0) setSuiteId(su[0].id);
    } else {
      setRunMode('single');
      setScenario(s.qaScenarioPath);
      if (su.length > 0) setSuiteId(su[0].id);
    }
  }, [location.state, searchParams]);

  useEffect(() => {
    formTouched.current = false;
    loadInitial().catch((e) => setError(String(e)));
  }, [loadInitial]);

  const universalScenarios = scenarios.filter((s) => s.name.startsWith('universal-'));
  const otherScenarios = scenarios.filter((s) => !s.name.startsWith('universal-'));

  async function handleRun() {
    setLoading(true);
    setError('');
    try {
      if (runMode === 'single') {
        await api.saveSettings({
          ...(settings ?? { qaTargetUrl: targetUrl, qaMode: mode, qaScenarioPath: scenario, debugCache: false }),
          qaTargetUrl: targetUrl,
          qaMode: mode,
          qaScenarioPath: scenario,
        });
        const run = await api.startRun({ qaTargetUrl: targetUrl, qaMode: mode, qaScenarioPath: scenario });
        navigate(`/runs/${run.id}`);
      } else {
        const run = await api.startSuiteRun(suiteId, { qaTargetUrl: targetUrl, qaMode: mode });
        navigate(`/runs/${run.id}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={`card launch-card ${compact ? 'compact' : ''}`}>
      {!compact && <h2>Конфігурація прогону</h2>}

      <div className="tabs">
        <button
          type="button"
          className={`tab ${runMode === 'single' ? 'tab-active' : ''}`}
          onClick={() => setRunMode('single')}
        >
          Один сценарій
        </button>
        <button
          type="button"
          className={`tab ${runMode === 'suite' ? 'tab-active' : ''}`}
          onClick={() => setRunMode('suite')}
        >
          Набір сценаріїв
        </button>
      </div>

      <div className="field">
        <label htmlFor="target">URL сайту під тест</label>
        <input
          id="target"
          type="url"
          value={targetUrl}
          onChange={(e) => { formTouched.current = true; setTargetUrl(e.target.value); }}
          placeholder="https://myapp.com"
          required
        />
      </div>

      <div className="grid-2">
        <div className="field">
          <label htmlFor="mode">Режим AI</label>
          <select
            id="mode"
            value={mode}
            onChange={(e) => { formTouched.current = true; setMode(e.target.value as 'warm-up' | 'regression'); }}
          >
            <option value="warm-up">{modeLabel('warm-up')}</option>
            <option value="regression">{modeLabel('regression')}</option>
          </select>
          <p className="field-hint">{modeHint(mode)}</p>
        </div>

        {runMode === 'single' ? (
          <div className="field">
            <label htmlFor="scenario">Сценарій</label>
            <select
              id="scenario"
              value={scenario}
              onChange={(e) => { formTouched.current = true; setScenario(e.target.value); }}
            >
              {universalScenarios.length > 0 && (
                <optgroup label="Universal smoke">
                  {universalScenarios.map((s) => (
                    <option key={s.path} value={s.path}>{s.name}</option>
                  ))}
                </optgroup>
              )}
              {otherScenarios.length > 0 && (
                <optgroup label="Спеціалізовані">
                  {otherScenarios.map((s) => (
                    <option key={s.path} value={s.path}>{s.name}</option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
        ) : (
          <div className="field">
            <label htmlFor="suite">Набір</label>
            <select id="suite" value={suiteId} onChange={(e) => setSuiteId(e.target.value)}>
              {suites.map((s) => (
                <option key={s.id} value={s.id}>{s.name} ({s.scenarioPaths.length} кроків)</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {error && <div className="alert alert-err">{error}</div>}

      <div className="actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleRun}
          disabled={loading || !targetUrl || (runMode === 'suite' && !suiteId)}
        >
          {loading ? 'Запуск…' : runMode === 'suite' ? 'Запустити набір' : 'Запустити тест'}
        </button>
      </div>
    </div>
  );
}
