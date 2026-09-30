/**
 * Результат автопрогону одного кейса: підсумок, покрокова картина і дефекти.
 *
 * Досі екран прогону був однаковим для ручного й автоматичного: скрізь
 * чек-лист із клавішами «1..4». Для автопрогону це не те: людина нічого не
 * проставляє руками, їй треба бачити, який крок упав, що саме побачила модель
 * і скільки це коштувало. Дані беремо з прогону рушія (`/api/runs/:id`).
 */

import { Chip } from '../../components/ui';
import { ErrorState, Loading } from '../../components/states';
import { api } from '../../api';
import { useAsync } from '../../hooks/useAsync';
import { S } from '../../strings';
import type { LegacyBugReport, LegacyRunStepResult } from '../../types';
import { formatDuration } from '../../utils/format';

type Tone = 'neutral' | 'good' | 'warn' | 'bad';

const stepTone: Record<LegacyRunStepResult['status'], Tone> = {
  passed: 'good',
  healed: 'warn',
  failed: 'bad',
  skipped: 'neutral',
};

export default function AutoRunResult({ engineRunId }: { engineRunId: string }) {
  const state = useAsync((signal) => api.legacyGetRun(engineRunId, signal), [engineRunId], true);

  if (state.loading && !state.data) return <Loading rows={4} />;
  if (state.error && !state.data) {
    return <ErrorState message={state.error} status={state.status} onRetry={state.reload} />;
  }

  const run = state.data;
  if (!run) return null;

  const steps = run.stepResults ?? [];
  const summary = run.evidence?.summary;
  const reports = run.evidence?.bugReports ?? [];
  const duration =
    run.finishedAt && run.startedAt
      ? Date.parse(run.finishedAt) - Date.parse(run.startedAt)
      : undefined;
  // Невідоме число викликів і нуль — різні речі: нуль колись вигадувався там,
  // де модель насправді працювала.
  const modelCalls = steps.reduce<number | undefined>(
    (sum, step) => (step.modelCalls === undefined ? sum : (sum ?? 0) + step.modelCalls),
    summary?.modelCalls,
  );

  return (
    <div className="auto-result">
      <div className="row-wrap">
        <Chip tone="neutral" mono title={S.autoRun.target}>
          {run.qaTargetUrl}
        </Chip>
        {run.requestedTargetUrl && (
          <Chip tone="warn" title={S.autoRun.requestedHint}>
            {S.autoRun.requested}: {run.requestedTargetUrl}
          </Chip>
        )}
        {duration !== undefined && <Chip tone="neutral" mono>{formatDuration(duration)}</Chip>}
        {summary && (
          <>
            <Chip tone="good">
              {S.autoRun.passed}: {summary.passed}
            </Chip>
            {summary.failed > 0 && (
              <Chip tone="bad">
                {S.autoRun.failed}: {summary.failed}
              </Chip>
            )}
            {summary.healed > 0 && (
              <Chip tone="warn" title={S.autoRun.healedHint}>
                {S.autoRun.healed}: {summary.healed}
              </Chip>
            )}
            {(summary.skipped ?? 0) > 0 && (
              <Chip tone="neutral">
                {S.autoRun.skipped}: {summary.skipped}
              </Chip>
            )}
          </>
        )}
        <Chip tone="neutral" mono title={S.autoRun.modelCallsHint}>
          {S.autoRun.modelCalls}: {modelCalls ?? S.common.none}
        </Chip>
      </div>

      {run.errorSummary && <p className="text-sm">{run.errorSummary}</p>}

      {steps.length === 0 ? (
        <p className="muted text-sm">{S.autoRun.noSteps}</p>
      ) : (
        <ol className="steps">
          {steps.map((step) => (
            <li key={`${step.kind}-${step.index}-${step.instruction.slice(0, 20)}`} className={`step ${step.status}`}>
              <span className="step-kind">
                {step.kind === 'assertion' ? S.autoRun.kindAssertion : S.autoRun.kindStep}
              </span>
              <span className="step-text">{step.instruction}</span>
              <span className="spacer" />
              {step.healed && (
                <Chip tone="warn" title={S.autoRun.healedHint}>
                  {S.autoRun.healedShort(step.attempts)}
                </Chip>
              )}
              <span className="mono text-xs muted">{formatDuration(step.durationMs)}</span>
              <Chip tone={stepTone[step.status]}>{S.autoRun.status[step.status]}</Chip>
              {(step.error || step.thought) && (
                <p className="step-why text-xs">{step.error ?? step.thought}</p>
              )}
            </li>
          ))}
        </ol>
      )}

      {reports.length > 0 && (
        <div className="auto-defects">
          <h4 className="muted text-xs">{S.autoRun.defects}</h4>
          {reports.map((report) => (
            <BugReportCard key={report.id} report={report} />
          ))}
        </div>
      )}
    </div>
  );
}

function BugReportCard({ report }: { report: LegacyBugReport }) {
  const unconfirmed = report.confidence === 'unconfirmed';
  return (
    <div className={`auto-defect${unconfirmed ? ' unconfirmed' : ''}`}>
      <div className="row-wrap">
        <Chip tone={unconfirmed ? 'neutral' : 'bad'}>
          {unconfirmed ? S.autoRun.unconfirmed : S.autoRun.confirmed}
        </Chip>
        <strong className="text-sm">{report.assertion}</strong>
      </div>
      {report.thought && <p className="text-xs muted">{report.thought}</p>}
      {/* Найцінніше для людини: чим саме прогін сам собі суперечить. */}
      {report.contradictedBy && (
        <p className="text-xs">
          {S.autoRun.contradicted}: {report.contradictedBy}
        </p>
      )}
    </div>
  );
}
