import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
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
  generatedSpecPath: z.string().optional(),
  summary: z.object({
    total: z.number(),
    passed: z.number(),
    failed: z.number(),
    healed: z.number(),
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

  hasFailures(): boolean {
    return this.steps.some((step) => step.status === 'failed') || this.bugReports.length > 0;
  }

  build(): RunResults {
    const passed = this.steps.filter((s) => s.status === 'passed' || s.status === 'healed').length;
    const failed = this.steps.filter((s) => s.status === 'failed').length;
    const healed = this.steps.filter((s) => s.healed).length;

    return runResultsSchema.parse({
      scenarioId: this.meta.scenarioId,
      goal: this.meta.goal,
      targetUrl: this.meta.targetUrl,
      mode: this.meta.mode,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      passed: failed === 0 && this.bugReports.length === 0,
      steps: this.steps,
      bugReports: this.bugReports,
      generatedSpecPath: this.generatedSpecPath,
      summary: { total: this.steps.length, passed, failed, healed },
    });
  }

  async write(): Promise<string> {
    return writeRunResults(this.build());
  }
}

export async function writeRunResults(results: RunResults): Promise<string> {
  const dir = getResultsDir();
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${results.scenarioId}.json`);
  await fs.writeFile(filePath, JSON.stringify(results, null, 2), 'utf-8');
  return filePath;
}

export async function loadRunResults(scenarioId: string): Promise<RunResults | null> {
  try {
    const raw = await fs.readFile(path.join(getResultsDir(), `${scenarioId}.json`), 'utf-8');
    return runResultsSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
