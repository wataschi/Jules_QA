/**
 * Фонові задачі хаба. Реєструються один раз при створенні застосунку, а
 * запускаються лише справжнім сервером (`start.ts`), не тестами.
 */
import { listProjects } from '../registry/projects-store.js';
import { expireLeases, staleTasks } from '../registry/tasks-store.js';
import { enqueueNotification, failNotification, markNotification, pendingNotifications, skipNotification } from '../registry/notifications-store.js';
import { formatEvent, isTelegramConfigured, TelegramNotifier } from '../notify/telegram.js';
import { registerBackgroundJob } from './background.js';
import { runHealthChecks } from './health.js';
import { syncProjectInputs } from './inputs.js';
import { previousWeekLabel, publishWeekly, publishedWeekly } from './weekly.js';
import { dashboardUrl } from './status-data.js';

let registered = false;

const minutes = (name: string, fallback: number) => Math.max(1, Number(process.env[name] ?? fallback)) * 60_000;

/** Нагадування про задачі, що чекають довше порогу проєкту. */
export function notifyStaleTasks(now = new Date()): number {
  let queued = 0;
  for (const project of listProjects()) {
    const base = dashboardUrl(project.id);
    for (const task of staleTasks(project.id, project.settings.thresholds.staleTaskHours, now)) {
      const url = base ? `${base.split('?')[0]}tasks/${encodeURIComponent(task.id)}` : undefined;
      if (enqueueNotification({ kind: 'stale_task', taskId: task.id, title: task.title, ageHours: task.ageHours, url }, project.id)) queued += 1;
    }
  }
  return queued;
}

/** Відправляє ненадіслані сповіщення в Telegram (чат проєкту або загальний). */
export async function deliverNotifications(fetchImpl?: typeof fetch): Promise<{ sent: number; failed: number }> {
  if (!isTelegramConfigured()) return { sent: 0, failed: 0 };
  const projects = new Map(listProjects().map((project) => [project.id, project]));
  let sent = 0;
  let failed = 0;
  for (const item of pendingNotifications()) {
    const project = item.projectId ? projects.get(item.projectId) : undefined;
    if (project && project.settings.telegram && !project.settings.telegram.enabled) {
      // Закриваємо з причиною, інакше вимкнений проєкт назавжди займає голову черги.
      skipNotification(item.id, 'disabled');
      continue;
    }
    const chatId = project?.settings.telegram?.chatId || process.env.TELEGRAM_CHAT_ID || '';
    try {
      await new TelegramNotifier({ token: process.env.TELEGRAM_BOT_TOKEN ?? '', chatId, fetch: fetchImpl }).send(formatEvent(item.event));
      markNotification(item.id, { sent: true });
      sent += 1;
    } catch (error) {
      failNotification(item.id, error instanceof Error ? error.message : String(error));
      failed += 1;
    }
  }
  return { sent, failed };
}

/** Тижнева задача: у понеділок після 9:00 за часом сервера, раз на тиждень. */
export async function maybePublishWeekly(now = new Date()): Promise<string[]> {
  if (now.getDay() !== 1 || now.getHours() < 9) return [];
  const week = previousWeekLabel(now);
  const done: string[] = [];
  for (const project of listProjects()) {
    if (!project.settings.jira || publishedWeekly(project.id, week)) continue;
    // Помилка одного проєкту (Jira, права, дані) не зупиняє звітів інших; наступна спроба — за пів години.
    try {
      await publishWeekly(project.id, { week });
      done.push(project.id);
    } catch (error) {
      console.warn(`Тижневий звіт ${project.key} за ${week} не опубліковано: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return done;
}

export function registerCoreJobs(): void {
  if (registered) return;
  registered = true;
  registerBackgroundJob({ name: 'оренди задач', everyMs: 60_000, run: () => void expireLeases() });
  registerBackgroundJob({ name: 'стан інтеграцій', everyMs: minutes('JULES_HEALTH_MINUTES', 5), run: async () => void (await runHealthChecks()) });
  registerBackgroundJob({ name: 'задачі, що чекають', everyMs: minutes('JULES_STALE_MINUTES', 60), run: () => void notifyStaleTasks() });
  registerBackgroundJob({
    name: 'оновлення входів',
    everyMs: minutes('JULES_INPUT_SYNC_MINUTES', 60),
    run: async () => {
      for (const project of listProjects()) await syncProjectInputs(project.id, { author: 'jules' });
    },
  });
  registerBackgroundJob({ name: 'тижневий звіт', everyMs: 30 * 60_000, run: async () => void (await maybePublishWeekly()) });
  registerBackgroundJob({ name: 'сповіщення', everyMs: 60_000, run: async () => void (await deliverNotifications()) });
}
