import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  api,
  formatDate,
  modeLabel,
  runTypeLabel,
  type RunDetail,
  type RunSummary,
  type ScenarioMeta,
  type SuiteDefinition,
} from '../api';
import PageHeader from '../components/PageHeader';
import RunReportsPanel from '../components/RunReportsPanel';
import StatusBadge from '../components/StatusBadge';

interface SuiteStepRow {
  id?: string;
  stepIndex: number;
  scenarioName: string;
  status: string;
}

export default function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [childRuns, setChildRuns] = useState<RunSummary[]>([]);
  const [suite, setSuite] = useState<SuiteDefinition | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioMeta[]>([]);
  const [error, setError] = useState('');
  const missingCount = useRef(0);

  useEffect(() => {
    if (!id) return;

    let cancelled = false;
    missingCount.current = 0;

    async function load() {
      try {
        const data = await api.getRun(id!);
        if (cancelled) return;
        missingCount.current = 0;
        setError('');
        setRun(data);

        if (data.runType === 'suite') {
          if (data.childRunIds?.length) {
            const all = await api.getRuns();
            if (cancelled) return;
            setChildRuns(all.filter((r) => data.childRunIds?.includes(r.id)));
          } else {
            setChildRuns([]);
          }

          if (data.suiteId) {
            try {
              const suiteData = await api.getSuite(data.suiteId);
              if (!cancelled) setSuite(suiteData);
            } catch {
              if (!cancelled) setSuite(null);
            }
          }

          try {
            const scenarioList = await api.getScenarios();
            if (!cancelled) setScenarios(scenarioList);
          } catch {
            if (!cancelled) setScenarios([]);
          }
        }
      } catch (e) {
        if (cancelled) return;
        missingCount.current += 1;
        if (missingCount.current >= 3) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    }

    load();
    const interval = setInterval(load, 2000);

    const es = new EventSource(`/api/runs/${id}/stream`);
    es.addEventListener('log', (ev) => {
      const lines = JSON.parse(ev.data) as string[];
      setRun((prev) => (prev ? { ...prev, logs: [...prev.logs, ...lines] } : prev));
    });
    es.addEventListener('done', () => {
      es.close();
      load();
    });

    return () => {
      cancelled = true;
      clearInterval(interval);
      es.close();
    };
  }, [id]);

  async function handleCancel() {
    if (!id) return;
    await api.cancelRun(id);
    const data = await api.getRun(id);
    setRun(data);
  }

  async function handleResume() {
    if (!id) return;
    await api.resumeRun(id);
    const data = await api.getRun(id);
    setRun(data);
  }

  const suiteSteps = useMemo((): SuiteStepRow[] => {
    if (!run || run.runType !== 'suite' || !run.totalSteps) return [];

    const rows: SuiteStepRow[] = [];
    for (let stepIndex = 1; stepIndex <= run.totalSteps; stepIndex++) {
      const child = childRuns.find((c) => c.stepIndex === stepIndex);
      if (child) {
        rows.push({
          id: child.id,
          stepIndex,
          scenarioName: child.scenarioName ?? `Крок ${stepIndex}`,
          status: child.status,
        });
        continue;
      }

      const scenarioPath = suite?.scenarioPaths[stepIndex - 1];
      const scenario = scenarios.find((s) => s.path === scenarioPath);
      rows.push({
        stepIndex,
        scenarioName:
          scenario?.name ?? scenarioPath?.replace(/^scenarios\//, '') ?? `Крок ${stepIndex}`,
        status: 'queued',
      });
    }
    return rows;
  }, [run, childRuns, suite, scenarios]);

  if (error && !run) {
    return (
      <div className="alert alert-err">
        {error}
        <div className="actions" style={{ marginTop: '0.75rem' }}>
          <Link to="/runs" className="btn btn-ghost btn-sm">← Прогони</Link>
          <Link to="/launch" className="btn btn-primary btn-sm">Новий прогін</Link>
        </div>
      </div>
    );
  }
  if (!run) return <p>Завантаження…</p>;

  const progress = run.runType === 'suite' && run.totalSteps
    ? Math.round((suiteSteps.filter((s) => s.status === 'passed' || s.status === 'failed').length / run.totalSteps) * 100)
    : null;

  return (
    <>
      <PageHeader
        title={run.scenarioName ?? `Прогін ${run.id.slice(0, 8)}`}
        subtitle={run.qaTargetUrl}
        actions={
          <>
            <Link to="/runs" className="btn btn-ghost btn-sm">← Прогони</Link>
            {run.status === 'paused' && (
              <button className="btn btn-primary btn-sm" onClick={handleResume}>Продовжити (Resume)</button>
            )}
            {run.active && run.status !== 'paused' && (
              <button className="btn btn-danger btn-sm" onClick={handleCancel}>Скасувати</button>
            )}
          </>
        }
      />

      <div className="card">
        <div className="meta-grid">
          <div className="meta-item"><span>Статус</span><strong><StatusBadge status={run.status} /></strong></div>
          <div className="meta-item"><span>Тип</span><strong>{runTypeLabel(run.runType)}</strong></div>
          <div className="meta-item"><span>Сайт</span><strong>{run.qaTargetUrl}</strong></div>
          <div className="meta-item"><span>Режим</span><strong>{modeLabel(run.qaMode)}</strong></div>
          <div className="meta-item"><span>Початок</span><strong>{formatDate(run.startedAt)}</strong></div>
          {run.finishedAt && (
            <div className="meta-item"><span>Завершено</span><strong>{formatDate(run.finishedAt)}</strong></div>
          )}
          {run.stepIndex && run.totalSteps && (
            <div className="meta-item"><span>Крок</span><strong>{run.stepIndex} / {run.totalSteps}</strong></div>
          )}
        </div>

        {progress !== null && (
          <div className="progress-wrap">
            <div className="progress-bar" style={{ width: `${progress}%` }} />
            <span className="progress-label">{progress}% ({suiteSteps.filter((s) => s.status === 'passed').length}/{run.totalSteps} успішно)</span>
          </div>
        )}

        {run.errorSummary && run.status !== 'paused' && (
          <div className="alert alert-err">{run.errorSummary}</div>
        )}

        {run.status === 'paused' && (
          <div className="alert alert-warn hitl-banner">
            <strong>Очікує дії оператора</strong>
            {run.hitlReason && <p style={{ margin: '0.4rem 0 0' }}>{run.hitlReason}</p>}
            <p className="muted" style={{ margin: '0.5rem 0 0' }}>
              Завершіть капчу, 2FA або OAuth у відкритому браузері, потім натисніть «Продовжити».
            </p>
          </div>
        )}
      </div>

      {(run.stepResults?.length || run.evidence) && <EvidencePanel run={run} />}

      {run.reportPaths && (run.status === 'passed' || run.status === 'failed') && (
        <RunReportsPanel reportPaths={run.reportPaths} />
      )}

      {run.runType === 'suite' && run.totalSteps && suiteSteps.length > 0 && (
        <div className="card">
          <h2>Кроки набору</h2>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Сценарій</th>
                <th>Статус</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {suiteSteps.map((step) => (
                <tr key={step.id ?? `step-${step.stepIndex}`}>
                  <td>{step.stepIndex}</td>
                  <td>{step.scenarioName}</td>
                  <td><StatusBadge status={step.status} /></td>
                  <td>
                    {step.id ? <Link to={`/runs/${step.id}`}>Логи</Link> : <span className="muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h2>Логи</h2>
        <div className="logs">{run.logs.join('\n') || '(очікування виводу…)'}</div>
      </div>
    </>
  );
}

function stepStatusLabel(status: string): string {
  const map: Record<string, string> = {
    passed: 'OK',
    failed: 'Помилка',
    healed: 'Самовиправлено',
    skipped: 'Пропущено',
  };
  return map[status] ?? status;
}

function EvidencePanel({ run }: { run: RunDetail }) {
  const summary = run.evidence?.summary;
  const bugReports = run.evidence?.bugReports ?? [];
  const steps = run.stepResults ?? [];

  return (
    <div className="card">
      <h2>Докази виконання (evidence)</h2>

      {summary && (
        <p className="muted">
          Всього: {summary.total} · Успішно: {summary.passed} · Помилок: {summary.failed} ·
          Самовиправлено: {summary.healed}
        </p>
      )}

      {run.evidence?.generatedSpec && (
        <p className="muted">
          Детермінований скрипт: <code>{run.evidence.generatedSpec}</code>
        </p>
      )}

      {steps.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Тип</th>
              <th>Інструкція</th>
              <th>Статус</th>
              <th>Виконавець</th>
              <th>Спроби</th>
              <th>Час</th>
              <th>Деталі</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((s) => (
              <tr key={`${s.kind}-${s.index}`}>
                <td>{s.index + 1}</td>
                <td>{s.kind === 'assertion' ? 'Перевірка' : 'Крок'}</td>
                <td>{s.instruction}</td>
                <td>
                  {s.status === 'passed' || s.status === 'failed' ? (
                    <StatusBadge status={s.status} />
                  ) : (
                    stepStatusLabel(s.status)
                  )}
                </td>
                <td>{s.handledBy}</td>
                <td>{s.attempts}{s.healed ? ' 🩹' : ''}</td>
                <td>{s.durationMs} ms</td>
                <td className="muted">{s.error ?? s.thought ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {bugReports.length > 0 && (
        <>
          <h3>Звіти про дефекти застосунку</h3>
          {bugReports.map((b) => (
            <div key={b.id} className="alert alert-err" style={{ marginTop: '0.5rem' }}>
              <strong>[{b.severity}]</strong> {b.assertion}
              {b.rootCauseHypothesis && <p style={{ margin: '0.4rem 0 0' }}>{b.rootCauseHypothesis}</p>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
