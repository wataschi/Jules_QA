/**
 * Стан зовнішніх систем Jules 2.0: Confluence (за VPN), Jira, Figma, Telegram.
 * Що налаштовано (з назвами змінних `.env`), чи відповідає, з якого часу, і
 * останні помилки — щоб розрив VPN було видно одразу, а не за тиждень.
 */

import { useState } from 'react';
import { api } from '../../api';
import { Async } from '../../components/states';
import { Chip } from '../../components/ui';
import { useToast } from '../../context/AppContext';
import { messageOf, useAsync } from '../../hooks/useAsync';
import type { HealthCheck, HealthResponse } from '../../types';
import { formatAgo, formatDateTime } from '../../utils/format';
import { SS } from './strings';

type Target = keyof HealthResponse['configured'];
const TARGETS: Target[] = ['confluence', 'jira', 'figma', 'telegram'];

const ENV: Record<Target, Array<{ name: string; optional?: boolean }>> = {
  confluence: [{ name: 'CONFLUENCE_BASE_URL' }, { name: 'CONFLUENCE_TOKEN' }, { name: 'NODE_EXTRA_CA_CERTS', optional: true }],
  jira: [{ name: 'JIRA_BASE_URL' }, { name: 'JIRA_TOKEN' }],
  figma: [{ name: 'FIGMA_TOKEN' }],
  telegram: [{ name: 'TELEGRAM_BOT_TOKEN' }, { name: 'TELEGRAM_CHAT_ID' }],
};

export function HealthCard() {
  const toast = useToast();
  const state = useAsync((signal) => api.getHealth(signal), []);
  const notifications = useAsync((signal) => api.listNotifications(signal), []);
  const [running, setRunning] = useState(false);

  async function runChecks() {
    setRunning(true);
    try {
      state.setData(await api.runHealthChecks());
      toast({ text: SS.healthDone, tone: 'good' });
    } catch (cause) {
      toast({ text: messageOf(cause), tone: 'bad' });
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="card" aria-labelledby="health-title">
      <div className="card-head">
        <h2 id="health-title">{SS.health}</h2>
        <span className="muted text-xs">{SS.healthSub}</span>
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={runChecks} disabled={running}>
          {running ? SS.healthRunning : SS.healthRun}
        </button>
      </div>
      <div className="card-body">
        <Async state={state} skeletonRows={4}>
          {(health) => {
            const errors = [
              ...health.checks
                .filter((check) => check.error)
                .map((check) => ({
                  key: `h-${check.target}`,
                  who: SS.targets[check.target] ?? check.target,
                  at: check.checkedAt,
                  text: check.error ?? '',
                })),
              ...(notifications.data?.items ?? [])
                .filter((item) => item.error)
                .map((item) => ({ key: `n-${item.id}`, who: SS.targets.telegram, at: item.createdAt, text: item.error ?? '' })),
            ]
              .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
              .slice(0, 6);

            return (
              <>
                <div className="health-grid">
                  {TARGETS.map((target) => (
                    <HealthTile
                      key={target}
                      target={target}
                      configured={Boolean(health.configured[target])}
                      check={health.checks.find((item) => item.target === target)}
                    />
                  ))}
                </div>
                <p className="muted text-xs">{SS.envHint}</p>
                <div>
                  <h3 className="text-sm">{SS.lastErrors}</h3>
                  {errors.length === 0 ? (
                    <p className="muted text-sm">{SS.lastErrorsNone}</p>
                  ) : (
                    <ul className="plain-list health-errors">
                      {errors.map((item) => (
                        <li key={item.key}>
                          <Chip tone="bad">{item.who}</Chip>
                          <span className="text-sm">{item.text}</span>
                          <span className="muted text-xs nowrap" title={formatDateTime(item.at)}>
                            {formatAgo(item.at)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            );
          }}
        </Async>
      </div>
    </section>
  );
}

function HealthTile({ target, configured, check }: { target: Target; configured: boolean; check: HealthCheck | undefined }) {
  const name = SS.targets[target];
  const titleId = `health-${target}`;
  let status;
  if (!configured) status = <Chip tone="warn">{SS.notConfigured}</Chip>;
  else if (target === 'telegram') status = <Chip tone="good">{SS.configured}</Chip>;
  else if (!check) status = <Chip tone="neutral">{SS.notChecked}</Chip>;
  else
    status = (
      <Chip tone={check.ok ? 'good' : 'bad'} title={formatDateTime(check.since)}>
        {check.ok ? SS.ok : SS.down} {SS.since} {formatDateTime(check.since)}
      </Chip>
    );

  return (
    <article className={`health-tile${configured && check && !check.ok ? ' down' : ''}`} aria-labelledby={titleId}>
      <div className="row-wrap">
        <h3 id={titleId}>{name}</h3>
        <span className="spacer" />
        {status}
      </div>
      <p className="muted text-xs">{SS.targetHint[target]}</p>
      {configured && target === 'telegram' && <p className="muted text-xs">{SS.noProbe}</p>}
      {check && (
        <p className="muted text-xs" title={formatDateTime(check.checkedAt)}>
          {SS.checked} {formatAgo(check.checkedAt)}
          {typeof check.details.version === 'string' ? ` · ${check.details.version}` : ''}
          {typeof check.details.baseUrl === 'string' ? ` · ${check.details.baseUrl}` : ''}
        </p>
      )}
      {check?.error && <p className="health-error text-xs">{check.error}</p>}
      <div className="health-env" aria-label={`${SS.envTitle}: ${name}`}>
        <span className="muted text-xs">{SS.envTitle}</span>
        <ul className="plain-list">
          {ENV[target].map((item) => (
            <li key={item.name}>
              <code className="mono text-xs">{item.name}</code>
              {item.optional && <span className="muted text-xs"> · {SS.envOptional}</span>}
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}
