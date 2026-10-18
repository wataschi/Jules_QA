/**
 * Таблиця задач: курсор рядка для j / k, вік задачі з підсвіткою після
 * порогу, PR — звичайним посиланням (клік по ньому не відкриває задачу).
 */
import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { PriorityChip } from '../../components/ui';
import { S2 } from '../../strings-v2';
import type { TaskListItem } from '../../types';
import { formatAgo, formatDateTime } from '../../utils/format';
import { TaskStateChip, formatWait, isOpenState } from './bits';
import { T } from './strings';

export function TaskTable({
  items,
  cursor,
  staleHours,
  onOpen,
}: {
  items: TaskListItem[];
  cursor: number;
  staleHours: number;
  onOpen: (id: string, index: number) => void;
}) {
  const cursorRow = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    cursorRow.current?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  return (
    <div className="table-wrap">
      <table className="tbl tbl-tasks">
        <thead>
          <tr>
            <th scope="col" className="col-id">{T.list.colId}</th>
            <th scope="col" className="col-kind">{T.list.colKind}</th>
            <th scope="col" className="col-title">{T.list.colTitle}</th>
            <th scope="col" className="col-module">{T.list.colModule}</th>
            <th scope="col" className="col-state">{T.list.colState}</th>
            <th scope="col" className="col-age" title={T.list.ageHint}>{T.list.colAge}</th>
            <th scope="col" className="col-owners">{T.list.colOwners}</th>
            <th scope="col" className="col-pr">{T.list.colPr}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => {
            const open = isOpenState(item.state);
            const stale = open && item.ageHours >= staleHours;
            const atCursor = index === cursor;
            return (
              <tr
                key={item.id}
                className={atCursor ? 'cursor' : undefined}
                ref={atCursor ? cursorRow : undefined}
                data-task-id={item.id}
                onClick={() => onOpen(item.id, index)}
              >
                <td className="cell-id col-id">
                  <Link
                    to={`/tasks/${encodeURIComponent(item.id)}`}
                    aria-label={T.list.openTask(item.id)}
                    onClick={(event) => event.stopPropagation()}
                  >
                    {item.id}
                  </Link>
                </td>
                <td className="col-kind text-xs">{S2.taskKind[item.kind]}</td>
                <td className="cell-title col-title" title={item.title}>
                  <span className="tasks-title-cell">
                    {item.priority === 'P1' && <PriorityChip priority={item.priority} />}
                    <span className="truncate">{item.title}</span>
                  </span>
                </td>
                <td className="col-module text-xs muted">{item.sectionName ?? '—'}</td>
                <td className="col-state">
                  <TaskStateChip state={item.state} />
                </td>
                <td className="col-age nowrap">
                  {open ? (
                    <span
                      className={`tasks-age${stale ? ' stale' : ''}`}
                      title={stale ? T.list.staleHint(staleHours) : formatDateTime(item.queuedAt)}
                    >
                      {stale && <span aria-hidden="true">⏱ </span>}
                      {formatWait(item.ageHours)}
                      {stale && <span className="visually-hidden"> — {T.list.staleHint(staleHours)}</span>}
                    </span>
                  ) : (
                    <span className="text-xs muted" title={formatDateTime(item.doneAt ?? item.updatedAt)}>
                      {T.list.closedAgo(formatAgo(item.doneAt ?? item.updatedAt))}
                    </span>
                  )}
                </td>
                <td className="col-owners text-xs">
                  {item.owners.length ? item.owners.join(', ') : <span className="muted">{T.list.noOwners}</span>}
                </td>
                <td className="col-pr nowrap">
                  {item.prUrl ? (
                    <a href={item.prUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
                      {item.prNumber ? `#${item.prNumber}` : T.report.pr} ↗
                    </a>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
