/**
 * Реєстр — три панелі: дерево секцій, таблиця кейсів, деталі кейса.
 *
 * Усі фільтри, сортування, сторінка й вибраний кейс живуть у query-параметрах:
 *   ?section=&subs=0&tag=&kind=&priority=&status=&automation=&q=&sort=&page=&case=
 * Тому будь-який вид можна переслати посиланням.
 *
 * Клавіатура: `/` — фокус у пошук, `j`/`k` — рух по рядках, `space` — вибір
 * рядка, `Enter` — відкрити деталі, `Esc` — закрити деталі/діалог.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { Async, Empty, ErrorState, Loading } from '../components/states';
import { Pager, PageHead, SelectField, TextField } from '../components/ui';
import { useApp } from '../context/AppContext';
import { useAsync, useResource } from '../hooks/useAsync';
import { clampIndex, useKeyMap } from '../hooks/useKeyboard';
import { useQueryParams } from '../hooks/useQueryParams';
import {
  S,
  automationStatusLabel,
  caseKindLabel,
  casePriorityLabel,
  caseStatusLabel,
} from '../strings';
import type { AutomationStatus, CaseKind, CasePriority, CaseStatus } from '../types';
import { AUTOMATION_STATUSES, CASE_KINDS, CASE_PRIORITIES, CASE_STATUSES } from '../types';
import { CheckField } from '../components/ui';
import {
  BulkBar,
  CreateRunDialog,
  ExportDialog,
  SimpleBulkDialog,
  flattenSections,
  type BulkDialogKind,
} from './cases/BulkActions';
import CaseDetailPanel from './cases/CaseDetailPanel';
import CaseTable, { type SortState } from './cases/CaseTable';
import ReplaceTextDialog from './cases/ReplaceTextDialog';
import SectionTree from './cases/SectionTree';

const LIMIT = 50;

export default function CasesPage() {
  const { projectId, project } = useApp();
  const params = useQueryParams();
  const searchRef = useRef<HTMLInputElement>(null);

  /* ── стан з адреси ── */
  const sectionId = params.get('section');
  const includeSubsections = params.getBool('subs', true);
  const tags = params.getList('tag');
  const kind = params.get('kind');
  const priority = params.get('priority');
  const status = params.get('status');
  const automation = params.get('automation');
  const sortRaw = params.getOr('sort', 'id');
  const page = params.getNum('page', 1);
  const activeCaseId = params.get('case');

  const sort: SortState = useMemo(
    () => ({ key: sortRaw.replace(/^-/, ''), desc: sortRaw.startsWith('-') }),
    [sortRaw],
  );

  /* Пошук набирається локально, в адресу йде з паузою — щоб не смикати бекенд. */
  const [searchDraft, setSearchDraft] = useState(params.get('q'));
  const urlQuery = params.get('q');
  useEffect(() => setSearchDraft(urlQuery), [urlQuery]);
  useEffect(() => {
    if (searchDraft === urlQuery) return;
    const timer = window.setTimeout(() => params.set({ q: searchDraft || null, page: null }, true), 350);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft]);

  /* ── дані ── */
  const sectionsState = useAsync((signal) => api.listSections(projectId, signal), [projectId], Boolean(projectId));

  const casesState = useResource(
    (signal) =>
      api.listCases(
        {
          projectId,
          sectionId: sectionId || undefined,
          includeSubsections,
          tag: tags.length ? tags : undefined,
          kind: (kind || undefined) as CaseKind | undefined,
          priority: (priority || undefined) as CasePriority | undefined,
          status: (status || undefined) as CaseStatus | undefined,
          automation: (automation || undefined) as AutomationStatus | undefined,
          q: urlQuery || undefined,
          sort: sortRaw,
          page,
          limit: LIMIT,
        },
        signal,
      ),
    [projectId, sectionId, includeSubsections, tags.join(','), kind, priority, status, automation, urlQuery, sortRaw, page],
    { enabled: Boolean(projectId), pollMs: 60_000 },
  );

  const items = casesState.data?.items ?? [];

  /* ── вибір і курсор ── */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [dialog, setDialog] = useState<BulkDialogKind>(null);

  useEffect(() => setCursor(0), [page, sectionId, sortRaw, urlQuery]);

  const toggleOne = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(
    (checked: boolean) => {
      setSelected((current) => {
        const next = new Set(current);
        for (const item of items) {
          if (checked) next.add(item.id);
          else next.delete(item.id);
        }
        return next;
      });
    },
    [items],
  );

  const openCase = useCallback(
    (id: string, index: number) => {
      setCursor(index);
      params.set({ case: id }, true);
    },
    [params],
  );

  const closeDetail = useCallback(() => params.set({ case: null }, true), [params]);

  /* ── клавіатура ── */
  useKeyMap({
    '/': (event) => {
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    },
    // Стрілки працюють нарівні з j/k: vim-звички має не кожен тестувальник,
    // а заготовка `ArrowDown: undefined` роками нічого не робила.
    j: () => setCursor((c) => clampIndex(c + 1, items.length)),
    k: () => setCursor((c) => clampIndex(c - 1, items.length)),
    ArrowDown: (event) => {
      event.preventDefault();
      setCursor((c) => clampIndex(c + 1, items.length));
    },
    ArrowUp: (event) => {
      event.preventDefault();
      setCursor((c) => clampIndex(c - 1, items.length));
    },
    ' ': (event) => {
      const item = items[cursor];
      if (!item) return;
      event.preventDefault();
      toggleOne(item.id);
    },
    Enter: () => {
      const item = items[cursor];
      if (item) openCase(item.id, cursor);
    },
    Escape: () => {
      if (dialog) setDialog(null);
      else if (activeCaseId) closeDetail();
    },
  });

  function onSort(key: string) {
    const next = sort.key === key && !sort.desc ? `-${key}` : key;
    params.set({ sort: next === 'id' ? null : next, page: null });
  }

  function resetFilters() {
    params.set({
      section: null,
      subs: null,
      tag: null,
      kind: null,
      priority: null,
      status: null,
      automation: null,
      q: null,
      sort: null,
      page: null,
    });
    setSearchDraft('');
  }

  const selectedIds = useMemo(() => Array.from(selected), [selected]);
  /*
   * Вибір навмисно переживає зміну фільтра й сторінки — зібрати набір із різних
   * секцій це нормальний сценарій. Але мовчазний вибір, якого не видно на
   * екрані, — пастка перед масовою дією, тож рахуємо його і показуємо явно.
   */
  const offPageCount = useMemo(
    () => selectedIds.filter((id) => !items.some((item) => item.id === id)).length,
    [selectedIds, items],
  );
  const sections = sectionsState.data ?? [];
  const sectionOptions = useMemo(() => flattenSections(sections), [sections]);
  const totalCases = useMemo(
    () => sections.reduce((sum, node) => sum + node.caseCountDeep, 0),
    [sections],
  );

  const currentFilter = {
    sectionIds: sectionId ? [sectionId] : undefined,
    includeSubsections,
    tags: tags.length ? tags : undefined,
    kinds: kind ? [kind as CaseKind] : undefined,
    priorities: priority ? [priority as CasePriority] : undefined,
    statuses: status ? [status as CaseStatus] : undefined,
    automation: automation ? [automation as AutomationStatus] : undefined,
    q: urlQuery || undefined,
  };

  return (
    <>
      <PageHead
        title={S.cases.title}
        sub={S.cases.sub}
        actions={
          <button type="button" className="btn btn-sm" onClick={resetFilters}>
            {S.common.resetFilters}
          </button>
        }
      />

      <div className={`registry${activeCaseId ? ' with-detail' : ''}`}>
        {/* ── панель 1: дерево секцій ── */}
        <section className="card" aria-label={S.cases.tree}>
          <div className="card-head">
            <h2>{S.cases.tree}</h2>
          </div>
          {sectionsState.loading && sectionsState.data === undefined ? (
            <Loading rows={5} />
          ) : sectionsState.error && sectionsState.data === undefined ? (
            <ErrorState
              message={sectionsState.error}
              status={sectionsState.status}
              onRetry={sectionsState.reload}
            />
          ) : sections.length === 0 ? (
            <Empty title={S.empty.tree} hint={S.empty.treeHint} />
          ) : (
            <>
              <SectionTree
                tree={sections}
                activeId={sectionId}
                totalCases={totalCases}
                onPick={(id) => params.set({ section: id || null, page: null })}
              />
              <div style={{ padding: 'var(--sp-2) var(--sp-3)', borderTop: '1px solid var(--border)' }}>
                <CheckField
                  label={S.cases.includeSubsections}
                  checked={includeSubsections}
                  onChange={(on) => params.set({ subs: on ? null : '0', page: null })}
                />
              </div>
            </>
          )}
        </section>

        {/* ── панель 2: таблиця ── */}
        <section className="card" aria-label={S.cases.title}>
          <div className="filters">
            <div className="field grow">
              <label htmlFor="case-search">{S.cases.filterQ}</label>
              <input
                id="case-search"
                ref={searchRef}
                type="search"
                value={searchDraft}
                placeholder={S.common.searchPlaceholder}
                onChange={(event) => setSearchDraft(event.target.value)}
              />
            </div>
            <SelectField
              label={S.cases.filterSection}
              value={sectionId}
              onChange={(next) => params.set({ section: next || null, page: null })}
              options={sectionOptions}
              allLabel={S.common.all}
            />
            <SelectField
              label={S.cases.filterKind}
              value={kind}
              onChange={(next) => params.set({ kind: next || null, page: null })}
              options={CASE_KINDS.map((value) => ({ value, label: caseKindLabel[value] }))}
              allLabel={S.common.all}
            />
            <SelectField
              label={S.cases.filterPriority}
              value={priority}
              onChange={(next) => params.set({ priority: next || null, page: null })}
              options={CASE_PRIORITIES.map((value) => ({ value, label: casePriorityLabel[value] }))}
              allLabel={S.common.all}
            />
            <SelectField
              label={S.cases.filterStatus}
              value={status}
              onChange={(next) => params.set({ status: next || null, page: null })}
              options={CASE_STATUSES.map((value) => ({ value, label: caseStatusLabel[value] }))}
              allLabel={S.common.all}
            />
            <SelectField
              label={S.cases.filterAutomation}
              value={automation}
              onChange={(next) => params.set({ automation: next || null, page: null })}
              options={AUTOMATION_STATUSES.map((value) => ({ value, label: automationStatusLabel[value] }))}
              allLabel={S.common.all}
            />
            <TextField
              label={S.cases.filterTags}
              value={tags.join(', ')}
              onChange={(next) =>
                params.set(
                  { tag: next.split(',').map((tag) => tag.trim()).filter(Boolean), page: null },
                  true,
                )
              }
              mono
            />
          </div>

          {selectedIds.length > 0 && (
            <BulkBar
              count={selectedIds.length}
              offPageCount={offPageCount}
              onOpen={setDialog}
              onClear={() => setSelected(new Set())}
            />
          )}

          <Async
            state={casesState}
            skeletonRows={8}
            empty={{ title: S.empty.cases, hint: S.empty.casesHint }}
          >
            {(data) => (
              <>
                <CaseTable
                  items={data.items}
                  selected={selected}
                  cursor={cursor}
                  activeId={activeCaseId}
                  sort={sort}
                  onSort={onSort}
                  onToggle={toggleOne}
                  onToggleAll={toggleAll}
                  onOpen={openCase}
                />
                <Pager
                  page={data.page || page}
                  limit={data.limit || LIMIT}
                  total={data.total}
                  onPage={(next) => params.set({ page: next === 1 ? null : next })}
                />
              </>
            )}
          </Async>
        </section>

        {/* ── панель 3: деталі ── */}
        {activeCaseId && (
          <CaseDetailPanel caseId={activeCaseId} onClose={closeDetail} onSaved={casesState.reload} />
        )}
      </div>

      {/* ── діалоги масових дій ── */}
      {dialog === 'replace' && (
        <ReplaceTextDialog
          projectId={projectId}
          caseIds={selectedIds}
          filter={currentFilter}
          onClose={() => setDialog(null)}
          onApplied={casesState.reload}
        />
      )}
      {dialog && ['priority', 'kind', 'status', 'tag', 'move', 'automation'].includes(dialog) && (
        <SimpleBulkDialog
          kind={dialog as 'priority' | 'kind' | 'status' | 'tag' | 'move' | 'automation'}
          projectId={projectId}
          caseIds={selectedIds}
          sections={sections}
          onClose={() => setDialog(null)}
          onApplied={casesState.reload}
        />
      )}
      {dialog === 'run' && (
        /*
         * Адресу не підставляємо. Заповнене поле закріплює середовище і
         * перекриває власну ціль кожного сценарію — підставлений «за
         * замовчуванням» URL тихо відправляв би весь прогін не туди.
         */
        <CreateRunDialog projectId={projectId} caseIds={selectedIds} onClose={() => setDialog(null)} />
      )}
      {dialog === 'export' && (
        <ExportDialog projectId={projectId} caseIds={selectedIds} onClose={() => setDialog(null)} />
      )}
    </>
  );
}
