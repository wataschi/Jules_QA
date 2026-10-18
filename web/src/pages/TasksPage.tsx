/**
 * Задачі агентів розробників: запити QA, план модулів, прочитання картинок,
 * розбір падінь і питання до людей. QA тут бачить, що чекає його рішення,
 * що лежить у черзі задовго і хто власник. Усі фільтри — в адресі.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Async } from '../components/states';
import { CheckField, PageHead, Pager, SelectField, Tabs } from '../components/ui';
import { useApp } from '../context/AppContext';
import { useAsync, useResource } from '../hooks/useAsync';
import { clampIndex, useKeyMap } from '../hooks/useKeyboard';
import { useQueryParams } from '../hooks/useQueryParams';
import { S2 } from '../strings-v2';
import type { Task, TaskKind } from '../types';
import { ALL_KINDS, ALL_STATES, DEFAULT_STALE_HOURS, parseStates } from './tasks/bits';
import { NewRequestDialog, flattenSections } from './tasks/NewRequestDialog';
import { T } from './tasks/strings';
import { TaskTable } from './tasks/TaskTable';
import '../styles/tasks.css';

const LIMIT = 50;

/** Швидкі вкладки — це просто готові значення фільтрів «стан» і «вид». */
const TABS = [
  { value: 'active', label: T.list.tabActive, state: '', kind: '' },
  { value: 'decide', label: T.list.tabDecide, state: 'review,needs_info', kind: '' },
  { value: 'agents', label: T.list.tabAgents, state: 'queued,claimed', kind: '' },
  { value: 'questions', label: T.list.tabQuestions, state: '', kind: 'question' },
  { value: 'all', label: T.list.tabAll, state: 'all', kind: '' },
] as const;

export default function TasksPage() {
  const { projectId, project } = useApp();
  const params = useQueryParams();
  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);

  const stateRaw = params.get('state');
  const kindRaw = params.get('kind');
  const moduleId = params.get('module');
  const mine = params.getBool('mine');
  const urlQuery = params.get('q');
  const page = params.getNum('page', 1);

  const states = parseStates(stateRaw);
  const kinds = kindRaw
    .split(',')
    .filter((item): item is TaskKind => (ALL_KINDS as string[]).includes(item));
  const staleHours = project?.settings?.thresholds?.staleTaskHours ?? DEFAULT_STALE_HOURS;

  /* пошук: чернетка в полі, в адресу — із затримкою */
  const [searchDraft, setSearchDraft] = useState(urlQuery);
  useEffect(() => setSearchDraft(urlQuery), [urlQuery]);
  useEffect(() => {
    if (searchDraft === urlQuery) return;
    const timer = window.setTimeout(() => params.set({ q: searchDraft || null, page: null }, true), 350);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft]);

  const listState = useResource(
    (signal) =>
      api.listTasks(
        {
          projectId,
          state: states === 'all' ? undefined : states,
          kind: kinds.length ? kinds : undefined,
          sectionId: moduleId || undefined,
          mine: mine || undefined,
          q: urlQuery || undefined,
          page,
          limit: LIMIT,
        },
        signal,
      ),
    [projectId, stateRaw, kindRaw, moduleId, mine, urlQuery, page],
    { enabled: Boolean(projectId), pollMs: 30_000 },
  );

  const sections = useAsync((signal) => api.listSections(projectId, signal), [projectId], Boolean(projectId));
  const moduleOptions = useMemo(() => flattenSections(sections.data ?? []), [sections.data]);

  const items = listState.data?.items ?? [];
  const [cursor, setCursor] = useState(0);
  const [creating, setCreating] = useState(false);
  useEffect(() => setCursor(0), [stateRaw, kindRaw, moduleId, mine, urlQuery, page]);

  const activeTab = TABS.find((tab) => tab.state === stateRaw && tab.kind === kindRaw)?.value ?? '';

  const openTask = useCallback(
    (id: string, index: number) => {
      setCursor(index);
      navigate(`/tasks/${encodeURIComponent(id)}`);
    },
    [navigate],
  );

  useKeyMap(
    {
      '/': (event) => {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      },
      j: () => setCursor((c) => clampIndex(c + 1, items.length)),
      k: () => setCursor((c) => clampIndex(c - 1, items.length)),
      ArrowDown: (event) => {
        if (!items.length) return;
        event.preventDefault();
        setCursor((c) => clampIndex(c + 1, items.length));
      },
      ArrowUp: (event) => {
        if (!items.length) return;
        event.preventDefault();
        setCursor((c) => clampIndex(c - 1, items.length));
      },
      Enter: (event) => {
        // Enter на посиланні чи кнопці — їхня власна дія.
        if (event.target instanceof HTMLElement && event.target.closest('a, button')) return;
        const item = items[cursor];
        if (item) openTask(item.id, cursor);
      },
    },
    { enabled: !creating },
  );

  const stateOptions = useMemo(() => {
    const base = [
      { value: '', label: T.list.stateActive },
      { value: 'all', label: T.list.stateAll },
      ...ALL_STATES.map((value) => ({ value, label: S2.taskState[value] })),
    ];
    if (stateRaw && !base.some((option) => option.value === stateRaw) && states !== 'all') {
      base.splice(2, 0, { value: stateRaw, label: states.map((state) => S2.taskState[state]).join(' + ') });
    }
    return base;
  }, [stateRaw, states]);

  function pickTab(value: string) {
    const tab = TABS.find((item) => item.value === value);
    if (!tab) return;
    params.set({ state: tab.state || null, kind: tab.kind || null, page: null });
  }

  function onCreated(task: Task) {
    // Новий запит — у черзі. Якщо поточний вид черги не показує, перемикаємось на активні.
    const showsQueued = (states === 'all' || states.includes('queued')) && (!kinds.length || kinds.includes(task.kind));
    if (!showsQueued) params.set({ state: null, kind: null, page: null });
    listState.reload();
  }

  const emptyDecide = activeTab === 'decide';

  return (
    <>
      <PageHead
        title={T.list.title}
        sub={T.list.sub}
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)} disabled={!projectId}>
            + {T.list.newRequest}
          </button>
        }
      />

      <section className="card tasks-list">
        <Tabs tabs={TABS.map(({ value, label }) => ({ value, label }))} active={activeTab} onPick={pickTab} label={T.list.tabsLabel} />

        <div className="filters">
          <SelectField
            label={T.list.filterState}
            value={stateRaw}
            onChange={(next) => params.set({ state: next || null, page: null })}
            options={stateOptions}
          />
          <SelectField
            label={T.list.filterKind}
            value={kindRaw}
            onChange={(next) => params.set({ kind: next || null, page: null })}
            options={ALL_KINDS.map((value) => ({ value, label: S2.taskKind[value] }))}
            allLabel={T.list.kindAll}
          />
          <SelectField
            label={T.list.filterModule}
            value={moduleId}
            onChange={(next) => params.set({ module: next || null, page: null })}
            options={moduleOptions.map((option) => ({ value: option.id, label: option.label }))}
            allLabel={T.list.moduleAll}
          />
          <div className="field grow">
            <label htmlFor="task-search">{T.list.search}</label>
            <input
              id="task-search"
              ref={searchRef}
              type="search"
              value={searchDraft}
              placeholder={T.list.searchPlaceholder}
              onChange={(event) => setSearchDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') event.currentTarget.blur();
              }}
            />
          </div>
          <div className="tasks-mine">
            <CheckField label={T.list.mine} checked={mine} onChange={(next) => params.set({ mine: next || null, page: null })} />
          </div>
        </div>

        <Async
          state={listState}
          skeletonRows={6}
          empty={
            emptyDecide
              ? { title: T.list.emptyDecide, hint: T.list.emptyDecideHint }
              : {
                  title: T.list.empty,
                  hint: T.list.emptyHint,
                  action: (
                    <button type="button" className="btn btn-sm" onClick={() => setCreating(true)}>
                      + {T.list.newRequest}
                    </button>
                  ),
                }
          }
        >
          {(data) => (
            <>
              <TaskTable items={data.items} cursor={cursor} staleHours={staleHours} onOpen={openTask} />
              <Pager
                page={data.page || page}
                limit={data.limit || LIMIT}
                total={data.total}
                onPage={(next) => params.set({ page: next === 1 ? null : next })}
              />
            </>
          )}
        </Async>
        <p className="tasks-keys text-xs muted">{T.list.keysHint}</p>
      </section>

      {creating && (
        <NewRequestDialog
          projectId={projectId}
          defaultSectionId={moduleId}
          onClose={() => setCreating(false)}
          onCreated={onCreated}
        />
      )}
    </>
  );
}
