/**
 * Межа помилок на весь застосунок: падіння в рендері не має давати білий екран.
 * Пишемо власну, бо сторонніх залежностей у проєкт не додаємо.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { S } from '../strings';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: string;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Консоль — єдиний канал діагностики в браузері; сервер про це не знає.
    console.error('[jules-ui]', error, info.componentStack);
    this.setState({ info: info.componentStack ?? '' });
  }

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="shell-content" style={{ maxWidth: 820, margin: '0 auto' }}>
        <div className="card">
          <div className="card-body">
            <h1>{S.errors.boundaryTitle}</h1>
            <p className="muted text-sm">{S.errors.boundaryHint}</p>
            <div className="row-wrap">
              <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
                {S.errors.reload}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => this.setState({ error: null, info: '' })}
              >
                {S.common.retry}
              </button>
            </div>
            <pre className="logs" aria-label={S.errors.boundaryTitle}>
              {error.message}
              {info ? `\n${info}` : ''}
            </pre>
          </div>
        </div>
      </div>
    );
  }
}
