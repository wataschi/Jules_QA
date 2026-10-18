/**
 * «Тести в коді»: що лежить у репозиторії продукту — файл, назва, кейси,
 * рівень, автор, стан і останній результат на CI. Фільтри живуть в адресі.
 *
 * Окремий акцент — тести без кейса: агент чи людина перевірили те, чого
 * ніхто не просив, і в покритті вимог такого тесту не видно.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Async } from '../../components/states';
import { CheckField, Chip, Pager, SelectField, TextField } from '../../components/ui';
import { useToast } from '../../context/AppContext';
import { messageOf, useAsync } from '../../hooks/useAsync';
import type { QueryParams } from '../../hooks/useQueryParams';
import type { CodeTest } from '../../types';
import { SC } from './strings';
import {
  CommitRef,
  FileLink,
  TestAuthorChip,
  TestLevelChip,
  TestResultChip,
  TestStateChip,
  useCanManageTests,
} from './TestBits';

const LIMIT = 50;
const LEVELS: CodeTest['level'][] = ['unit', 'integration', 'e2e', 'visual'];
const FILTER_KEYS = ['level', 'nocase', 'failed', 'q', 'page'];

export function CodeTestsTab({ projectId, repo, params }: { projectId: string; repo?: string; params: QueryParams }) {
  const toast = useToast();
  const canManage = useCanManageTests();

  const rawLevel = params.get('level') as CodeTest['level'];
  const level = LEVELS.includes(rawLevel) ? rawLevel : undefined;
  const withoutCase = params.getBool('nocase');
  const failed = params.getBool('failed');
  const q = params.get('q');
  const page = params.getNum('page', 1);

  // Пошук пишемо в адресу з невеликою затримкою, щоб не смикати сервер на кожну літеру.
  const [search, setSearch] = useState(q);
  useEffect(() => setSearch(q), [q]);
  useEffect(() => {
    if (search === q) return;
    const timer = setTimeout(() => params.set({ q: search.trim() || null, page: null }, true), 300);
    return () => clearTimeout(timer);
  }, [search, q, params]);

  const [busyId, setBusyId] = useState<string | null>(null);

  const listState = useAsync(
    (signal) =>
      api.listTests(
        {
          projectId,
          level,
          withoutCase: withoutCase || undefined,
          status: failed ? 'failed' : undefined,
          q: q || undefined,
          page,
          limit: LIMIT,
        },
        signal,
      ),
    [projectId, level, withoutCase, failed, q, page],
    Boolean(projectId),
  );
  const orphansState = useAsync(
    (signal) => api.listTests({ projectId, withoutCase: true, limit: 1 }, signal),
    [projectId],
    Boolean(projectId),
  );
  const orphans = orphansState.data?.total ?? 0;
  const filtered = Boolean(level || withoutCase || failed || q);

  async function toggleQuarantine(test: CodeTest) {
    const next = test.state === 'quarantined' ? 'active' : 'quarantined';
    setBusyId(test.id);
    try {
      await api.setTestState(test.id, next);
      toast({ text: next === 'quarantined' ? SC.tests.quarantined : SC.tests.restored, tone: next === 'quarantined' ? 'warn' : 'good' });
      listState.reload();
    } catch (cause) {
      toast({ text: messageOf(cause), tone: 'bad' });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      {orphans > 0 && (
        <div className="alert warn tests-orphans" role="note">
          <span aria-hidden="true">◇</span>
          <div className="col" style={{ gap: 'var(--sp-1)' }}>
            <strong>{SC.tests.orphansTitle(orphans)}</strong>
            <span>{SC.tests.orphansText}</span>
            <span>
              {withoutCase ? (
                <span className="text-xs">{SC.tests.orphansShown}</span>
              ) : (
                <button type="button" className="btn btn-sm" onClick={() => params.set({ nocase: true, page: null })}>
                  {SC.tests.orphansShow}
                </button>
              )}
            </span>
          </div>
        </div>
      )}

      <section className="card">
        <div className="card-head">
          <h2>{SC.tests.title}</h2>
          <span className="spacer" />
          <span className="muted text-xs">{SC.tests.hint}</span>
        </div>

        <div className="filters">
          <TextField
            className="grow"
            type="search"
            label={SC.tests.search}
            value={search}
            onChange={setSearch}
            placeholder={SC.tests.searchPlaceholder}
          />
          <SelectField
            label={SC.tests.level}
            value={level ?? ''}
            onChange={(next) => params.set({ level: next || null, page: null }, true)}
            options={LEVELS.map((value) => ({ value, label: SC.level[value] }))}
            allLabel={SC.tests.levelAll}
          />
          <CheckField
            label={SC.tests.withoutCase}
            checked={withoutCase}
            onChange={(next) => params.set({ nocase: next, page: null }, true)}
          />
          <CheckField
            label={SC.tests.failed}
            checked={failed}
            onChange={(next) => params.set({ failed: next, page: null }, true)}
          />
          {filtered && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => params.clear(FILTER_KEYS)}>
              {SC.tests.reset}
            </button>
          )}
        </div>

        {!repo && (
          <div className="card-body tight">
            <p className="muted text-xs">{SC.tests.noRepo}</p>
          </div>
        )}

        <Async
          state={listState}
          skeletonRows={6}
          empty={
            filtered
              ? { title: SC.tests.emptyFilter, hint: SC.tests.emptyFilterHint }
              : { title: SC.tests.empty, hint: SC.tests.emptyHint }
          }
        >
          {(data) => (
            <>
              <div className="table-wrap">
                <table className="tbl tbl-tests">
                  <thead>
                    <tr>
                      <th scope="col">{SC.tests.colFile}</th>
                      <th scope="col">{SC.tests.colName}</th>
                      <th scope="col">{SC.tests.colCases}</th>
                      <th scope="col">{SC.tests.colLevel}</th>
                      <th scope="col">{SC.tests.colAuthor}</th>
                      <th scope="col">{SC.tests.colState}</th>
                      <th scope="col">{SC.tests.colResult}</th>
                      {canManage && (
                        <th scope="col">
                          <span className="visually-hidden">{SC.tests.colActions}</span>
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((test) => (
                      <tr
                        key={test.id}
                        className={`${test.caseIds.length === 0 ? 'test-orphan' : ''}${test.lastResult?.status === 'failed' ? ' test-failed' : ''}`}
                      >
                        <td className="cell-file">
                          <FileLink file={test.file} repo={repo} />
                        </td>
                        <td className="cell-name" title={test.fullName}>
                          {test.name}
                        </td>
                        <td>
                          {test.caseIds.length === 0 ? (
                            <Chip tone="warn">{SC.tests.noCase}</Chip>
                          ) : (
                            <span className="matrix-cases">
                              {test.caseIds.map((caseId) => (
                                <Link key={caseId} className="tag" to={`/cases?case=${encodeURIComponent(caseId)}`}>
                                  {caseId}
                                </Link>
                              ))}
                            </span>
                          )}
                        </td>
                        <td>
                          <TestLevelChip level={test.level} />
                        </td>
                        <td>
                          <TestAuthorChip author={test.author} />
                        </td>
                        <td>
                          <TestStateChip state={test.state} />
                        </td>
                        <td>
                          <span className="row-wrap" style={{ gap: 'var(--sp-1)' }}>
                            <TestResultChip test={test} />
                            <CommitRef test={test} repo={repo} />
                          </span>
                        </td>
                        {canManage && (
                          <td className="nowrap">
                            {(test.state === 'active' || test.state === 'quarantined') && (
                              <button
                                type="button"
                                className="btn btn-sm btn-ghost"
                                disabled={busyId === test.id}
                                onClick={() => void toggleQuarantine(test)}
                                aria-label={`${test.state === 'quarantined' ? SC.tests.restore : SC.tests.quarantine}: ${test.name}`}
                              >
                                {test.state === 'quarantined' ? SC.tests.restore : SC.tests.quarantine}
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.total > data.limit && (
                <Pager page={data.page} limit={data.limit} total={data.total} onPage={(next) => params.set({ page: next })} />
              )}
            </>
          )}
        </Async>
      </section>
    </>
  );
}
