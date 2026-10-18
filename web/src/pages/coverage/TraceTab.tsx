/**
 * «Від вимоги до результату»: матриця в чотири шари —
 * блок вимоги → кейси → тести в коді → останній результат на CI.
 *
 * Прогалини видно з трьох боків і їх можна відфільтрувати:
 * вимога без кейсів, кейс без тесту, тест упав. На прогалині — кнопка
 * «Попросити тест», щоб QA одразу сформулював намір для агента.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RequestTaskDialog } from '../../components/RequestTaskDialog';
import { Async, Empty, ErrorState, Loading } from '../../components/states';
import { Chip, Kpi, SelectField, SummaryBar } from '../../components/ui';
import type { AsyncState } from '../../hooks/useAsync';
import { useAsync } from '../../hooks/useAsync';
import type { QueryParams } from '../../hooks/useQueryParams';
import { S } from '../../strings';
import type { BlockChangeState, CodeTest, CoverageResponse, CoverageRow, Source, TaskAnchor } from '../../types';
import { SC } from './strings';
import {
  CommitRef,
  FileLink,
  TestAuthorChip,
  TestLevelChip,
  TestResultChip,
  TestStateChip,
  groupByCase,
  isFailed,
  loadAllTests,
} from './TestBits';

type Gap = '' | 'no-cases' | 'no-tests' | 'failed';
const GAPS: Gap[] = ['', 'no-cases', 'no-tests', 'failed'];

const CHANGE_LABEL: Record<BlockChangeState, string> = {
  new: S.coverage.blockChangeNew,
  changed: S.coverage.blockChangeChanged,
  removed: S.coverage.blockChangeRemoved,
  same: S.coverage.blockChangeSame,
};

interface CaseView {
  caseId: string;
  title: string;
  kind: CoverageRow['cases'][number]['kind'];
  confirmed: boolean;
  tests: CodeTest[];
  noTests: boolean;
  failed: boolean;
}

interface RowView {
  row: CoverageRow;
  cases: CaseView[];
  noCases: boolean;
}

interface RequestTarget {
  anchor: TaskAnchor;
  label: string;
  title: string;
}

export function TraceTab({
  projectId,
  repo,
  params,
  coverageState,
  sources,
}: {
  projectId: string;
  repo?: string;
  params: QueryParams;
  coverageState: AsyncState<CoverageResponse>;
  sources: Source[];
}) {
  const testsState = useAsync((signal) => loadAllTests(projectId, signal), [projectId], Boolean(projectId));
  const [request, setRequest] = useState<RequestTarget | null>(null);

  const rawGap = params.get('gap') as Gap;
  const gap: Gap = GAPS.includes(rawGap) ? rawGap : '';
  const caseFilter = params.get('case');
  const sourceId = params.get('source');

  const testsKnown = testsState.data !== undefined;
  const byCase = useMemo(() => groupByCase(testsState.data?.items ?? []), [testsState.data]);
  const sourceTitle = useMemo(() => new Map(sources.map((item) => [item.id, item.title])), [sources]);

  const views: RowView[] = useMemo(
    () =>
      (coverageState.data?.rows ?? []).map((row) => {
        const cases = row.cases.map((item) => {
          const tests = byCase.get(item.caseId) ?? [];
          return {
            ...item,
            tests,
            noTests: testsKnown && tests.length === 0,
            failed: tests.some(isFailed),
          };
        });
        return { row, cases, noCases: row.cases.length === 0 };
      }),
    [coverageState.data, byCase, testsKnown],
  );

  const stats = useMemo(() => {
    const caseMap = new Map<string, CaseView>();
    for (const view of views) for (const item of view.cases) caseMap.set(item.caseId, item);
    const caseList = [...caseMap.values()];
    const linked = new Map<string, CodeTest>();
    for (const item of caseList) for (const test of item.tests) linked.set(test.id, test);
    const tests = [...linked.values()];
    const count = (status: 'passed' | 'failed' | 'skipped') => tests.filter((test) => test.lastResult?.status === status).length;
    return {
      blocks: views.length,
      blocksWithCases: views.filter((view) => !view.noCases).length,
      cases: caseList.length,
      casesWithTests: caseList.filter((item) => item.tests.length > 0).length,
      casesNoTests: caseList.filter((item) => item.noTests).length,
      failedTests: count('failed'),
      failedCases: caseList.filter((item) => item.failed).length,
      bar: { total: tests.length, passed: count('passed'), failed: count('failed'), blocked: 0, skipped: count('skipped') },
      orphans: (testsState.data?.items ?? []).filter((test) => test.caseIds.length === 0).length,
      blockGaps: views.filter((view) => view.noCases).length,
    };
  }, [views, testsState.data]);

  const visible = useMemo(() => {
    let rows = views;
    if (caseFilter) {
      rows = rows
        .map((view) => ({ ...view, cases: view.cases.filter((item) => item.caseId === caseFilter) }))
        .filter((view) => view.cases.length > 0);
    }
    if (gap === 'no-cases') return rows.filter((view) => view.noCases);
    if (gap === 'no-tests' || gap === 'failed') {
      const keep = (item: CaseView) => (gap === 'no-tests' ? item.noTests : item.failed);
      return rows
        .map((view) => ({ ...view, cases: view.cases.filter(keep) }))
        .filter((view) => view.cases.length > 0);
    }
    return rows;
  }, [views, gap, caseFilter]);

  const askForCase = (item: CaseView) =>
    setRequest({ anchor: { caseId: item.caseId }, label: SC.caseAnchor(item.caseId), title: item.title });
  const askForBlock = (row: CoverageRow) => {
    const heading = row.block.heading || row.block.text.slice(0, 60);
    setRequest({ anchor: { blockId: row.block.id }, label: SC.blockAnchor(heading), title: heading });
  };

  const truncated = testsState.data && testsState.data.items.length < testsState.data.total;

  return (
    <>
      {/* ── підсумок ── */}
      {coverageState.data && (
        <div className="grid grid-kpi trace-kpis">
          <Kpi
            label={SC.trace.kpiBlocks}
            value={SC.trace.of(stats.blocksWithCases, stats.blocks)}
            note={SC.trace.kpiBlocksNote(stats.blockGaps)}
          />
          <Kpi
            label={SC.trace.kpiCases}
            value={testsKnown ? SC.trace.of(stats.casesWithTests, stats.cases) : S.common.none}
            note={testsKnown ? SC.trace.kpiCasesNote(stats.casesNoTests) : undefined}
          />
          <Kpi
            label={SC.trace.kpiFailed}
            value={testsKnown ? <span className={stats.failedTests ? 'trace-bad' : undefined}>{stats.failedTests}</span> : S.common.none}
            note={
              testsKnown ? (
                <span className="col" style={{ gap: 'var(--sp-1)' }}>
                  <SummaryBar summary={stats.bar} />
                  <span>{SC.trace.kpiFailedNote(stats.failedCases)}</span>
                </span>
              ) : undefined
            }
          />
          <Kpi
            label={SC.trace.kpiOrphans}
            value={testsKnown ? stats.orphans : S.common.none}
            note={
              <Link to="/coverage?tab=tests&nocase=1">
                {SC.trace.kpiOrphansNote} →
              </Link>
            }
          />
        </div>
      )}

      <section className="card">
        <div className="card-head">
          <h2>{SC.trace.title}</h2>
          <span className="spacer" />
          <span className="muted text-xs">{SC.trace.hint}</span>
        </div>

        <div className="filters">
          <SelectField
            label={SC.trace.gapFilter}
            value={gap}
            onChange={(next) => params.set({ gap: next || null }, true)}
            options={[
              { value: 'no-cases', label: SC.trace.gapNoCases(stats.blockGaps) },
              { value: 'no-tests', label: SC.trace.gapNoTests(stats.casesNoTests) },
              { value: 'failed', label: SC.trace.gapFailed(stats.failedTests) },
            ]}
            allLabel={SC.trace.gapAll}
          />
          {sources.length > 1 && (
            <SelectField
              label={SC.trace.source}
              value={sourceId}
              onChange={(next) => params.set({ source: next || null }, true)}
              options={sources.map((item) => ({ value: item.id, label: item.title }))}
              allLabel={SC.trace.sourceAll}
            />
          )}
          {caseFilter && (
            <div className="row-wrap trace-case-filter">
              <Chip tone="accent" mono>
                {SC.trace.caseFilter(caseFilter)}
              </Chip>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => params.set({ case: null }, true)}>
                {SC.trace.caseFilterReset}
              </button>
            </div>
          )}
        </div>

        {testsState.error && !testsKnown && (
          <div className="card-body tight">
            <ErrorState compact message={`${SC.trace.testsError} ${testsState.error}`} status={testsState.status} onRetry={testsState.reload} />
          </div>
        )}
        {truncated && testsState.data && (
          <div className="card-body tight">
            <div className="alert">{SC.trace.truncated(testsState.data.items.length, testsState.data.total)}</div>
          </div>
        )}

        <Async state={coverageState} skeletonRows={6}>
          {(data) =>
            data.rows.length === 0 ? (
              <Empty title={S.empty.coverage} hint={S.empty.coverageHint} />
            ) : testsState.loading && !testsKnown ? (
              <Loading rows={6} />
            ) : visible.length === 0 ? (
              <Empty title={SC.trace.emptyFilter} hint={SC.trace.emptyFilterHint} />
            ) : (
              <ul className="trace-list">
                {visible.map((view) => (
                  <TraceRow
                    key={view.row.block.id}
                    view={view}
                    repo={repo}
                    sourceTitle={sources.length > 1 ? sourceTitle.get(view.row.block.sourceId) : undefined}
                    testsKnown={testsKnown}
                    onAskBlock={() => askForBlock(view.row)}
                    onAskCase={askForCase}
                  />
                ))}
              </ul>
            )
          }
        </Async>
      </section>

      {request && (
        <RequestTaskDialog
          projectId={projectId}
          anchor={request.anchor}
          anchorLabel={request.label}
          defaultTitle={request.title}
          onClose={() => setRequest(null)}
        />
      )}
    </>
  );
}

function TraceRow({
  view,
  repo,
  sourceTitle,
  testsKnown,
  onAskBlock,
  onAskCase,
}: {
  view: RowView;
  repo?: string;
  sourceTitle?: string;
  testsKnown: boolean;
  onAskBlock: () => void;
  onAskCase: (item: CaseView) => void;
}) {
  const { block } = view.row;
  const heading = block.heading || block.id;
  return (
    <li className={`trace-row${view.noCases ? ' gap' : ''}`}>
      <div className="trace-req">
        <div className="row-wrap">
          <strong className="trace-req-title">{heading}</strong>
          {block.changeState !== 'same' && (
            <Chip tone={block.changeState === 'removed' ? 'bad' : block.changeState === 'changed' ? 'warn' : 'accent'}>
              {CHANGE_LABEL[block.changeState]}
            </Chip>
          )}
        </div>
        <p className="text-sm trace-req-text">{block.text}</p>
        {sourceTitle && <span className="muted text-xs">{sourceTitle}</span>}
      </div>

      <div className="trace-cases">
        {view.noCases ? (
          <div className="trace-gap">
            <div className="row-wrap">
              <Chip tone="warn">{SC.trace.noCases}</Chip>
              <span className="spacer" />
              <button
                type="button"
                className="btn btn-sm"
                onClick={onAskBlock}
                aria-label={`${SC.requestTest}: ${heading}`}
              >
                {SC.requestTest}
              </button>
            </div>
            <p className="muted text-xs">{SC.trace.noCasesHint}</p>
          </div>
        ) : (
          <ul className="trace-case-list">
            {view.cases.map((item) => (
              <li
                key={item.caseId}
                className={`trace-case${item.noTests ? ' no-tests' : ''}${item.failed ? ' failed' : ''}`}
              >
                <div className="trace-case-head">
                  <Link className="mono text-xs trace-case-id" to={`/cases?case=${encodeURIComponent(item.caseId)}`}>
                    {item.caseId}
                  </Link>
                  <span className="text-sm trace-case-title">{item.title}</span>
                  {item.kind === 'derived' && <Chip tone="warn">{SC.trace.derived}</Chip>}
                  {item.noTests && <Chip tone="warn">{SC.trace.noTests}</Chip>}
                  {item.failed && <Chip tone="bad">{SC.trace.failedChip}</Chip>}
                  {item.noTests && (
                    <button
                      type="button"
                      className="btn btn-sm trace-ask"
                      onClick={() => onAskCase(item)}
                      aria-label={`${SC.requestTest}: ${item.caseId}`}
                    >
                      {SC.requestTest}
                    </button>
                  )}
                </div>
                {testsKnown && item.tests.length > 0 && (
                  <ul className="trace-tests">
                    {item.tests.map((test) => (
                      <li key={test.id} className={`trace-test${isFailed(test) ? ' failed' : ''}`}>
                        <TestLevelChip level={test.level} />
                        <TestAuthorChip author={test.author} />
                        <span className="trace-test-main">
                          <FileLink file={test.file} repo={repo} />
                          <span className="text-xs muted trace-test-name">{test.name}</span>
                        </span>
                        <span className="trace-test-result">
                          {test.state !== 'active' && <TestStateChip state={test.state} />}
                          <TestResultChip test={test} />
                          <CommitRef test={test} repo={repo} />
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}
