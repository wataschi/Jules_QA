/**
 * Налаштування проєкту Jules 2.0: репозиторій, Jira, Telegram, пороги й адреса
 * Jules для посилань. Зберігається через `PATCH /projects/:id` (поля `repo`,
 * `settings`). `settings` надсилаємо цілком: сервер зливає лише верхній рівень.
 */

import { useEffect, useState } from 'react';
import { api } from '../../api';
import { Loading } from '../../components/states';
import { CheckField, TextField } from '../../components/ui';
import { useApp, useToast } from '../../context/AppContext';
import { messageOf } from '../../hooks/useAsync';
import type { Project, ProjectSettings } from '../../types';
import { SS } from './strings';

const DEFAULT_THRESHOLDS: ProjectSettings['thresholds'] = { staleTaskHours: 24, leaseMinutes: 30, mutationP1: 60, flakeScore: 0.3 };

interface Draft {
  repo: string;
  dashboardUrl: string;
  jiraKey: string;
  jiraType: string;
  jiraAssignee: string;
  jiraBugs: boolean;
  telegramOn: boolean;
  telegramChat: string;
  staleTaskHours: string;
  leaseMinutes: string;
  mutationP1: string;
  flakeScore: string;
}

function draftOf(project: Project | undefined): Draft {
  const settings = project?.settings;
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(settings?.thresholds ?? {}) };
  return {
    repo: project?.repo ?? '',
    dashboardUrl: settings?.dashboardUrl ?? '',
    jiraKey: settings?.jira?.projectKey ?? '',
    jiraType: settings?.jira?.issueType ?? 'Task',
    jiraAssignee: settings?.jira?.assignee ?? '',
    jiraBugs: settings?.jira?.createBugs ?? false,
    telegramOn: settings?.telegram?.enabled ?? false,
    telegramChat: settings?.telegram?.chatId ?? '',
    staleTaskHours: String(thresholds.staleTaskHours),
    leaseMinutes: String(thresholds.leaseMinutes),
    mutationP1: String(thresholds.mutationP1),
    flakeScore: String(thresholds.flakeScore),
  };
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

export function ProcessCard() {
  const { project, reloadProjects } = useApp();
  const toast = useToast();
  const [saved, setSaved] = useState<Project | undefined>(project);
  const [draft, setDraft] = useState<Draft>(() => draftOf(project));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Скидаємо чернетку лише коли змінився сам проєкт (інший id або нова версія
  // з сервера), а не кожне перезавантаження списку проєктів.
  useEffect(() => {
    setSaved(project);
    setDraft(draftOf(project));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, project?.updatedAt]);

  const set = <K extends keyof Draft>(key: K) => (value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const numbers = {
    staleTaskHours: Number(draft.staleTaskHours),
    leaseMinutes: Number(draft.leaseMinutes),
    mutationP1: Number(draft.mutationP1),
    flakeScore: Number(draft.flakeScore),
  };
  const invalid = {
    repo: draft.repo.trim() !== '' && !REPO_RE.test(draft.repo.trim()),
    staleTaskHours: !(numbers.staleTaskHours > 0),
    leaseMinutes: !(numbers.leaseMinutes > 0),
    mutationP1: !(numbers.mutationP1 >= 0 && numbers.mutationP1 <= 100) || draft.mutationP1.trim() === '',
    flakeScore: !(numbers.flakeScore >= 0 && numbers.flakeScore <= 1) || draft.flakeScore.trim() === '',
  };
  const hasErrors = Object.values(invalid).some(Boolean);

  async function save() {
    if (!project || hasErrors) return;
    setBusy(true);
    setError(null);
    const base = saved?.settings ?? project.settings;
    const settings = {
      confluenceRoots: base?.confluenceRoots ?? [],
      figmaFiles: base?.figmaFiles ?? [],
      ...base,
      // Порожній ключ — прибрати Jira з проєкту.
      jira: draft.jiraKey.trim()
        ? {
            projectKey: draft.jiraKey.trim(),
            issueType: draft.jiraType.trim() || 'Task',
            assignee: draft.jiraAssignee.trim() || undefined,
            createBugs: draft.jiraBugs,
          }
        : null,
      telegram: { enabled: draft.telegramOn, chatId: draft.telegramChat.trim() || undefined },
      thresholds: numbers,
      dashboardUrl: draft.dashboardUrl.trim() || null,
    };
    try {
      const next = await api.patchProjectV2(project.id, { repo: draft.repo.trim() || undefined, settings });
      setSaved({ ...project, ...next, settings: next.settings ?? (settings as ProjectSettings), repo: next.repo ?? (draft.repo.trim() || undefined) });
      toast({ text: SS.saved, tone: 'good' });
      reloadProjects();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!project) {
    return (
      <section className="card">
        <div className="card-body">
          <Loading rows={6} />
        </div>
      </section>
    );
  }

  return (
    <form
      className="card"
      aria-label={SS.repoTitle}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="process-grid">
        <fieldset className="process-group">
          <legend>{SS.repoTitle}</legend>
          <TextField label={SS.repo} value={draft.repo} onChange={set('repo')} hint={invalid.repo ? SS.repoInvalid : SS.repoHint} mono placeholder="owner/name" />
          <TextField
            label={SS.dashboardUrl}
            value={draft.dashboardUrl}
            onChange={set('dashboardUrl')}
            hint={SS.dashboardUrlHint}
            type="url"
            mono
          />
        </fieldset>

        <fieldset className="process-group">
          <legend>{SS.jiraTitle}</legend>
          <TextField label={SS.jiraKey} value={draft.jiraKey} onChange={set('jiraKey')} hint={SS.jiraKeyHint} mono />
          <TextField label={SS.jiraType} value={draft.jiraType} onChange={set('jiraType')} disabled={!draft.jiraKey.trim()} />
          <TextField
            label={SS.jiraAssignee}
            value={draft.jiraAssignee}
            onChange={set('jiraAssignee')}
            hint={SS.jiraAssigneeHint}
            mono
            disabled={!draft.jiraKey.trim()}
          />
          <CheckField label={SS.jiraBugs} checked={draft.jiraBugs} onChange={set('jiraBugs')} disabled={!draft.jiraKey.trim()} />
        </fieldset>

        <fieldset className="process-group">
          <legend>{SS.telegramTitle}</legend>
          <CheckField label={SS.telegramOn} checked={draft.telegramOn} onChange={set('telegramOn')} />
          <TextField
            label={SS.telegramChat}
            value={draft.telegramChat}
            onChange={set('telegramChat')}
            hint={SS.telegramChatHint}
            mono
            disabled={!draft.telegramOn}
          />
        </fieldset>

        <fieldset className="process-group process-wide">
          <legend>{SS.thresholdsTitle}</legend>
          <div className="settings-fields">
            <TextField
              label={SS.staleTaskHours}
              value={draft.staleTaskHours}
              onChange={set('staleTaskHours')}
              hint={invalid.staleTaskHours ? SS.invalidNumber : SS.staleTaskHoursHint}
              type="number"
            />
            <TextField
              label={SS.leaseMinutes}
              value={draft.leaseMinutes}
              onChange={set('leaseMinutes')}
              hint={invalid.leaseMinutes ? SS.invalidNumber : SS.leaseMinutesHint}
              type="number"
            />
            <TextField
              label={SS.mutationP1}
              value={draft.mutationP1}
              onChange={set('mutationP1')}
              hint={invalid.mutationP1 ? '0–100' : SS.mutationP1Hint}
              type="number"
            />
            <TextField
              label={SS.flakeScore}
              value={draft.flakeScore}
              onChange={set('flakeScore')}
              hint={invalid.flakeScore ? '0–1' : SS.flakeScoreHint}
              type="number"
            />
          </div>
        </fieldset>
      </div>
      <div className="card-body process-foot">
        {error && <div className="alert bad">{error}</div>}
        <div className="row">
          <span className="spacer" />
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || hasErrors}>
            {SS.saveProcess}
          </button>
        </div>
      </div>
    </form>
  );
}
