/**
 * Мостик між рушієм прогонів і реєстром.
 *
 * Закриває зворотний зв'язок циклу: результат автопрогону (`data/runs/<uuid>.json`)
 * потрапляє в елемент прогону реєстру, а звідти — в історію кейса і в `flakeScore`.
 * Без цього мостика `POST /runs/:id/auto` лише ставив прогони в чергу, і жоден
 * автоматичний результат ніколи не доходив до кейса.
 */
import { getRun as getEngineRun } from './runs-store.js';
import { isEnvironmentFailure } from '../engine/healer.js';
import { persistFlakeScores } from '../registry/dashboard.js';
import {
  getRun as getRegistryRun,
  listRunItems,
  syncAutoResult,
  updateRun,
} from '../registry/runs-store.js';

/** Статуси рушія, після яких результат уже не змінюється. */
const ENGINE_FINAL = new Set(['passed', 'failed', 'cancelled', 'skipped']);

const DEFAULT_INTERVAL_MS = 4_000;
/** Стеля спостереження: довгий набір із HITL-паузами може тривати годинами. */
const DEFAULT_MAX_MS = 3 * 60 * 60 * 1000;

interface Watcher {
  timer: NodeJS.Timeout;
  startedAt: number;
}

const watchers = new Map<string, Watcher>();

export interface SyncOutcome {
  /** Скільки елементів отримали фінальний результат саме зараз. */
  updated: number;
  /** Скільки автопрогонів ще виконуються. */
  pending: number;
  /** Скільки посилань на прогони рушія не знайдено на диску. */
  missing: number;
}

function engineEvidence(run: {
  reportPaths?: {
    aggregate?: string;
    playwright?: string;
    midscene?: string[];
    videos?: string[];
  };
}): string[] {
  const paths = run.reportPaths ?? {};
  return [
    ...(paths.aggregate ? [paths.aggregate] : []),
    ...(paths.midscene ?? []),
    ...(paths.videos ?? []),
  ];
}

interface EngineBugReport {
  assertion: string;
  severity?: 'low' | 'medium' | 'high';
  thought?: string;
  rootCauseHypothesis?: string;
  confidence?: 'confirmed' | 'unconfirmed';
  contradictedBy?: string;
  reportPath?: string;
}

/**
 * Дефект для реєстру з підтверджених вердиктів рушія.
 *
 * Непідтверджені (модель не пояснила вердикт або подальші кроки йому
 * суперечать) свідомо НЕ стають багами: у реальному прогоні саме такий
 * вердикт дав фантомний дефект там, де наступний крок спокійно клікнув
 * елемент зі списку. Вони лишаються видимими в коментарі елемента прогону.
 */
function bugReportToDefect(
  reports: EngineBugReport[],
): { title: string; severity?: 'low' | 'medium' | 'high'; details: string } | undefined {
  const confirmed = reports.filter((report) => (report.confidence ?? 'confirmed') === 'confirmed');
  if (confirmed.length === 0) return undefined;

  // Найсерйозніший вердикт визначає заголовок дефекту.
  const rank = { high: 3, medium: 2, low: 1 } as const;
  const lead = confirmed.reduce((worst, report) =>
    rank[report.severity ?? 'medium'] > rank[worst.severity ?? 'medium'] ? report : worst,
  );

  const details = [
    lead.rootCauseHypothesis,
    lead.thought ? `Спостереження моделі: ${lead.thought}` : undefined,
    lead.reportPath ? `Звіт: ${lead.reportPath}` : undefined,
    confirmed.length > 1 ? `Разом підтверджених перевірок: ${confirmed.length}` : undefined,
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    title: `Перевірка не пройдена: ${lead.assertion.trim().slice(0, 140)}`,
    ...(lead.severity ? { severity: lead.severity } : {}),
    details,
  };
}

/** Непідтверджені вердикти — рядком у коментар, щоб їх було видно людині. */
function unconfirmedNote(reports: EngineBugReport[]): string | undefined {
  const unconfirmed = reports.filter((report) => report.confidence === 'unconfirmed');
  if (unconfirmed.length === 0) return undefined;
  const list = unconfirmed
    .map((report) => `«${report.assertion.trim().slice(0, 80)}»${report.contradictedBy ? ` (${report.contradictedBy})` : ''}`)
    .join('; ');
  return `Непідтверджені вердикти, потрібне око людини: ${list}`;
}

/**
 * Чи впав прогін через недоступне середовище. Дивимо і на підсумок прогону
 * (там осідає фатальна причина), і на помилки кроків.
 */
function blockedByEnvironment(run: {
  errorSummary?: string;
  stepResults?: Array<{ error?: string }>;
}): boolean {
  if (run.errorSummary && isEnvironmentFailure(run.errorSummary)) return true;
  return (run.stepResults ?? []).some((step) => step.error && isEnvironmentFailure(step.error));
}

function engineDuration(run: { startedAt?: string; finishedAt?: string }): number | undefined {
  if (!run.startedAt || !run.finishedAt) return undefined;
  const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/**
 * Переносить у реєстр результати всіх автопрогонів, прив'язаних до прогону реєстру.
 * Ідемпотентна: елемент, уже оновлений рушієм, повторно не перезаписується.
 */
export async function syncAutoResults(registryRunId: string): Promise<SyncOutcome> {
  const outcome: SyncOutcome = { updated: 0, pending: 0, missing: 0 };
  const items = listRunItems(registryRunId);

  for (const item of items) {
    if (!item.autoRunId) continue;
    // Уже синхронізовано: статус проставив рушій і він не «untested».
    if (item.updatedBy === 'engine' && item.status !== 'untested') continue;

    const engine = await getEngineRun(item.autoRunId).catch(() => null);
    if (!engine) {
      outcome.missing += 1;
      continue;
    }
    if (!ENGINE_FINAL.has(engine.status)) {
      outcome.pending += 1;
      continue;
    }

    // Пропущений крок набору — це не «впав», а «не виконувався».
    const skipped = engine.status === 'skipped';
    const healed = (engine.evidence?.summary?.healed ?? 0) > 0;
    const blocked = !skipped && engine.status === 'failed' && blockedByEnvironment(engine);
    const reports = (engine.evidence?.bugReports ?? []) as EngineBugReport[];
    // Коли лежала ціль, «дефект» був би наклепом на застосунок.
    const defect = skipped || blocked ? undefined : bugReportToDefect(reports);
    const comment = [
      skipped ? 'Прогін рушія пропущено (stopOnFailure)' : engine.errorSummary,
      skipped || blocked ? undefined : unconfirmedNote(reports),
    ]
      .filter(Boolean)
      .join(' · ');

    syncAutoResult(registryRunId, item.caseId, {
      autoRunId: item.autoRunId,
      engineStatus: skipped ? 'cancelled' : (engine.status as 'passed' | 'failed' | 'cancelled'),
      healed,
      ...(blocked ? { blocked: true } : {}),
      ...(engineDuration(engine) !== undefined ? { durationMs: engineDuration(engine) } : {}),
      evidence: engineEvidence(engine),
      ...(comment ? { comment } : {}),
      ...(defect ? { defect } : {}),
    });
    outcome.updated += 1;
  }

  return outcome;
}

/** Перераховує flakeScore кейсів і, якщо авто-прогін дійшов до кінця, закриває його. */
export function settleRun(registryRunId: string): void {
  try {
    const run = getRegistryRun(registryRunId);
    if (!run) return;
    persistFlakeScores(run.projectId);

    if (run.state !== 'open') return;
    const items = listRunItems(registryRunId);
    const everyItemAuto = items.length > 0 && items.every((item) => Boolean(item.autoRunId));
    const everyItemDone = items.every((item) => item.status !== 'untested');
    if (run.kind === 'auto' && everyItemAuto && everyItemDone) {
      updateRun(registryRunId, { state: 'completed' });
    }
  } catch {
    // Службова операція: не повинна валити запит, який її викликав.
  }
}

export interface WatchOptions {
  intervalMs?: number;
  maxMs?: number;
}

/**
 * Починає спостереження за автопрогонами прогону реєстру.
 * Повторний виклик для того самого прогону нічого не робить.
 */
export function watchAutoResults(registryRunId: string, options: WatchOptions = {}): void {
  if (watchers.has(registryRunId)) return;

  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxMs = options.maxMs ?? DEFAULT_MAX_MS;
  const startedAt = Date.now();

  const tick = async (): Promise<void> => {
    let finished = false;
    try {
      const { pending } = await syncAutoResults(registryRunId);
      finished = pending === 0;
    } catch {
      finished = true;
    }
    if (finished || Date.now() - startedAt > maxMs) {
      stopWatch(registryRunId);
      if (finished) settleRun(registryRunId);
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();
  watchers.set(registryRunId, { timer, startedAt });
  void tick();
}

export function stopWatch(registryRunId: string): void {
  const watcher = watchers.get(registryRunId);
  if (!watcher) return;
  clearInterval(watcher.timer);
  watchers.delete(registryRunId);
}

export function isWatching(registryRunId: string): boolean {
  return watchers.has(registryRunId);
}

/** Для тестів і коректного завершення процесу. */
export function stopAllWatchers(): void {
  for (const id of Array.from(watchers.keys())) stopWatch(id);
}
