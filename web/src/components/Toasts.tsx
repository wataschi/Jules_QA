/** Тости в `aria-live`, з необов'язковою дією (наприклад «Відкотити»). */

import { useApp } from '../context/AppContext';
import { S } from '../strings';

export default function Toasts() {
  const { toasts, dismissToast } = useApp();

  return (
    <div className="toasts" role="status" aria-live="polite" aria-atomic="false">
      {toasts.map((item) => (
        <div key={item.id} className={`toast ${item.tone === 'info' ? '' : item.tone}`}>
          <span className="toast-text">{item.text}</span>
          {item.action && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                item.action?.run();
                dismissToast(item.id);
              }}
            >
              {item.action.label}
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-sm"
            onClick={() => dismissToast(item.id)}
            aria-label={S.common.dismiss}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      ))}
    </div>
  );
}
