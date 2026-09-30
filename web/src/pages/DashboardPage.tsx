/**
 * Дашборд — стартовий екран: черга рішень, KPI, зведення за модулями,
 * нестабільні кейси, останні прогони. Одне джерело — `GET /api/registry/dashboard`.
 */

import { Link } from 'react-router-dom';
import { api } from '../api';
import { Async } from '../components/states';
import {
  BarRow,
  Chip,
  ItemStatusChip,
  Kpi,
  PageHead,
  RunStateChip,
  SummaryBar,
} from '../components/ui';
import { useApp } from '../context/AppContext';
import { useResource } from '../hooks/useAsync';
import {
  S,
  automationStatusLabel,
  caseStatusLabel,
  runKindLabel,
} from '../strings';
import type { AutomationStatus, CasePriority, CaseStatus, DashboardData } from '../types';
import { flakeTone, formatAgo, formatDateTime, formatNumber, formatPercent, passRateTone } from '../utils/format';

export default function DashboardPage() {
  const { projectId } = useApp();
  const state = useResource((signal) => api.getDashboard(projectId, signal), [projectId], {
    enabled: Boolean(projectId),
    pollMs: 30_000,
  });

  return (
    <>
      <PageHead
        title={S.dashboard.title}
        sub={S.dashboard.sub}
        actions={
          <>
            <Link to="/cases" className="btn btn-sm">
              {S.dashboard.goCases}
            </Link>
            <Link to="/coverage" className="btn btn-sm">
              {S.dashboard.goCoverage}
            </Link>
          </>
        }
      />
      <Async state={state} skeletonRows={8}>
        {(data) => <DashboardBody data={data} />}
      </Async>
    </>
  );
}

function DashboardBody({ data }: { data: DashboardData }) {
  const { cases, coverage, runs, flaky, modules, pending } = data;
  const coverageRate = coverage.blocks > 0 ? coverage.coveredBlocks / coverage.blocks : null;
  const automationRate = cases.total > 0 ? cases.byAutomation.automated / cases.total : null;
  const decisionsTotal = pending.proposals + pending.drift + pending.openDefects;

  return (
    <>
      <CycleStrip data={data} />

      {/* ── черга рішень ── */}
      <div className="card">
        <div className="card-head">
          <h2>{S.dashboard.decisions}</h2>
          <span className="muted text-xs">{S.dashboard.decisionsSub}</span>
        </div>
        {decisionsTotal === 0 ? (
          <div className="card-body">
            <p className="state-title">{S.empty.decisions}</p>
            <p className="muted text-sm">{S.empty.decisionsHint}</p>
          </div>
        ) : (
          <div className="card-body">
            <div className="grid grid-kpi">
              <DecisionCard
                label={S.dashboard.proposalsPending}
                value={pending.proposals}
                to="/proposals?state=pending"
                cta={S.dashboard.goProposals}
                tone={pending.proposals > 0 ? 'warn' : 'neutral'}
              />
              <DecisionCard
                label={S.dashboard.drift}
                value={pending.drift}
                to="/settings"
                cta={S.settings.mappings}
                tone={pending.drift > 0 ? 'warn' : 'neutral'}
              />
              <DecisionCard
                label={S.dashboard.openDefects}
                value={pending.openDefects}
                to="/defects?status=open"
                cta={S.nav.defects}
                tone={pending.openDefects > 0 ? 'bad' : 'neutral'}
              />
            </div>
          </div>
        )}
      </div>

      {/* ── KPI ── */}
      <div className="grid grid-kpi">
        <Kpi
          label={S.dashboard.kpiCases}
          value={formatNumber(cases.total)}
          note={`${caseStatusLabel.approved}: ${cases.byStatus.approved} · ${caseStatusLabel.draft}: ${cases.byStatus.draft}`}
        />
        <Kpi
          label={S.dashboard.kpiCoverage}
          value={formatPercent(coverageRate)}
          note={`${coverage.coveredBlocks} / ${coverage.blocks} ${S.dashboard.coverageBlocks} · ${coverage.gaps} ${S.dashboard.coverageGaps}`}
        />
        <Kpi
          label={S.dashboard.kpiAutomation}
          value={formatPercent(automationRate)}
          note={`${automationStatusLabel.automated}: ${cases.byAutomation.automated} · ${automationStatusLabel.quarantined}: ${cases.byAutomation.quarantined}`}
        />
        <Kpi
          label={S.dashboard.kpiPassRate}
          value={formatPercent(runs.passRate7d)}
          note={`${S.dashboard.kpiRuns7d}: ${runs.last7d} · ${S.dashboard.kpiOpenRuns}: ${runs.open}`}
        />
      </div>

      <div className="grid grid-2">
        {/* ── розподіли ── */}
        <div className="card">
          <div className="card-head">
            <h2>{S.dashboard.byStatus}</h2>
          </div>
          <div className="card-body">
            <div className="bar-list">
              {(Object.keys(cases.byStatus) as CaseStatus[]).map((key) => (
                <BarRow
                  key={key}
                  label={caseStatusLabel[key]}
                  value={cases.byStatus[key]}
                  max={cases.total}
                  tone={key === 'approved' ? 'good' : key === 'deprecated' ? 'bad' : undefined}
                />
              ))}
            </div>
            <h3 className="muted text-xs">{S.dashboard.byAutomation}</h3>
            <div className="bar-list">
              {(Object.keys(cases.byAutomation) as AutomationStatus[]).map((key) => (
                <BarRow
                  key={key}
                  label={automationStatusLabel[key]}
                  value={cases.byAutomation[key]}
                  max={cases.total}
                  tone={key === 'automated' ? 'good' : key === 'quarantined' ? 'warn' : undefined}
                />
              ))}
            </div>
            <h3 className="muted text-xs">{S.dashboard.byPriority}</h3>
            <div className="bar-list">
              {(Object.keys(cases.byPriority) as CasePriority[]).map((key) => (
                <BarRow key={key} label={key} value={cases.byPriority[key]} max={cases.total} />
              ))}
            </div>
          </div>
        </div>

        {/* ── модулі ── */}
        <div className="card">
          <div className="card-head">
            <h2>{S.dashboard.modules}</h2>
          </div>
          {modules.length === 0 ? (
            <div className="card-body">
              <p className="muted text-sm">{S.empty.treeHint}</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="tbl tbl-narrow">
                <thead>
                  <tr>
                    <th scope="col">{S.dashboard.moduleName}</th>
                    <th scope="col">{S.dashboard.moduleCases}</th>
                    <th scope="col">{S.dashboard.moduleAutomated}</th>
                    <th scope="col">{S.dashboard.modulePassRate}</th>
                    <th scope="col">{S.dashboard.moduleGaps}</th>
                  </tr>
                </thead>
                <tbody>
                  {modules.map((module) => (
                    <tr key={module.sectionId}>
                      <td>
                        <Link to={`/cases?section=${encodeURIComponent(module.sectionId)}`}>{module.name}</Link>
                      </td>
                      <td className="cell-num">{module.cases}</td>
                      <td className="cell-num">{module.automated}</td>
                      <td>
                        <Chip tone={passRateTone(module.passRate) ?? 'neutral'}>
                          {formatPercent(module.passRate)}
                        </Chip>
                      </td>
                      <td className="cell-num">{module.gaps}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-2">
        {/* ── нестабільні ── */}
        <div className="card">
          <div className="card-head">
            <h2>{S.dashboard.flaky}</h2>
          </div>
          {flaky.length === 0 ? (
            <div className="card-body">
              <p className="state-title">{S.empty.flaky}</p>
              <p className="muted text-sm">{S.empty.flakyHint}</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="tbl tbl-narrow">
                <thead>
                  <tr>
                    <th scope="col">{S.cases.colId}</th>
                    <th scope="col">{S.cases.colTitle}</th>
                    <th scope="col">{S.dashboard.flakeScore}</th>
                    <th scope="col">{S.dashboard.lastResult}</th>
                  </tr>
                </thead>
                <tbody>
                  {flaky.slice(0, 8).map((item) => (
                    <tr key={item.caseId}>
                      <td className="cell-id">
                        <Link to={`/cases?case=${encodeURIComponent(item.caseId)}`}>{item.caseId}</Link>
                      </td>
                      <td>{item.title}</td>
                      <td>
                        <Chip tone={flakeTone(item.flakeScore)} mono>
                          {formatPercent(item.flakeScore)}
                        </Chip>
                      </td>
                      <td>{item.lastResult ? <ItemStatusChip status={item.lastResult} /> : S.common.none}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── останні прогони ── */}
        <div className="card">
          <div className="card-head">
            <h2>{S.dashboard.recentRuns}</h2>
            <span className="spacer" />
            <Link to="/runs" className="btn btn-sm btn-ghost">
              {S.nav.runs} →
            </Link>
          </div>
          {runs.recent.length === 0 ? (
            <div className="card-body">
              <p className="state-title">{S.empty.runs}</p>
              <p className="muted text-sm">{S.empty.runsHint}</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="tbl tbl-narrow">
                <thead>
                  <tr>
                    <th scope="col">{S.runs.colTitle}</th>
                    <th scope="col">{S.runs.colKind}</th>
                    <th scope="col">{S.runs.colState}</th>
                    <th scope="col">{S.runs.colProgress}</th>
                    <th scope="col">{S.runs.colStarted}</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.recent.slice(0, 8).map((run) => (
                    <tr key={run.id}>
                      <td>
                        <Link to={`/runs/${encodeURIComponent(run.id)}`}>{run.title}</Link>
                      </td>
                      <td>{runKindLabel[run.kind]}</td>
                      <td>
                        <RunStateChip state={run.state} />
                      </td>
                      <td style={{ minWidth: 110 }}>
                        <SummaryBar summary={run.summary} />
                      </td>
                      <td className="nowrap" title={formatDateTime(run.startedAt)}>
                        {formatAgo(run.startedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Смужка циклу: документ → кейс → погодження → скрипт → прогін.
 *
 * Це єдине місце, де видно весь маршрут роботи одразу. Без неї новачок бачив
 * шість рівноправних пунктів меню й не розумів, з чого починати і чим це
 * закінчується. Кожен крок веде на свій екран і показує власну цифру, тож
 * смужка водночас і карта, і показник прогресу.
 */
function CycleStrip({ data }: { data: DashboardData }) {
  const { cases, coverage, runs, pending } = data;

  const steps = [
    {
      to: '/coverage',
      label: S.dashboard.cycleDocs,
      note:
        coverage.blocks > 0
          ? S.dashboard.cycleDocsNote(coverage.coveredBlocks, coverage.blocks)
          : S.dashboard.cycleDocsEmpty,
      done: coverage.blocks > 0 && coverage.gaps === 0,
      attention: coverage.gaps > 0,
    },
    {
      to: '/cases',
      label: S.dashboard.cycleCases,
      note: S.dashboard.cycleCasesNote(cases.byStatus.approved, cases.total),
      done: cases.total > 0 && cases.byStatus.approved === cases.total,
      attention: false,
    },
    {
      to: '/proposals?state=pending',
      label: S.dashboard.cycleReview,
      note: S.dashboard.cycleReviewNote(pending.proposals),
      done: pending.proposals === 0,
      attention: pending.proposals > 0,
    },
    {
      to: '/cases?automation=automated',
      label: S.dashboard.cycleAutomation,
      note: S.dashboard.cycleAutomationNote(cases.byAutomation.automated, cases.total),
      done: cases.total > 0 && cases.byAutomation.automated === cases.total,
      attention: false,
    },
    {
      to: '/runs',
      label: S.dashboard.cycleRuns,
      note: S.dashboard.cycleRunsNote(runs.last7d),
      done: runs.last7d > 0,
      attention: false,
    },
  ];

  return (
    <div className="card">
      <div className="card-head">
        <h2>{S.dashboard.cycle}</h2>
        <span className="muted text-xs">{S.dashboard.cycleSub}</span>
      </div>
      <div className="card-body">
        <ol className="cycle">
          {steps.map((step, index) => (
            <li key={step.to} className="cycle-step">
              <Link
                to={step.to}
                className={`cycle-card${step.attention ? ' attention' : step.done ? ' done' : ''}`}
              >
                <span className="cycle-num" aria-hidden="true">
                  {step.done && !step.attention ? '✓' : index + 1}
                </span>
                <span className="cycle-label">{step.label}</span>
                <span className="cycle-note">{step.note}</span>
              </Link>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function DecisionCard({
  label,
  value,
  to,
  cta,
  tone,
}: {
  label: string;
  value: number;
  to: string;
  cta: string;
  tone: 'neutral' | 'warn' | 'bad';
}) {
  return (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">
        <Chip tone={tone} mono>
          {value}
        </Chip>
      </span>
      <Link className="kpi-note" to={to}>
        {cta} →
      </Link>
    </div>
  );
}
