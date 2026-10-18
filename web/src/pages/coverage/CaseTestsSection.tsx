/**
 * Розділ «Тести в коді» в деталях кейса: які тести реалізують кейс, на якому
 * рівні, хто їх написав і чим закінчився останній прогін. Якщо тестів нема —
 * пояснення і «Попросити тест»; якщо є — можна попросити ще один чи змінити.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { RequestTaskDialog } from '../../components/RequestTaskDialog';
import { ErrorState, Loading } from '../../components/states';
import { useApp } from '../../context/AppContext';
import { useAsync } from '../../hooks/useAsync';
import type { TaskKind } from '../../types';
import { SC } from './strings';
import { CommitRef, FileLink, TestAuthorChip, TestLevelChip, TestResultChip, TestStateChip } from './TestBits';

export function CaseTestsSection({ caseId, caseTitle }: { caseId: string; caseTitle: string }) {
  const { projectId, project } = useApp();
  const repo = project?.repo;
  const state = useAsync(
    (signal) => api.listTests({ projectId, caseId, limit: 100 }, signal),
    [projectId, caseId],
    Boolean(projectId && caseId),
  );
  const [request, setRequest] = useState<TaskKind | null>(null);
  const tests = state.data?.items ?? [];

  return (
    <div className="case-tests" aria-labelledby={`case-tests-${caseId}`}>
      <div className="row">
        <h3 id={`case-tests-${caseId}`} className="muted text-xs">
          {SC.caseTests.title}
          {state.data ? ` · ${state.data.total}` : ''}
        </h3>
        <span className="spacer" />
        {state.data && tests.length > 0 && (
          <>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRequest('change_test')}>
              {SC.changeTest}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setRequest('add_test')}>
              {SC.requestTest}
            </button>
          </>
        )}
      </div>

      {state.loading && state.data === undefined ? (
        <Loading rows={2} />
      ) : state.error && state.data === undefined ? (
        <ErrorState compact message={state.error} status={state.status} onRetry={state.reload} />
      ) : tests.length === 0 ? (
        <div className="case-tests-empty">
          <p className="text-sm">{SC.caseTests.none}</p>
          <p className="muted text-xs">{SC.caseTests.noneHint}</p>
          <div>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setRequest('add_test')}>
              {SC.requestTest}
            </button>
          </div>
        </div>
      ) : (
        <>
          <ul className="trace-tests case-tests-list">
            {tests.map((test) => (
              <li key={test.id} className={`trace-test${test.lastResult?.status === 'failed' ? ' failed' : ''}`}>
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
          <p className="muted text-xs">
            {SC.caseTests.moreHint}{' '}
            <Link to={`/coverage?tab=tests&q=${encodeURIComponent(caseId)}`}>{SC.caseTests.showAll} →</Link>
          </p>
        </>
      )}

      {request && (
        <RequestTaskDialog
          projectId={projectId}
          anchor={{ caseId }}
          anchorLabel={SC.caseAnchor(caseId)}
          defaultKind={request}
          defaultTitle={caseTitle}
          onClose={() => setRequest(null)}
        />
      )}
    </div>
  );
}
