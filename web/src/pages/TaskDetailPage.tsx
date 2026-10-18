/**
 * Одна задача агента: що просили, що агент зробив і що перевіряє його тест,
 * які питання ставив, що йому віддали, — і рішення QA. QA погоджує намір
 * («що перевіряє»), а не читає код: код дивиться розробник у PR.
 */
import { useCallback, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { ErrorState, Loading } from '../components/states';
import { PageHead, PriorityChip } from '../components/ui';
import { useToast } from '../context/AppContext';
import { messageOf, useResource } from '../hooks/useAsync';
import { S2 } from '../strings-v2';
import type { Task } from '../types';
import { formatAgo, formatDateTime } from '../utils/format';
import { PR_KINDS, TaskStateChip } from './tasks/bits';
import { T } from './tasks/strings';
import { TaskActions, type TaskAction } from './tasks/TaskActions';
import { TaskContextView } from './tasks/TaskContextView';
import { JobsCard, ReportCard, TimelineCard } from './tasks/TaskPanels';
import '../styles/tasks.css';

function stateNote(task: Task): string {
  if (task.state === 'review') {
    if (task.qaConfirmedAt) return T.detail.stateNote.reviewConfirmed;
    if (task.kind === 'read_asset') return T.detail.stateNote.reviewReading;
    if (!PR_KINDS.has(task.kind)) return T.detail.stateNote.reviewNoPr;
  }
  return T.detail.stateNote[task.state];
}

export default function TaskDetailPage() {
  const { id = '' } = useParams();
  const toast = useToast();
  const state = useResource((signal) => api.getTask(id, signal), [id], { enabled: Boolean(id), pollMs: 20_000 });
  const [busy, setBusy] = useState<TaskAction | null>(null);
  const busyRef = useRef(false);

  const reload = state.reload;
  const act = useCallback(
    async (action: TaskAction, text?: string): Promise<boolean> => {
      if (busyRef.current) return false;
      busyRef.current = true;
      setBusy(action);
      try {
        let message: string;
        switch (action) {
          case 'confirm': {
            const next = await api.confirmTask(id);
            message = next.state === 'done' ? T.actions.confirmedDone : T.actions.confirmed;
            break;
          }
          case 'changes':
            await api.requestTaskChanges(id, text ?? '');
            message = T.actions.changesSent;
            break;
          case 'reject':
            await api.rejectTask(id, text);
            message = T.actions.rejected;
            break;
          case 'answer':
            await api.answerTask(id, text ?? '');
            message = T.actions.answered;
            break;
          case 'comment':
            await api.commentTask(id, text ?? '');
            message = T.actions.commented;
            break;
        }
        toast({ text: message, tone: 'good' });
        return true;
      } catch (error) {
        toast({ text: messageOf(error), tone: 'bad' });
        return false;
      } finally {
        busyRef.current = false;
        setBusy(null);
        // І після помилки: стан на сервері міг змінитися без нас (409).
        reload();
      }
    },
    [id, toast, reload],
  );

  const back = (
    <Link className="btn btn-sm btn-ghost" to="/tasks">
      ← {T.detail.back}
    </Link>
  );

  if (state.loading && !state.data) return <Loading rows={8} />;
  if (state.error && !state.data) {
    return (
      <>
        <PageHead title={state.status === 404 ? T.detail.notFound : S2.nav.tasks} actions={back} />
        <ErrorState message={state.error} status={state.status} onRetry={state.reload} />
      </>
    );
  }
  if (!state.data) return <Loading rows={8} />;

  const { task, events, jobs, context } = state.data;
  const actions = <TaskActions task={task} events={events} busy={busy} onAct={act} />;
  const askFirst = task.state === 'needs_info';

  return (
    <>
      <PageHead title={task.title} sub={`${task.id} · ${S2.taskKind[task.kind]}`} actions={back} />

      <div className="tasks-detail">
        <div className="tasks-detail-main">
          <section className="card" aria-labelledby="task-head-title">
            <div className="card-head">
              <h2 id="task-head-title">{T.detail.head}</h2>
              <span className="spacer" />
              <TaskStateChip state={task.state} />
            </div>
            <div className="card-body">
              <p className={`tasks-state-note state-${task.state}`} role="status">
                {stateNote(task)}
              </p>
              {task.text && <p className="pre-wrap text-sm">{task.text}</p>}
              <dl className="kv tasks-kv">
                <dt>{T.detail.id}</dt>
                <dd className="mono text-xs">{task.id}</dd>
                <dt>{T.detail.kind}</dt>
                <dd>{S2.taskKind[task.kind]}</dd>
                <dt>{T.detail.state}</dt>
                <dd>
                  <TaskStateChip state={task.state} />
                </dd>
                <dt>{T.detail.priority}</dt>
                <dd>
                  <PriorityChip priority={task.priority} />
                </dd>
                <dt>{T.detail.module}</dt>
                <dd>{context.module?.name ?? task.sectionId ?? '—'}</dd>
                <dt>{T.detail.owners}</dt>
                <dd>{task.owners.length ? task.owners.join(', ') : T.list.noOwners}</dd>
                <dt>{T.detail.lease}</dt>
                <dd>
                  {task.leaseHolder
                    ? T.detail.leaseUntil(task.leaseHolder, task.leaseUntil ? formatDateTime(task.leaseUntil) : '—')
                    : T.detail.leaseNone}
                </dd>
                <dt>{T.detail.attempts}</dt>
                <dd>{task.attempts}</dd>
                <dt>{T.detail.author}</dt>
                <dd>{task.author}</dd>
                <dt>{T.detail.created}</dt>
                <dd title={formatDateTime(task.createdAt)}>{formatAgo(task.createdAt)}</dd>
                {task.qaConfirmedAt && (
                  <>
                    <dt>{T.detail.confirmed}</dt>
                    <dd>
                      {task.qaConfirmedBy ?? 'QA'} · {formatDateTime(task.qaConfirmedAt)}
                    </dd>
                  </>
                )}
              </dl>
            </div>
          </section>

          {askFirst && actions}
          <ReportCard task={task} />
          {!askFirst && actions}
          <TimelineCard events={events} />
        </div>

        <div className="tasks-detail-side">
          <TaskContextView context={context} />
          <JobsCard jobs={jobs} />
        </div>
      </div>
    </>
  );
}
