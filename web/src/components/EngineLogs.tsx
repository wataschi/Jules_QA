/**
 * Логи рушія для кейса з автопрогоном.
 *
 * Правило проєкту: логи — ЛИШЕ через SSE, жодного опитування паралельно.
 * Початковий зріз беремо один раз із `GET /api/runs/:legacyId` (там уже є
 * `logs[]`), далі тільки потік `GET /api/runs/:legacyId/stream`.
 *
 * `onerror` у EventSource спрацьовує і на обриві, і на завершенні відповіді,
 * тому браузерне автоперепідключення ми глушимо (`close()`) і робимо своє —
 * з видимим відліком і кнопкою «Перепідключитися».
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { messageOf } from '../hooks/useAsync';
import { S } from '../strings';

type Phase = 'connecting' | 'live' | 'retrying' | 'closed';

const RETRY_STEPS = [2, 4, 8, 15];

export default function EngineLogs({ legacyRunId }: { legacyRunId: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [countdown, setCountdown] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const attemptRef = useRef(0);
  const boxRef = useRef<HTMLPreElement>(null);

  const reconnectNow = useCallback(() => {
    attemptRef.current = 0;
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let tickTimer: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    const controller = new AbortController();

    setPhase('connecting');
    setError(null);

    // Початковий зріз логів: один запит, не опитування.
    api
      .legacyGetRun(legacyRunId, controller.signal)
      .then((run) => {
        if (closed) return;
        setLines(run.logs ?? []);
        if (!run.active) setPhase('closed');
      })
      .catch((cause) => {
        if (closed || controller.signal.aborted) return;
        setError(messageOf(cause));
      });

    const scheduleRetry = () => {
      const step = RETRY_STEPS[Math.min(attemptRef.current, RETRY_STEPS.length - 1)];
      attemptRef.current += 1;
      setPhase('retrying');
      setCountdown(step);
      tickTimer = setInterval(() => {
        setCountdown((value) => (value > 0 ? value - 1 : 0));
      }, 1000);
      retryTimer = setTimeout(() => {
        if (!closed) setNonce((n) => n + 1);
      }, step * 1000);
    };

    try {
      source = new EventSource(api.legacyStreamUrl(legacyRunId));
    } catch (cause) {
      setError(messageOf(cause));
      setPhase('closed');
      return () => {
        closed = true;
        controller.abort();
      };
    }

    source.addEventListener('open', () => {
      if (closed) return;
      attemptRef.current = 0;
      setPhase('live');
      setError(null);
    });

    source.addEventListener('log', (event) => {
      if (closed) return;
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as string[] | string;
        const incoming = Array.isArray(payload) ? payload : [String(payload)];
        setLines((current) => [...current, ...incoming]);
      } catch {
        setLines((current) => [...current, (event as MessageEvent<string>).data]);
      }
    });

    source.addEventListener('done', () => {
      if (closed) return;
      closed = true;
      source?.close();
      setPhase('closed');
    });

    source.addEventListener('error', () => {
      if (closed) return;
      // Глушимо вбудований reconnect і керуємо повтором самі.
      source?.close();
      if (attemptRef.current >= RETRY_STEPS.length) {
        setPhase('closed');
        setError(S.errors.network);
        return;
      }
      scheduleRetry();
    });

    return () => {
      closed = true;
      controller.abort();
      source?.close();
      if (retryTimer) clearTimeout(retryTimer);
      if (tickTimer) clearInterval(tickTimer);
    };
  }, [legacyRunId, nonce]);

  // Автопрокрутка донизу, поки потік активний.
  useEffect(() => {
    if (phase !== 'live') return;
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [lines, phase]);

  const statusText =
    phase === 'connecting'
      ? S.runs.engineConnecting
      : phase === 'live'
        ? S.runs.engineLive
        : phase === 'retrying'
          ? S.runs.engineRetrying(countdown)
          : S.runs.engineClosed;

  const tone = phase === 'live' ? 'good' : phase === 'retrying' ? 'warn' : 'neutral';

  return (
    <div className="col" style={{ gap: 'var(--sp-2)' }}>
      <div className="row-wrap">
        <span className={`chip ${tone === 'neutral' ? '' : tone}`}>
          <span className="chip-dot" aria-hidden="true" />
          {statusText}
        </span>
        <span className="mono text-xs muted">{legacyRunId}</span>
        <span className="spacer" />
        {(phase === 'closed' || phase === 'retrying') && (
          <button type="button" className="btn btn-sm" onClick={reconnectNow}>
            {S.runs.engineReconnect}
          </button>
        )}
      </div>
      {error && <div className="alert warn">{error}</div>}
      <pre className="logs" ref={boxRef} aria-label={S.runs.engineLogs}>
        {lines.length ? lines.join('\n') : S.empty.logs}
      </pre>
    </div>
  );
}
