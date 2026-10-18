/**
 * «Ваше рішення»: що QA може зробити із задачею зараз. Набір дій залежить
 * від стану; під час запиту всі кнопки вимкнені, тож двічі не надішлеш.
 */
import { useCallback, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { TextArea } from '../../components/ui';
import { S } from '../../strings';
import type { Task, TaskEvent } from '../../types';
import { formatAgo, formatDateTime } from '../../utils/format';
import { PR_KINDS, isOpenState } from './bits';
import { T } from './strings';

export type TaskAction = 'confirm' | 'changes' | 'reject' | 'retry' | 'answer' | 'comment';

export function TaskActions({
  task,
  events,
  busy,
  onAct,
}: {
  task: Task;
  events: TaskEvent[];
  busy: TaskAction | null;
  /** Повертає true, якщо сервер прийняв дію. */
  onAct: (action: TaskAction, text?: string) => Promise<boolean>;
}) {
  const [answer, setAnswer] = useState('');
  const [comment, setComment] = useState('');
  const [dialog, setDialog] = useState<'changes' | 'reject' | null>(null);
  const [dialogText, setDialogText] = useState('');
  const closeDialog = useCallback(() => {
    setDialog(null);
    setDialogText('');
  }, []);

  const locked = busy !== null;
  const open = isOpenState(task.state);
  const question = task.state === 'needs_info' ? [...events].reverse().find((event) => event.type === 'question') : undefined;
  const prLabel = task.prNumber ? `PR #${task.prNumber}` : 'PR';
  const viaPr = PR_KINDS.has(task.kind);

  async function submit(action: TaskAction, text: string | undefined, after: () => void) {
    if (locked) return;
    if (await onAct(action, text)) after();
  }

  if (!open) {
    return (
      <section className="card" aria-labelledby="task-actions-title">
        <div className="card-head">
          <h2 id="task-actions-title">{T.actions.title}</h2>
        </div>
        <div className="card-body">
          <p className="muted text-sm">{T.actions.closed}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="card tasks-actions" aria-labelledby="task-actions-title" aria-busy={locked}>
      <div className="card-head">
        <h2 id="task-actions-title">{T.actions.title}</h2>
      </div>
      <div className="card-body">
        {task.state === 'needs_info' && (
          <div className="tasks-question" data-testid="task-question">
            <h3 className="tasks-question-title">{T.actions.question}</h3>
            {question ? (
              <>
                <p className="pre-wrap">{question.text}</p>
                <p className="text-xs muted">
                  {question.author} · <time dateTime={question.at} title={formatDateTime(question.at)}>{formatAgo(question.at)}</time>
                </p>
              </>
            ) : null}
            <TextArea label={T.actions.answerLabel} value={answer} onChange={setAnswer} hint={T.actions.answerHint} rows={3} />
            <div className="row-wrap">
              <button
                type="button"
                className="btn btn-primary"
                disabled={locked || !answer.trim()}
                onClick={() => void submit('answer', answer.trim(), () => setAnswer(''))}
              >
                {busy === 'answer' ? S.common.loading : T.actions.answerSend}
              </button>
            </div>
          </div>
        )}

        {task.state === 'review' && (
          <div className="tasks-decide">
            {task.qaConfirmedAt && (
              <p className="alert good" role="status">
                {T.actions.confirmedNote(task.qaConfirmedBy ?? 'QA', formatAgo(task.qaConfirmedAt))}
              </p>
            )}
            <div className="tasks-confirm">
              {!task.qaConfirmedAt && (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={locked}
                  onClick={() => void submit('confirm', undefined, () => undefined)}
                >
                  {busy === 'confirm' ? S.common.loading : `✓ ${T.actions.confirm}`}
                </button>
              )}
              <button type="button" className="btn" disabled={locked} onClick={() => setDialog('changes')}>
                {T.actions.changes}
              </button>
            </div>
            {!task.qaConfirmedAt && (
              <p className="text-xs muted">{viaPr ? T.actions.confirmPrHint(prLabel) : T.actions.confirmNoPrHint}</p>
            )}
          </div>
        )}

        {task.state === 'failed' && (
          <div className="tasks-decide">
            <div className="tasks-confirm">
              <button type="button" className="btn btn-primary" disabled={locked} onClick={() => void submit('retry', undefined, () => undefined)}>
                {busy === 'retry' ? S.common.loading : `↻ ${T.actions.retry}`}
              </button>
            </div>
            <p className="text-xs muted">{T.actions.retryHint}</p>
          </div>
        )}

        <div className="tasks-comment">
          <TextArea label={T.actions.comment} value={comment} onChange={setComment} hint={T.actions.commentHint} rows={2} />
          <div className="row-wrap">
            <button
              type="button"
              className="btn"
              disabled={locked || !comment.trim()}
              onClick={() => void submit('comment', comment.trim(), () => setComment(''))}
            >
              {busy === 'comment' ? S.common.loading : T.actions.commentSend}
            </button>
            <span className="spacer" />
            <button type="button" className="btn btn-danger btn-sm" disabled={locked} onClick={() => setDialog('reject')}>
              {T.actions.reject}
            </button>
          </div>
        </div>
      </div>

      {dialog === 'changes' && (
        <Dialog
          title={T.actions.changesTitle}
          onClose={closeDialog}
          footer={
            <>
              <button type="button" className="btn" onClick={closeDialog}>
                {S.common.cancel}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={locked || !dialogText.trim()}
                onClick={() => void submit('changes', dialogText.trim(), closeDialog)}
              >
                {busy === 'changes' ? S.common.loading : T.actions.changesSend}
              </button>
            </>
          }
        >
          <TextArea label={T.actions.changesLabel} value={dialogText} onChange={setDialogText} hint={T.actions.changesHint} rows={5} />
        </Dialog>
      )}

      {dialog === 'reject' && (
        <Dialog
          title={T.actions.rejectTitle}
          onClose={closeDialog}
          size="sm"
          footer={
            <>
              <button type="button" className="btn" onClick={closeDialog}>
                {S.common.cancel}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={locked}
                onClick={() => void submit('reject', dialogText.trim() || undefined, closeDialog)}
              >
                {busy === 'reject' ? S.common.loading : T.actions.rejectSend}
              </button>
            </>
          }
        >
          <p className="text-sm">{T.actions.rejectText}</p>
          <TextArea label={T.actions.rejectNote} value={dialogText} onChange={setDialogText} rows={3} />
        </Dialog>
      )}
    </section>
  );
}
