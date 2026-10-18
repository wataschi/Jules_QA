/**
 * Тижневий звіт: цифри рахує Jules (модель їх не вигадує), висновки додає
 * агент QA-ліда через скіл `qa-weekly`. Одна задача Jira на тиждень із міткою
 * `jules-weekly-<тиждень>`: повторна публікація оновлює її, а не плодить дублі.
 */
import { execute, nowIso, queryOne, type Row } from '../registry/db.js';
import { newId } from '../registry/ids.js';
import { requireProject } from '../registry/projects-store.js';
import { enqueueNotification } from '../registry/notifications-store.js';
import { buildWeeklyReport, isoWeekLabel, type WeeklyReport } from '../reporting/weekly-report.js';
import { createJiraClientFromEnv, isJiraConfigured, jiraIssueUrl, upsertWeeklyIssue } from '../integrations/jira.js';
import { buildWeeklyData } from './status-data.js';

/** Минулий повний ISO-тиждень відносно дати. */
export function previousWeekLabel(now = new Date()): string {
  return isoWeekLabel(new Date(now.getTime() - 7 * 86_400_000));
}

export function weeklyPreview(projectId: string, week = previousWeekLabel(), insights?: string): WeeklyReport & { week: string } {
  return { ...buildWeeklyReport(buildWeeklyData(projectId, week, insights)), week };
}

export interface PublishedWeekly {
  week: string;
  report: WeeklyReport;
  jira?: { key: string; url: string; created: boolean };
}

export function publishedWeekly(projectId: string, week: string): { key: string; url?: string } | null {
  const row = queryOne<Row>(
    `SELECT key, url FROM external_issues WHERE project_id = ? AND system = 'jira' AND kind = 'weekly_report' AND ref = ?`,
    [projectId, week],
  );
  return row ? { key: String(row.key), url: (row.url as string | null) ?? undefined } : null;
}

export async function publishWeekly(
  projectId: string,
  options: { week?: string; insights?: string; fetch?: typeof fetch } = {},
): Promise<PublishedWeekly> {
  const project = requireProject(projectId);
  const week = options.week ?? previousWeekLabel();
  const report = buildWeeklyReport(buildWeeklyData(projectId, week, options.insights));
  let jira: PublishedWeekly['jira'];

  if (project.settings.jira && isJiraConfigured()) {
    const client = createJiraClientFromEnv({ fetch: options.fetch });
    const result = await upsertWeeklyIssue(client, {
      projectKey: project.settings.jira.projectKey,
      issueType: project.settings.jira.issueType,
      label: report.label,
      summary: report.summary,
      description: report.wikiMarkup,
      assignee: project.settings.jira.assignee,
    });
    const url = jiraIssueUrl(process.env.JIRA_BASE_URL ?? '', result.key);
    const at = nowIso();
    execute(
      `INSERT INTO external_issues (id, project_id, system, kind, key, url, ref, created_at, updated_at)
       VALUES (?, ?, 'jira', 'weekly_report', ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, system, kind, ref) DO UPDATE SET key = excluded.key, url = excluded.url, updated_at = excluded.updated_at`,
      [newId('ext'), projectId, result.key, url, week, at, at],
    );
    jira = { key: result.key, url, created: result.created };
  }
  enqueueNotification({ kind: 'weekly', project: project.name, week, markdown: report.markdown }, projectId);
  return { week, report, jira };
}
