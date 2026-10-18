/**
 * Фонові задачі сервера: перевірка стану інтеграцій, повернення прострочених
 * оренд задач, вік запитів, тижневий звіт і сповіщення. Кожен тік ізольований:
 * помилка одного не зупиняє інших.
 */
type Job = { name: string; everyMs: number; run: () => Promise<void> | void };

const jobs: Job[] = [];
const timers: NodeJS.Timeout[] = [];

export function registerBackgroundJob(job: Job): void {
  jobs.push(job);
}

export function startBackgroundJobs(): void {
  if (process.env.JULES_BACKGROUND === '0') return;
  for (const job of jobs) {
    const tick = async () => {
      try {
        await job.run();
      } catch (error) {
        console.warn(`[jobs] ${job.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const timer = setInterval(tick, job.everyMs);
    timer.unref();
    timers.push(timer);
    void tick();
  }
}

export function stopBackgroundJobs(): void {
  while (timers.length > 0) clearInterval(timers.pop());
}
