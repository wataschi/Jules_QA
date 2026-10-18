/** Зрозумілі помилки й підсумки оновлення входів. */
import { explainError, type SyncTotals } from './model';
import { SI } from './strings';

export function ErrorNote({ message, status }: { message: string; status?: number | null }) {
  const { text, details } = explainError(message, status);
  return (
    <div className="alert bad inputs-error" role="alert">
      <div className="col inputs-error-body">
        <span>{text}</span>
        {details && (
          <details>
            <summary>{SI.errors.details}</summary>
            <code className="mono text-xs">{details}</code>
          </details>
        )}
      </div>
    </div>
  );
}

export function SyncSummary({ totals, onClose }: { totals: SyncTotals; onClose?: () => void }) {
  const tone = totals.errors.length ? 'warn' : 'good';
  return (
    <section className={`alert ${tone} sync-summary`} aria-label={SI.sync.title} data-testid="sync-summary">
      <div className="col sync-summary-body">
        <div className="sync-counts">
          <strong>{SI.sync.title}:</strong>
          <span>
            {SI.sync.changed} <b>{totals.changed}</b>
          </span>
          <span>
            {SI.sync.added} <b>{totals.added}</b>
          </span>
          <span>
            {SI.sync.proposals} <b>{totals.proposals}</b>
          </span>
          <span>
            {SI.sync.errors} <b>{totals.errors.length}</b>
          </span>
          {totals.readTasks > 0 && (
            <span>
              {SI.sync.readTasks} <b>{totals.readTasks}</b>
            </span>
          )}
          <span className="muted">
            {SI.sync.sources} {totals.sources}, {SI.sync.unchanged} {totals.unchanged}
          </span>
        </div>
        {totals.errors.length > 0 && (
          <ul className="plain-list sync-errors">
            {totals.errors.map((item, index) => (
              <li key={`${item.title}-${index}`}>
                <b>{item.title}</b>: {explainError(item.error).text}
              </li>
            ))}
          </ul>
        )}
      </div>
      {onClose && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
          {SI.sync.close}
        </button>
      )}
    </section>
  );
}
