/**
 * Вкладка «Доступ»: хто я, користувачі з ролями, токени (видача з одноразовим
 * показом значення, відкликання) і пояснення, як люди й CI заходять у Jules.
 */

import { useId, useState, type ReactNode } from 'react';
import { api } from '../../api';
import { Dialog } from '../../components/Dialog';
import { Async, ErrorState, Loading } from '../../components/states';
import { CheckField, Chip, SelectField, TextField } from '../../components/ui';
import { useApp, useToast } from '../../context/AppContext';
import { messageOf, useAsync, type AsyncState } from '../../hooks/useAsync';
import { S } from '../../strings';
import type { ApiTokenRecord, Me, User } from '../../types';
import { formatAgo, formatDateTime } from '../../utils/format';
import { SS } from './strings';

const USER_ROLES: User['role'][] = ['admin', 'qa', 'dev'];
const TOKEN_ROLES: ApiTokenRecord['role'][] = ['ci', 'dev', 'qa', 'admin'];

export function AccessTab({ browserCard }: { browserCard: ReactNode }) {
  const me = useAsync((signal) => api.me(signal), []);
  const isAdmin = me.data?.role === 'admin';

  return (
    <>
      <div className="grid grid-2">
        <MeCard state={me} />
        <section className="card">
          <div className="card-head">
            <h2>{SS.howTitle}</h2>
          </div>
          <div className="card-body">
            <p className="text-sm">{SS.howPeople}</p>
            <p className="text-sm muted">{SS.howTokens}</p>
          </div>
        </section>
      </div>
      <UsersCard me={me.data} isAdmin={isAdmin} />
      <TokensCard me={me.data} isAdmin={isAdmin} />
      {browserCard}
    </>
  );
}

/* ─────────────────────────────── хто я ───────────────────────────────── */

function MeCard({ state }: { state: AsyncState<Me> }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>{SS.me}</h2>
        {state.data && <Chip tone="accent">{SS.roles[state.data.role] ?? state.data.role}</Chip>}
      </div>
      <div className="card-body">
        <Async state={state} skeletonRows={3}>
          {(me) => (
            <dl className="kv">
              <dt>{SS.meLogin}</dt>
              <dd className="mono">{me.login}</dd>
              {me.name && (
                <>
                  <dt>{SS.meName}</dt>
                  <dd>{me.name}</dd>
                </>
              )}
              <dt>{SS.meKind}</dt>
              <dd>{SS.kinds[me.kind] ?? me.kind}</dd>
              <dt>{SS.meAuthor}</dt>
              <dd className="mono">{me.author}</dd>
            </dl>
          )}
        </Async>
      </div>
    </section>
  );
}

/* ───────────────────────────── користувачі ───────────────────────────── */

function UsersCard({ me, isAdmin }: { me: Me | undefined; isAdmin: boolean }) {
  const toast = useToast();
  const state = useAsync((signal) => api.listUsers(signal), []);
  const [busy, setBusy] = useState<string | null>(null);

  async function changeRole(user: User, role: User['role']) {
    setBusy(user.login);
    try {
      const next = await api.setUserRole(user.login, role);
      state.setData((state.data ?? []).map((item) => (item.login === user.login ? { ...item, ...next } : item)));
      toast({ text: SS.roleSaved(user.login), tone: 'good' });
    } catch (cause) {
      toast({ text: messageOf(cause), tone: 'bad' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>{SS.users}</h2>
        <span className="muted text-xs">{SS.usersSub}</span>
        {me && !isAdmin && (
          <>
            <span className="spacer" />
            <span className="muted text-xs">{SS.roleAdminOnly}</span>
          </>
        )}
      </div>
      <Async state={state} skeletonRows={3} empty={{ title: SS.usersEmpty, hint: SS.howPeople }}>
        {(users) => (
          <div className="table-wrap">
            <table className="tbl tbl-narrow">
              <thead>
                <tr>
                  <th scope="col">{SS.colLogin}</th>
                  <th scope="col">{SS.colName}</th>
                  <th scope="col">{SS.colRole}</th>
                  <th scope="col">{SS.colSeen}</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.login}>
                    <td className="mono">{user.login}</td>
                    <td>{user.name ?? '—'}</td>
                    <td>
                      {isAdmin ? (
                        <select
                          className="select-inline"
                          aria-label={SS.roleFor(user.login)}
                          value={user.role}
                          disabled={busy === user.login}
                          onChange={(event) => changeRole(user, event.target.value as User['role'])}
                        >
                          {USER_ROLES.map((role) => (
                            <option key={role} value={role}>
                              {SS.roles[role]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Chip tone="neutral">{SS.roles[user.role] ?? user.role}</Chip>
                      )}
                    </td>
                    <td className="nowrap text-xs muted" title={formatDateTime(user.lastSeenAt)}>
                      {formatAgo(user.lastSeenAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Async>
    </section>
  );
}

/* ─────────────────────────────── токени ──────────────────────────────── */

function TokensCard({ me, isAdmin }: { me: Me | undefined; isAdmin: boolean }) {
  const { projectId } = useApp();
  const toast = useToast();
  const state = useAsync((signal) => api.listTokens(undefined, signal), [isAdmin], isAdmin);
  const [revoking, setRevoking] = useState<ApiTokenRecord | null>(null);
  const [issued, setIssued] = useState<{ token: string; record: ApiTokenRecord } | null>(null);

  async function revoke() {
    if (!revoking) return;
    const target = revoking;
    setRevoking(null);
    try {
      await api.revokeToken(target.id);
      toast({ text: SS.revoked, tone: 'good' });
      state.reload();
    } catch (cause) {
      toast({ text: messageOf(cause), tone: 'bad' });
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>{SS.tokens}</h2>
      </div>

      {issued && <IssuedToken value={issued.token} name={issued.record.name} onDone={() => setIssued(null)} />}

      {!me ? (
        <div className="card-body">
          <Loading rows={2} />
        </div>
      ) : !isAdmin ? (
        <div className="card-body">
          <p className="muted text-sm">{SS.tokensAdminOnly}</p>
        </div>
      ) : (
        <Async state={state} skeletonRows={3} empty={{ title: SS.tokensEmpty, hint: SS.howTokens }}>
          {(tokens) => (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th scope="col">{SS.colTokenName}</th>
                    <th scope="col">{SS.colRole}</th>
                    <th scope="col">{SS.colScope}</th>
                    <th scope="col">{SS.colCreated}</th>
                    <th scope="col">{SS.colUsed}</th>
                    <th scope="col">{SS.colTokenState}</th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {tokens.map((token) => (
                    <tr key={token.id}>
                      <td>{token.name}</td>
                      <td>{SS.roles[token.role] ?? token.role}</td>
                      <td className="mono text-xs">{token.projectId ?? SS.allProjects}</td>
                      <td className="nowrap text-xs muted" title={formatDateTime(token.createdAt)}>
                        {formatAgo(token.createdAt)} · {token.createdBy}
                      </td>
                      <td className="nowrap text-xs muted" title={formatDateTime(token.lastUsedAt)}>
                        {formatAgo(token.lastUsedAt)}
                      </td>
                      <td>
                        {token.revokedAt ? (
                          <Chip tone="neutral" title={formatDateTime(token.revokedAt)}>
                            {SS.tokenRevoked}
                          </Chip>
                        ) : (
                          <Chip tone="good">{SS.tokenActive}</Chip>
                        )}
                      </td>
                      <td>
                        {!token.revokedAt && (
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            aria-label={SS.revokeLabel(token.name)}
                            onClick={() => setRevoking(token)}
                          >
                            {SS.revoke}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Async>
      )}

      {me && (
        <IssueForm
          me={me}
          isAdmin={isAdmin}
          projectId={projectId}
          onIssued={(result) => {
            setIssued(result);
            if (isAdmin) state.reload();
          }}
        />
      )}

      {revoking && (
        <Dialog
          title={SS.revokeTitle}
          onClose={() => setRevoking(null)}
          size="sm"
          footer={
            <>
              <button type="button" className="btn" onClick={() => setRevoking(null)}>
                {S.common.cancel}
              </button>
              <button type="button" className="btn btn-danger" onClick={revoke}>
                {SS.revoke}
              </button>
            </>
          }
        >
          <p className="text-sm">{SS.revokeText(revoking.name)}</p>
        </Dialog>
      )}
    </section>
  );
}

function IssueForm({
  me,
  isAdmin,
  projectId,
  onIssued,
}: {
  me: Me;
  isAdmin: boolean;
  projectId: string;
  onIssued: (result: { token: string; record: ApiTokenRecord }) => void;
}) {
  const allowed = isAdmin ? TOKEN_ROLES : TOKEN_ROLES.filter((role) => role === me.role);
  const [name, setName] = useState('');
  const [role, setRole] = useState<ApiTokenRecord['role']>(allowed[0] ?? 'dev');
  const [scoped, setScoped] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (allowed.length === 0) return null;

  async function issue() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.issueToken({ name: name.trim(), role, projectId: scoped && projectId ? projectId : undefined });
      setName('');
      onIssued(result);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="card-body issue-form"
      aria-label={SS.issueTitle}
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) void issue();
      }}
    >
      <h3>{SS.issueTitle}</h3>
      <div className="settings-fields">
        <TextField label={SS.issueName} value={name} onChange={setName} hint={SS.issueNameHint} />
        <SelectField
          label={SS.issueRole}
          value={role}
          onChange={(next) => setRole(next as ApiTokenRecord['role'])}
          options={allowed.map((item) => ({ value: item, label: SS.roles[item] ?? item }))}
          hint={SS.issueRoleHint}
          disabled={allowed.length < 2}
        />
      </div>
      <CheckField label={SS.issueProject} checked={scoped} onChange={setScoped} disabled={!projectId} />
      {error && <ErrorState message={error} compact />}
      <div className="row">
        <span className="spacer" />
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !name.trim()}>
          {SS.issue}
        </button>
      </div>
    </form>
  );
}

/** Значення нового токена: видно один раз, з копіюванням і попередженням. */
function IssuedToken({ value, name, onDone }: { value: string; name: string; onDone: () => void }) {
  const toast = useToast();
  const id = useId();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast({ text: SS.copied, tone: 'good' });
    } catch {
      toast({ text: SS.copyFailed, tone: 'warn' });
    }
  }

  return (
    <div className="card-body">
      <div className="alert warn issued-token" role="status">
        <div className="issued-token-body">
          <strong>{SS.issuedTitle}</strong>
          <span className="text-sm">«{name}». {SS.issuedWarn}</span>
          <label htmlFor={id} className="text-xs">
            {SS.issuedField}
          </label>
          <div className="row-wrap">
            <input
              id={id}
              className="input-mono issued-token-value"
              type="text"
              readOnly
              value={value}
              onFocus={(event) => event.currentTarget.select()}
            />
            <button type="button" className="btn btn-sm btn-primary" onClick={copy}>
              {copied ? SS.copied : SS.copy}
            </button>
            <button type="button" className="btn btn-sm" onClick={onDone}>
              {SS.issuedDone}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
