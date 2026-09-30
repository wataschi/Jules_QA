/**
 * Щільна таблиця кейсів: вибір чекбоксами, сортування колонок (у query),
 * курсор рядка для клавіш j / k, моноширинні ID.
 */

import { useEffect, useRef } from 'react';
import { AutomationChip, CaseStatusChip, KindChip, PriorityChip, ItemStatusChip } from '../../components/ui';
import { S } from '../../strings';
import type { CaseListItem } from '../../types';
import { formatAgo, formatDateTime } from '../../utils/format';

export interface SortState {
  key: string;
  desc: boolean;
}

const COLUMNS: Array<{ key: string; label: string; sortable: boolean }> = [
  { key: 'id', label: S.cases.colId, sortable: true },
  { key: 'title', label: S.cases.colTitle, sortable: true },
  { key: 'section', label: S.cases.colSection, sortable: false },
  { key: 'kind', label: S.cases.colKind, sortable: false },
  { key: 'priority', label: S.cases.colPriority, sortable: true },
  { key: 'status', label: S.cases.colStatus, sortable: false },
  { key: 'automation', label: S.cases.colAutomation, sortable: false },
  { key: 'tags', label: S.cases.colTags, sortable: false },
  { key: 'coverage', label: S.cases.colCoverage, sortable: false },
  { key: 'lastResult', label: S.cases.colLastResult, sortable: false },
  { key: 'updatedAt', label: S.cases.colUpdated, sortable: true },
];

export default function CaseTable({
  items,
  selected,
  cursor,
  activeId,
  sort,
  onSort,
  onToggle,
  onToggleAll,
  onOpen,
}: {
  items: CaseListItem[];
  selected: Set<string>;
  cursor: number;
  activeId: string;
  sort: SortState;
  onSort: (key: string) => void;
  onToggle: (id: string) => void;
  onToggleAll: (checked: boolean) => void;
  onOpen: (id: string, index: number) => void;
}) {
  const allChecked = items.length > 0 && items.every((item) => selected.has(item.id));

  /*
   * Курсор має бути видно. Без цього j/k і стрілки рухали підсвітку за межі
   * вікна — на 50 рядках сторінки виглядало так, наче клавіші не працюють.
   * `block: 'nearest'` не смикає сторінку, коли рядок і так на екрані.
   */
  const cursorRow = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    cursorRow.current?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  return (
    <div className="table-wrap">
      <table className="tbl tbl-cases">
        <thead>
          <tr>
            <th scope="col" className="col-check">
              <input
                type="checkbox"
                checked={allChecked}
                onChange={(event) => onToggleAll(event.target.checked)}
                aria-label={S.common.selectAll}
              />
            </th>
            {COLUMNS.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={`col-${column.key}`}
                aria-sort={
                  sort.key === column.key ? (sort.desc ? 'descending' : 'ascending') : undefined
                }
              >
                {column.sortable ? (
                  <button type="button" className="th-sort" onClick={() => onSort(column.key)}>
                    {column.label}
                    {sort.key === column.key && (
                      <span className="th-sort-glyph" aria-hidden="true">
                        {sort.desc ? '▼' : '▲'}
                      </span>
                    )}
                  </button>
                ) : (
                  column.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => {
            const atCursor = index === cursor;
            const classes = [
              selected.has(item.id) ? 'selected' : '',
              atCursor ? 'cursor' : '',
              item.id === activeId ? 'selected' : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <tr
                key={item.id}
                className={classes}
                ref={atCursor ? cursorRow : undefined}
                onClick={() => onOpen(item.id, index)}
              >
                <td className="col-check" onClick={(event) => event.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selected.has(item.id)}
                    onChange={() => onToggle(item.id)}
                    aria-label={`${S.common.selectRow}: ${item.id}`}
                  />
                </td>
                <td className="cell-id col-id">{item.id}</td>
                <td className="cell-title col-title" title={item.title}>
                  {item.title}
                </td>
                <td className="cell-path muted text-xs col-section" title={item.sectionPath}>
                  {item.sectionPath}
                </td>
                <td className="col-kind">
                  <KindChip kind={item.kind} short />
                </td>
                <td className="col-priority">
                  <PriorityChip priority={item.priority} />
                </td>
                <td className="col-status">
                  <CaseStatusChip status={item.status} />
                </td>
                <td className="col-automation">
                  <AutomationChip status={item.automation.status} reason={item.automation.quarantineReason} short />
                </td>
                <td className="cell-tags col-tags">
                  <span className="row">
                    {item.tags.slice(0, 3).map((tag) => (
                      <span className="tag" key={tag}>
                        {tag}
                      </span>
                    ))}
                    {item.tags.length > 3 && <span className="muted text-xs">+{item.tags.length - 3}</span>}
                  </span>
                </td>
                <td className="mono text-xs nowrap col-coverage">
                  {item.coverage.quote + item.coverage.derived === 0 ? (
                    S.common.none
                  ) : (
                    <>
                      {item.coverage.quote}/{item.coverage.derived}
                    </>
                  )}
                </td>
                <td className="col-lastResult">{item.lastResult ? <ItemStatusChip status={item.lastResult.status} /> : S.common.none}</td>
                <td className="nowrap muted text-xs col-updatedAt" title={formatDateTime(item.updatedAt)}>
                  {formatAgo(item.updatedAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
