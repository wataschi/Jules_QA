import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { artifactNameCandidates, scenarioKey } from '../config/env.js';
import { getResultsDir } from '../server/data-paths.js';

export const stepStatusSchema = z.enum(['passed', 'failed', 'healed', 'skipped']);
export type StepStatus = z.infer<typeof stepStatusSchema>;

export const handledBySchema = z.enum(['midscene', 'playwright', 'stagehand', 'deterministic']);
export type HandledBy = z.infer<typeof handledBySchema>;

export const stepResultSchema = z.object({
  index: z.number(),
  kind: z.enum(['step', 'assertion']),
  instruction: z.string(),
  status: stepStatusSchema,
  attempts: z.number().default(1),
  healed: z.boolean().default(false),
  handledBy: handledBySchema.default('midscene'),
  durationMs: z.number().default(0),
  /** Скільки HTTP-викликів моделі знадобилось на цей крок (0 = без LLM). */
  modelCalls: z.number().optional(),
  error: z.string().optional(),
  errorClass: z.string().optional(),
  thought: z.string().optional(),
});
export type StepResult = z.infer<typeof stepResultSchema>;

export const bugReportSchema = z.object({
  id: z.string(),
  assertion: z.string(),
  thought: z.string().optional(),
  rootCauseHypothesis: z.string(),
  severity: z.enum(['low', 'medium', 'high']).default('medium'),
  detectedAt: z.string(),
  reportPath: z.string().optional(),
  /**
   * `unconfirmed` — дефект під питанням: або модель не пояснила вердикт, або
   * подальший хід прогону йому суперечить (сценарій поїхав далі, отже UI
   * насправді працював). Такі записи не варто нести розробнику як баг.
   */
  confidence: z.enum(['confirmed', 'unconfirmed']).default('confirmed'),
  /** Номер кроку (1-based), після якого стояла проміжна перевірка. */
  checkpointAfterStep: z.number().optional(),
  /** Чому впевненість знижено: що саме суперечить вердикту. */
  contradictedBy: z.string().optional(),
});
export type BugReport = z.infer<typeof bugReportSchema>;

export const runResultsSchema = z.object({
  scenarioId: z.string(),
  goal: z.string(),
  targetUrl: z.string(),
  mode: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  passed: z.boolean(),
  steps: z.array(stepResultSchema),
  bugReports: z.array(bugReportSchema).default([]),
  /**
   * Причина падіння, яке сталося поза кроками (навігація, вхід). Без неї
   * прогін показував лише «Test exited with code 1» і справжня причина
   * лишалася тільки в логах.
   */
  fatalError: z.string().optional(),
  generatedSpecPath: z.string().optional(),
  summary: z.object({
    total: z.number(),
    passed: z.number(),
    failed: z.number(),
    healed: z.number(),
    /** Кроки/ассершени, до яких прогін не дійшов після фатального падіння. */
    skipped: z.number().default(0),
    /** Сумарна кількість викликів моделі за прогін (видимість вартості). */
    modelCalls: z.number().optional(),
  }),
});
export type RunResults = z.infer<typeof runResultsSchema>;

/**
 * Accumulates per-step evidence during a run, then writes a single
 * `<scenarioId>.json` results file consumed by the dashboard / aggregate report.
 */
export class ResultsCollector {
  private readonly steps: StepResult[] = [];
  private readonly bugReports: BugReport[] = [];
  private generatedSpecPath?: string;
  private fatalError?: string;
  private readonly startedAt = new Date().toISOString();

  constructor(
    private readonly meta: { scenarioId: string; goal: string; targetUrl: string; mode: string },
  ) {}

  record(result: StepResult): void {
    this.steps.push(result);
  }

  addBugReport(report: BugReport): void {
    this.bugReports.push(report);
  }

  setGeneratedSpec(specPath: string): void {
    this.generatedSpecPath = specPath;
  }

  /** Падіння поза кроками: зберігаємо причину, щоб вона дійшла до дашборда. */
  setFatalError(message: string): void {
    this.fatalError ??= message;
  }

  hasFailures(): boolean {
    return this.steps.some((step) => step.status === 'failed') || this.bugReports.length > 0;
  }

  /**
   * Знижує впевненість у дефектах із проміжних перевірок, яким суперечить
   * подальший хід прогону: якщо після чекпойнта хоч один звичайний крок
   * пройшов, застосунок у цьому місці працював — падіння майже напевно
   * хибне спрацювання самої перевірки, а не баг.
   */
  private reconcileBugReports(): BugReport[] {
    return this.bugReports.map((report) => {
      const afterStep = report.checkpointAfterStep;
      if (afterStep === undefined) return report;
      const later = this.steps.find(
        (step) =>
          step.kind === 'step' &&
          step.index >= afterStep &&
          (step.status === 'passed' || step.status === 'healed'),
      );
      if (!later) return report;
      return {
        ...report,
        confidence: 'unconfirmed' as const,
        contradictedBy: `крок ${later.index + 1} «${later.instruction.slice(0, 80)}» пройшов після цієї перевірки`,
      };
    });
  }

  build(): RunResults {
    const passed = this.steps.filter((s) => s.status === 'passed' || s.status === 'healed').length;
    const failed = this.steps.filter((s) => s.status === 'failed').length;
    const healed = this.steps.filter((s) => s.healed).length;
    const skipped = this.steps.filter((s) => s.status === 'skipped').length;
    const modelCalls = this.steps.reduce((sum, s) => sum + (s.modelCalls ?? 0), 0);

    return runResultsSchema.parse({
      scenarioId: this.meta.scenarioId,
      goal: this.meta.goal,
      targetUrl: this.meta.targetUrl,
      mode: this.meta.mode,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      passed: failed === 0 && this.bugReports.length === 0,
      steps: this.steps,
      bugReports: this.reconcileBugReports(),
      generatedSpecPath: this.generatedSpecPath,
      ...(this.fatalError ? { fatalError: this.fatalError } : {}),
      summary: { total: this.steps.length, passed, failed, healed, skipped, modelCalls },
    });
  }

  async write(): Promise<string> {
    return writeRunResults(this.build());
  }
}

/** Пише `results/<scenarioKey>.json` — ключ похідний від назви сценарію та цілі. */
export async function writeRunResults(results: RunResults): Promise<string> {
  const dir = getResultsDir();
  await fs.mkdir(dir, { recursive: true });
  const key = scenarioKey(results.scenarioId, results.targetUrl);
  const filePath = path.join(dir, `${key}.json`);
  await fs.writeFile(filePath, JSON.stringify(results, null, 2), 'utf-8');
  return filePath;
}

/**
 * Читає результати за ключем, з fallback на стару назву без хеша, щоб уже
 * наявні `results/<name>.json` не зникли після переходу на ключі.
 */
export async function loadRunResults(
  scenarioIdOrKey: string,
  targetUrl?: string,
): Promise<RunResults | null> {
  for (const name of artifactNameCandidates(scenarioIdOrKey, targetUrl)) {
    try {
      const raw = await fs.readFile(path.join(getResultsDir(), `${name}.json`), 'utf-8');
      return runResultsSchema.parse(JSON.parse(raw));
    } catch {
      /* пробуємо наступного кандидата */
    }
  }
  return null;
}
