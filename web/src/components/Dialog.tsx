/**
 * Модальний діалог: `role="dialog" aria-modal`, закриття по `Esc` і по кліку
 * поза вікном, фокус переводиться всередину, скрол тіла блокується.
 */

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { S } from '../strings';

export function Dialog({
  title,
  onClose,
  children,
  footer,
  size = 'md',
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  const titleId = useId();
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Фокус у перший інтерактивний елемент діалогу.
    const target = boxRef.current?.querySelector<HTMLElement>(
      'input:not([type=hidden]), textarea, select, button, [href], [tabindex]:not([tabindex="-1"])',
    );
    target?.focus();

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const sizeClass = size === 'sm' ? ' narrow' : size === 'lg' ? ' wide' : '';

  return (
    <div
      className="dialog-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={`dialog${sizeClass}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={boxRef}>
        <div className="dialog-head">
          <h2 id={titleId}>{title}</h2>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-sm"
            onClick={onClose}
            aria-label={S.common.close}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}
