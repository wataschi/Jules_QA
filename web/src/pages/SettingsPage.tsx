/**
 * Налаштування: проєкт і базовий URL, профілі мапінгу TestRail, статус
 * інтеграцій (LLM / Confluence / TestRail), дефолти прогонів (старий
 * `/api/settings` рушія) і журнал запусків скілів із токенами й часом.
 */

import { useEffect, useState } from 'react';
import { api, getApiToken, setApiToken } from '../api';
import { Dialog } from '../components/Dialog';
import { Async, ErrorState, Loading } from '../components/states';
import {
  CheckField,
  Chip,
  PageHead,
  SelectField,
  Tabs,
  TextField,
} from '../components/ui';
import { useApp, useToast } from '../context/AppContext';
import { messageOf, useAsync } from '../hooks/useAsync';
import { useQueryParams } from '../hooks/useQueryParams';
import { S, skillNameLabel, skillRunStateLabel } from '../strings';
import type { LegacySettings, Project, TestrailMapping } from '../types';
import { formatAgo, formatDateTime, formatDuration, formatTokens } from '../utils/format';

/**
 * Розділи налаштувань. Шість карток одним стовпцем змушували гортати екран,
 * щоб знайти потрібне; тепер вони згруповані за призначенням, а активна
 * вкладка живе в адресі — на потрібний розділ можна дати посилання.
 */
const TABS = [
  { value: 'project', label: S.settings.tabProject },
  { value: 'integrations', label: S.settings.tabIntegrations },
  { value: 'runs', label: S.settings.tabRuns },
];

export default function SettingsPage() {
  const { projectId, project, userName, setUserName } = useApp();
  const params = useQueryParams();
  const tab = params.getOr('tab', 'project');
  const active = TABS.some((item) => item.value === tab) ? tab : 'project';

  return (
    <>
      <PageHead title={S.settings.title} sub={S.settings.sub} />
      <Tabs
        tabs={TABS}
        active={active}
        label={S.settings.title}
        onPick={(next) => params.set({ tab: next === 'project' ? null : next })}
      />

      {active === 'project' && (
        <div className="grid grid-2">
          <ProjectCard project={project} />
          <AccessCard userName={userName} onUserName={setUserName} />
        </div>
      )}

      {active === 'integrations' && (
        <>
          <IntegrationsCard projectId={projectId} />
          <MappingsCard projectId={projectId} />
        </>
      )}

      {active === 'runs' && (
        <>
          <RunDefaultsCard />
          <SkillLogCard projectId={projectId} />
        </>
      )}
    </>
  );
}

/* ─────────────────────────────── проєкт ──────────────────────────────── */

function ProjectCard({ project }: { project: Project | undefined }) {
  const toast = useToast();
  const [name, setName] = useState(project?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(project?.baseUrl ?? '');
  const [space, setSpace] = useState(project?.confluenceSpace ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(project?.name ?? '');
    setBaseUrl(project?.baseUrl ?? '');
    setSpace(project?.confluenceSpace ?? '');
  }, [project]);

  async function save() {
    if (!project) return;
    setBusy(true);
    try {
      await api.patchProject(project.id, {
        name,
        baseUrl: baseUrl || undefined,
        confluenceSpace: space || undefined,
      });
      toast({ text: S.settings.savedToast, tone: 'good' });
    } catch (cause) {
      toast({ text: messageOf(cause), tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>{S.settings.projectSection}</h2>
        {project && <span className="chip mono accent">{project.key}</span>}
      </div>
      <div className="card-body">
        {!project ? (
          <Loading rows={3} />
        ) : (
          <>
            <TextField label={S.settings.projectName} value={name} onChange={setName} />
            <TextField label={S.settings.projectKey} value={project.key} onChange={() => {}} mono disabled />
            <TextField label={S.settings.projectBaseUrl} value={baseUrl} onChange={setBaseUrl} type="url" mono />
            <TextField label={S.settings.projectSpace} value={space} onChange={setSpace} mono />
            <div className="row">
              <span className="spacer" />
              <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={busy}>
                {S.common.save}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/* ─────────────────────────────── доступ ──────────────────────────────── */

function AccessCard({ userName, onUserName }: { userName: string; onUserName: (next: string) => void }) {
  const toast = useToast();
  const [token, setToken] = useState(getApiToken);
  const [name, setName] = useState(userName);

  return (
    <section className="card">
      <div className="card-head">
        <h2>{S.settings.access}</h2>
      </div>
      <div className="card-body">
        <TextField
          label={S.settings.apiToken}
          value={token}
          onChange={setToken}
          type="password"
          hint={S.settings.apiTokenHint}
        />
        <TextField
          label={S.settings.userName}
          value={name}
          onChange={setName}
          hint={S.settings.userNameHint}
        />
        <div className="row">
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => {
              setApiToken(token);
              onUserName(name);
              toast({ text: S.settings.savedToast, tone: 'good' });
            }}
          >
            {S.common.save}
          </button>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────────── інтеграції ────────────────────────────── */

function IntegrationsCard({ projectId }: { projectId: string }) {
  const llm = useAsync((signal) => api.legacyCheckLlm(signal), []);
  const health = useAsync((signal) => api.getIntegrationsHealth(signal), []);
  const drift = useAsync((signal) => api.getDrift(projectId, signal), [projectId], Boolean(projectId));
  const { project } = useApp();

  // Стан беремо з діагностики сервера, а не з побічних ознак:
  // порожній дрейф не означає, що ключі TestRail задані.
  const confluenceConfigured = health.data?.confluence.configured ?? false;
  const testrailConfigured = health.data?.testrail.configured ?? false;
  const confluenceSpaceSet = Boolean(project?.confluenceSpace);

  return (
    <section className="card">
      <div className="card-head">
        <h2>{S.settings.integrations}</h2>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            llm.reload();
            health.reload();
          }}
        >
          {S.settings.intLlmCheck}
        </button>
      </div>
      <div className="card-body grid grid-2">
        <div>
          <div className="row">
            <h3>{S.settings.intLlm}</h3>
            {llm.loading ? (
              <Chip tone="neutral">{S.settings.intChecking}</Chip>
            ) : llm.data?.ok ? (
              <Chip tone="good">{S.settings.intConfigured}</Chip>
            ) : (
              <Chip tone="bad">{S.settings.intMissing}</Chip>
            )}
          </div>
          {llm.data?.models?.length ? (
            <p className="muted text-xs mono">
              {S.settings.intModels}: {llm.data.models.slice(0, 4).join(', ')}
            </p>
          ) : null}
          {llm.data?.error && <p className="muted text-xs">{llm.data.error}</p>}
          {llm.error && <p className="muted text-xs">{llm.error}</p>}

          <div style={{ marginTop: 'var(--sp-3)' }}>
            <h3>{S.settings.intRoles}</h3>
            <p className="muted text-xs">{S.settings.intRolesHint}</p>
            {health.loading && <p className="muted text-xs">{S.settings.intChecking}</p>}
            {health.data && (
              <div className="table-wrap" style={{ marginTop: 'var(--sp-2)' }}>
                <table className="tbl tbl-narrow">
                  <thead>
                    <tr>
                      <th scope="col">{S.settings.colRole}</th>
                      <th scope="col">{S.settings.colEndpoint}</th>
                      <th scope="col">{S.settings.colModel}</th>
                      <th scope="col">{S.settings.colState}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {health.data.models.map((role) => (
                      <tr key={role.role}>
                        <td>{role.label}</td>
                        <td className="mono text-xs">{role.baseUrl ?? '—'}</td>
                        <td className="mono text-xs">{role.model ?? '—'}</td>
                        <td>
                          {!role.configured ? (
                            <Chip tone="warn">{S.settings.roleNotSet}</Chip>
                          ) : role.ok ? (
                            <Chip tone={role.modelAvailable === false ? 'warn' : 'good'}>
                              {role.modelAvailable === false ? S.settings.modelMissing : S.settings.roleOk}
                            </Chip>
                          ) : (
                            <Chip tone="bad" title={role.error}>
                              {S.settings.roleFail}
                              {role.error ? ` · ${role.error}` : ''}
                            </Chip>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div>
          <div className="row">
            <h3>{S.settings.intConfluence}</h3>
            <Chip tone={confluenceConfigured ? 'good' : 'warn'}>
              {confluenceConfigured ? S.settings.intConfigured : S.settings.intMissing}
            </Chip>
          </div>
          <p className="muted text-xs">{S.settings.intConfluenceHint}</p>
          {confluenceConfigured && !confluenceSpaceSet && (
            <p className="muted text-xs">{S.settings.intConfluenceNoSpace}</p>
          )}
        </div>

        <div>
          <div className="row">
            <h3>{S.settings.intTestrail}</h3>
            {drift.loading ? (
              <Chip tone="neutral">{S.settings.intChecking}</Chip>
            ) : (
              <Chip tone={testrailConfigured ? 'good' : 'warn'}>
                {testrailConfigured ? S.settings.intConfigured : S.settings.intMissing}
              </Chip>
            )}
            {testrailConfigured && (drift.data?.length ?? 0) > 0 && (
              <Chip tone="warn" mono>
                {S.dashboard.drift}: {drift.data?.length}
              </Chip>
            )}
          </div>
          <p className="muted text-xs">{S.settings.intTestrailHint}</p>
          {testrailConfigured && (drift.data?.length ?? 0) > 0 && (
            <div className="table-wrap" style={{ marginTop: 'var(--sp-2)' }}>
              <table className="tbl tbl-narrow">
                <thead>
                  <tr>
                    <th scope="col">{S.cases.colId}</th>
                    <th scope="col">{S.replace.colField}</th>
                    <th scope="col">{S.replace.colBefore}</th>
                    <th scope="col">{S.replace.colAfter}</th>
                  </tr>
                </thead>
                <tbody>
                  {(drift.data ?? []).slice(0, 6).map((row) => (
                    <tr key={row.caseId}>
                      <td className="cell-id">{row.caseId}</td>
                      <td className="text-xs">{row.fields.join(', ')}</td>
                      <td className="text-xs">{String(row.ours ?? '')}</td>
                      <td className="text-xs">{String(row.theirs ?? '')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/* ──────────────────────── профілі мапінгу TestRail ───────────────────── */

function MappingsCard({ projectId }: { projectId: string }) {
  const toast = useToast();
  const state = useAsync((signal) => api.listMappings(projectId, signal), [projectId], Boolean(projectId));
  const [creating, setCreating] = useState(false);
  const [edited, setEdited] = useState<TestrailMapping | null>(null);

  async function saveEdited() {
    if (!edited) return;
    try {
      await api.patchMapping(edited.id, {
        name: edited.name,
        template: edited.template,
        idField: edited.idField,
        delimiter: edited.delimiter,
      });
      toast({ text: S.settings.mappingSaved, tone: 'good' });
      setEdited(null);
      state.reload();
    } catch (cause) {
      toast({ text: messageOf(cause), tone: 'bad' });
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>{S.settings.mappings}</h2>
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={() => setCreating(true)}>
          {S.settings.mappingCreate}
        </button>
      </div>
      <Async state={state} skeletonRows={3} empty={{ title: S.empty.mappings, hint: S.empty.mappingsHint }}>
        {(items) => (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">{S.settings.mappingName}</th>
                  <th scope="col">{S.settings.mappingTemplate}</th>
                  <th scope="col">{S.settings.mappingIdField}</th>
                  <th scope="col">{S.settings.mappingDelimiter}</th>
                  <th scope="col">{S.cases.updated}</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.name}</td>
                    <td>
                      {item.template === 'checklist'
                        ? S.settings.mappingTemplateChecklist
                        : S.settings.mappingTemplateSteps}
                    </td>
                    <td className="mono text-xs">{item.idField}</td>
                    <td className="mono text-xs">{item.delimiter}</td>
                    <td className="nowrap text-xs muted">{formatAgo(item.updatedAt)}</td>
                    <td>
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEdited({ ...item })}>
                        {S.common.edit}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Async>

      {creating && (
        <CreateMappingDialog
          projectId={projectId}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            state.reload();
          }}
        />
      )}

      {edited && (
        <Dialog
          title={S.settings.mappings}
          onClose={() => setEdited(null)}
          size="sm"
          footer={
            <>
              <button type="button" className="btn" onClick={() => setEdited(null)}>
                {S.common.cancel}
              </button>
              <button type="button" className="btn btn-primary" onClick={saveEdited}>
                {S.common.save}
              </button>
            </>
          }
        >
          <TextField
            label={S.settings.mappingName}
            value={edited.name}
            onChange={(next) => setEdited({ ...edited, name: next })}
          />
          <SelectField
            label={S.settings.mappingTemplate}
            value={edited.template}
            onChange={(next) => setEdited({ ...edited, template: next as TestrailMapping['template'] })}
            options={[
              { value: 'checklist', label: S.settings.mappingTemplateChecklist },
              { value: 'steps_separated', label: S.settings.mappingTemplateSteps },
            ]}
          />
          <TextField
            label={S.settings.mappingIdField}
            value={edited.idField}
            onChange={(next) => setEdited({ ...edited, idField: next })}
            mono
          />
          <TextField
            label={S.settings.mappingDelimiter}
            value={edited.delimiter}
            onChange={(next) => setEdited({ ...edited, delimiter: next })}
            mono
          />
        </Dialog>
      )}
    </section>
  );
}

function CreateMappingDialog({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [template, setTemplate] = useState<TestrailMapping['template']>('checklist');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await api.createMapping({ projectId, name, template });
      toast({ text: S.settings.mappingSaved, tone: 'good' });
      onCreated();
    } catch (cause) {
      setError(messageOf(cause));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={S.settings.mappingCreate}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {S.common.cancel}
          </button>
          <button type="button" className="btn btn-primary" onClick={create} disabled={busy || !name.trim()}>
            {S.common.save}
          </button>
        </>
      }
    >
      <TextField label={S.settings.mappingName} value={name} onChange={setName} />
      <SelectField
        label={S.settings.mappingTemplate}
        value={template}
        onChange={(next) => setTemplate(next as TestrailMapping['template'])}
        options={[
          { value: 'checklist', label: S.settings.mappingTemplateChecklist },
          { value: 'steps_separated', label: S.settings.mappingTemplateSteps },
        ]}
      />
      {error && <div className="alert bad">{error}</div>}
    </Dialog>
  );
}

/* ───────────────────────── дефолти прогонів ──────────────────────────── */

function RunDefaultsCard() {
  const toast = useToast();
  const state = useAsync((signal) => api.legacyGetSettings(signal), []);
  const scenarios = useAsync((signal) => api.legacyListScenarios(signal), []);
  const [draft, setDraft] = useState<LegacySettings | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (state.data) setDraft(state.data);
  }, [state.data]);

  async function save() {
    if (!draft) return;
    setBusy(true);
    try {
      await api.legacySaveSettings(draft);
      toast({ text: S.settings.savedToast, tone: 'good' });
    } catch (cause) {
      toast({ text: messageOf(cause), tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>{S.settings.runDefaults}</h2>
      </div>
      <div className="card-body">
        {state.loading && !draft ? (
          <Loading rows={4} />
        ) : state.error && !draft ? (
          <ErrorState message={state.error} status={state.status} onRetry={state.reload} />
        ) : draft ? (
          <>
            <TextField
              label={S.settings.defaultUrl}
              hint={S.settings.defaultUrlHint}
              value={draft.qaTargetUrl}
              onChange={(next) => setDraft({ ...draft, qaTargetUrl: next })}
              type="url"
              mono
            />
            <SelectField
              label={S.settings.defaultMode}
              value={draft.qaMode}
              onChange={(next) => setDraft({ ...draft, qaMode: next as LegacySettings['qaMode'] })}
              options={[
                { value: 'warm-up', label: S.settings.modeWarmUp },
                { value: 'regression', label: S.settings.modeRegression },
              ]}
            />
            {scenarios.error ? (
              <TextField
                label={S.settings.defaultScenario}
                value={draft.qaScenarioPath}
                onChange={(next) => setDraft({ ...draft, qaScenarioPath: next })}
                mono
              />
            ) : (
              <SelectField
                label={S.settings.defaultScenario}
                value={draft.qaScenarioPath}
                onChange={(next) => setDraft({ ...draft, qaScenarioPath: next })}
                options={(scenarios.data ?? []).map((item) => ({
                  value: item.path,
                  label: `${item.name} — ${item.path}`,
                }))}
                allLabel={S.common.none}
              />
            )}
            <CheckField
              label={S.settings.debugCache}
              checked={draft.debugCache}
              onChange={(next) => setDraft({ ...draft, debugCache: next })}
            />
            <div className="row">
              <span className="spacer" />
              <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={busy}>
                {S.common.save}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}

/* ─────────────────────── журнал запусків скілів ──────────────────────── */

function SkillLogCard({ projectId }: { projectId: string }) {
  const state = useAsync(
    (signal) => api.listSkillRuns({ projectId, limit: 25 }, signal),
    [projectId],
    Boolean(projectId),
  );

  return (
    <section className="card">
      <div className="card-head">
        <h2>{S.settings.skillLog}</h2>
      </div>
      <Async state={state} skeletonRows={4} empty={{ title: S.empty.skillRuns, hint: S.empty.skillRunsHint }}>
        {(page) => (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">{S.settings.colSkill}</th>
                  <th scope="col">{S.settings.colState}</th>
                  <th scope="col">{S.settings.colModel}</th>
                  <th scope="col">{S.settings.colTokens}</th>
                  <th scope="col">{S.settings.colDuration}</th>
                  <th scope="col">{S.settings.colProposals}</th>
                  <th scope="col">{S.settings.colStarted}</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((item) => (
                  <tr key={item.id}>
                    <td>{skillNameLabel[item.skill]}</td>
                    <td>
                      <Chip tone={item.state === 'done' ? 'good' : item.state === 'failed' ? 'bad' : 'accent'}>
                        {skillRunStateLabel[item.state]}
                      </Chip>
                      {item.error && <span className="muted text-xs"> {item.error}</span>}
                    </td>
                    <td className="mono text-xs">{item.model ?? S.common.none}</td>
                    <td className="mono text-xs nowrap">{formatTokens(item.promptTokens, item.completionTokens)}</td>
                    <td className="mono text-xs nowrap">{formatDuration(item.durationMs)}</td>
                    <td className="cell-num mono">{item.proposalCount}</td>
                    <td className="nowrap text-xs muted" title={formatDateTime(item.startedAt)}>
                      {formatAgo(item.startedAt)}
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
