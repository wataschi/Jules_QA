/** Кроки майстра нового проєкту. */
import { useState } from 'react';
import { api } from '../../api';
import { Async } from '../../components/states';
import { TextField } from '../../components/ui';
import { useApp, useToast } from '../../context/AppContext';
import { messageOf, useAsync, useResource } from '../../hooks/useAsync';
import type { SourceNode } from '../../types';
import { formatDateTime } from '../../utils/format';
import { ConfluenceForm, FigmaMultiForm, ModulesForm } from './InputForms';
import { ErrorNote } from './Notes';
import { SourceTree, type SourceFlags } from './SourceTree';
import { confluenceRoots, patchNode, sectionNames } from './model';
import { SI, SW } from './strings';

function useSourceTree(projectId: string) {
  const toast = useToast();
  const state = useResource((signal) => api.getSourceTree(projectId, signal), [projectId], { enabled: Boolean(projectId) });
  const setFlags = async (node: SourceNode, flags: SourceFlags) => {
    const before = state.data;
    if (before) state.setData(patchNode(before, node.id, flags));
    try {
      await api.patchSourceFlags(node.id, flags);
    } catch (error) {
      if (before) state.setData(before);
      toast({ text: messageOf(error), tone: 'bad' });
    }
  };
  return { state, setFlags };
}

/* ─────────────────────────────── 1. Confluence ──────────────────────── */

export function ConfluenceStep({
  projectId,
  configured,
  rootId,
  onRoot,
}: {
  projectId: string;
  configured?: boolean;
  rootId: string;
  onRoot: (id: string) => void;
}) {
  const { state, setFlags } = useSourceTree(projectId);
  const sectionsState = useAsync((signal) => api.listSections(projectId, signal), [projectId], Boolean(projectId));
  const sections = sectionNames(sectionsState.data);

  const roots = confluenceRoots(state.data ?? []);
  const shown = rootId ? roots.filter((root) => root.id === rootId) : roots;

  return (
    <div className="col">
      {configured === false && <div className="alert warn">{SW.confluence.configured}</div>}
      <ConfluenceForm
        projectId={projectId}
        autoFocus={false}
        onLoaded={({ root }) => {
          if (root) onRoot(root.rootId ?? root.id);
          state.reload();
        }}
      />
      {(shown.length > 0 || state.error) && (
        <div className="col wizard-tree">
          <h3 className="blk-sub">{SW.confluence.tree}</h3>
          <p className="muted text-sm">{SW.confluence.treeHint}</p>
          <Async state={{ ...state, data: state.data ? shown : undefined }}>
            {(nodes) => <SourceTree nodes={nodes} onFlags={setFlags} sections={sections} label={SW.confluence.tree} />}
          </Async>
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────────── 2. Figma ──────────────────────────── */

export function FigmaStep({ projectId, configured }: { projectId: string; configured?: boolean }) {
  const { state } = useSourceTree(projectId);
  const figma = (state.data ?? []).filter((node) => node.kind === 'figma');
  return (
    <div className="col">
      {configured === false && <div className="alert warn">{SW.figma.configured}</div>}
      <p className="muted text-sm">{SW.figma.optional}</p>
      <FigmaMultiForm projectId={projectId} onImported={state.reload} />
      {figma.length > 0 && (
        <div className="col">
          <h3 className="blk-sub">{SW.figma.already}</h3>
          <ul className="modules-list">
            {figma.map((node) => (
              <li key={node.id}>
                {node.title} <span className="muted text-xs">· {SI.tree.blocks(node.blockCount)}</span>
                {node.lastError && <span className="src-error inline"> · {node.lastError}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────────── 3. Модулі ─────────────────────────── */

export function ModulesStep({ projectId, rootId }: { projectId: string; rootId: string }) {
  const { state } = useSourceTree(projectId);
  return (
    <Async state={state}>
      {(nodes) => <ModulesForm projectId={projectId} roots={confluenceRoots(nodes)} initialRootId={rootId || undefined} />}
    </Async>
  );
}

/* ─────────────────────────── 4. Репозиторій і Jira ──────────────────── */

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const JIRA_RE = /^[A-Z][A-Z0-9_]+$/;

export function RepoStep({ projectId }: { projectId: string }) {
  const { reloadProjects } = useApp();
  const toast = useToast();
  const projectState = useAsync((signal) => api.getProject(projectId, signal), [projectId], Boolean(projectId));

  return (
    <Async state={projectState}>
      {(project) => (
        <RepoForm
          key={project.id}
          initialRepo={project.repo ?? ''}
          initialJira={project.settings?.jira?.projectKey ?? ''}
          onSave={async (repo, jira) => {
            // Свіжі налаштування: за час майстра Jules дописав туди посилання Confluence і Figma.
            const fresh = await api.getProject(projectId);
            const settings = fresh.settings;
            const patch: Parameters<typeof api.patchProjectV2>[1] = { repo };
            if (jira && settings) {
              patch.settings = {
                ...settings,
                jira: {
                  projectKey: jira,
                  issueType: settings.jira?.issueType ?? 'Task',
                  assignee: settings.jira?.assignee,
                  createBugs: settings.jira?.createBugs ?? false,
                },
              };
            }
            const saved = await api.patchProjectV2(projectId, patch);
            projectState.setData(saved);
            reloadProjects();
            toast({ text: SW.repo.saved, tone: 'good' });
          }}
        />
      )}
    </Async>
  );
}

function RepoForm({
  initialRepo,
  initialJira,
  onSave,
}: {
  initialRepo: string;
  initialJira: string;
  onSave: (repo: string, jira: string) => Promise<void>;
}) {
  const [repo, setRepo] = useState(initialRepo);
  const [jira, setJira] = useState(initialJira);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const repoValue = repo.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/$/, '');
  const jiraValue = jira.trim().toUpperCase();
  const repoOk = REPO_RE.test(repoValue);
  const jiraOk = !jiraValue || JIRA_RE.test(jiraValue);

  return (
    <form
      className="col wizard-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!repoOk || !jiraOk || busy) return;
        setBusy(true);
        setFailure(null);
        try {
          await onSave(repoValue, jiraValue);
        } catch (error) {
          setFailure(messageOf(error));
        } finally {
          setBusy(false);
        }
      }}
    >
      <TextField
        label={SW.repo.repo}
        hint={repo && !repoOk ? SW.repo.repoInvalid : SW.repo.repoHint}
        value={repo}
        onChange={setRepo}
        placeholder="acme/cabinet"
        mono
      />
      <TextField
        label={SW.repo.jira}
        hint={jira && !jiraOk ? SW.repo.jiraInvalid : SW.repo.jiraHint}
        value={jira}
        onChange={setJira}
        placeholder="CYBER"
        mono
      />
      <div className="row-wrap">
        <button type="submit" className="btn btn-primary" disabled={!repoOk || !jiraOk || busy}>
          {SW.repo.save}
        </button>
      </div>
      {failure && <ErrorNote message={failure} />}
    </form>
  );
}

/* ──────────────────────────────── 5. CI ─────────────────────────────── */

export function CiStep({ projectId }: { projectId: string }) {
  const toast = useToast();
  const projectState = useAsync((signal) => api.getProject(projectId, signal), [projectId], Boolean(projectId));
  const tokensState = useAsync((signal) => api.listTokens(projectId, signal), [projectId], Boolean(projectId));
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const repo = projectState.data?.repo;
  const ciTokens = (tokensState.data ?? []).filter((item) => item.role === 'ci' && !item.revokedAt);

  const issue = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await api.issueToken({ name: `CI ${repo ?? projectId}`, role: 'ci', projectId });
      setToken(result.token);
      setCopied(false);
      tokensState.reload();
    } catch (error) {
      setFailure(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      toast({ text: SW.ci.copied, tone: 'good' });
    } catch {
      toast({ text: SW.ci.copyFailed, tone: 'warn' });
    }
  };

  const init = `node jules-qa.mjs init --hub ${origin} --project ${projectId}`;

  return (
    <div className="col">
      {projectState.data && !repo && <div className="alert warn">{SW.ci.noRepo}</div>}
      {!token && (
        <div className="row-wrap">
          <button type="button" className="btn btn-primary" disabled={busy || !projectId} onClick={issue}>
            {busy ? SW.ci.issuing : SW.ci.issue}
          </button>
        </div>
      )}
      {failure && <ErrorNote message={failure} />}

      {token && (
        <div className="token-box" role="status">
          <span className="asset-label" id="ci-token-label">
            {SW.ci.tokenLabel}
          </span>
          <div className="token-row">
            <code className="token-value" aria-labelledby="ci-token-label" data-testid="ci-token">
              {token}
            </code>
            <button type="button" className="btn btn-sm btn-primary" onClick={copy}>
              {copied ? SW.ci.copied : SW.ci.copy}
            </button>
          </div>
          <p className="text-sm token-once">{SW.ci.once}</p>
        </div>
      )}

      <div className="col">
        <h3 className="blk-sub">{SW.ci.how}</h3>
        <ol className="ci-steps">
          <li>
            {SW.ci.s1.split('JULES_TOKEN')[0]}
            <code className="mono">JULES_TOKEN</code>
            {SW.ci.s1.split('JULES_TOKEN')[1]}
          </li>
          <li>
            {SW.ci.s2}
            <pre className="asset-pre">{init}</pre>
          </li>
          <li>{SW.ci.s3}</li>
          <li>
            {SW.ci.s4}
            <pre className="asset-pre">JULES_URL={origin}</pre>
          </li>
        </ol>
      </div>

      {ciTokens.length > 0 && (
        <div className="col">
          <h3 className="blk-sub">{SW.ci.existing}</h3>
          <ul className="modules-list">
            {ciTokens.map((item) => (
              <li key={item.id}>
                {item.name} <span className="muted text-xs">· {formatDateTime(item.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
