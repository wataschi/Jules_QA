import { z } from 'zod';

export const uiSettingsSchema = z.object({
  qaTargetUrl: z.string().url(),
  qaMode: z.enum(['warm-up', 'regression']),
  qaScenarioPath: z.string().min(1),
  debugCache: z.boolean().default(false),
  llmBaseUrl: z.string().url().optional(),
  llmModelName: z.string().optional(),
});

export type UiSettings = z.infer<typeof uiSettingsSchema>;

export const runStatusSchema = z.enum(['queued', 'running', 'paused', 'passed', 'failed', 'cancelled']);

export type RunStatus = z.infer<typeof runStatusSchema>;

export const runTypeSchema = z.enum(['single', 'suite', 'suite-step']).default('single');

export type RunType = z.infer<typeof runTypeSchema>;

export const runRecordSchema = z.object({
  id: z.string(),
  status: runStatusSchema,
  runType: runTypeSchema.optional().default('single'),
  qaTargetUrl: z.string(),
  qaScenarioPath: z.string(),
  qaMode: z.enum(['warm-up', 'regression']),
  scenarioName: z.string().optional(),
  suiteId: z.string().optional(),
  parentRunId: z.string().optional(),
  childRunIds: z.array(z.string()).optional(),
  stepIndex: z.number().optional(),
  totalSteps: z.number().optional(),
  stopOnFailure: z.boolean().optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  exitCode: z.number().optional(),
  errorSummary: z.string().optional(),
  hitlReason: z.string().optional(),
  logs: z.array(z.string()),
  reportPaths: z.object({
    aggregate: z.string().optional(),
    playwright: z.string().optional(),
    midscene: z.array(z.string()).optional(),
    videos: z.array(z.string()).optional(),
    plans: z.array(z.string()).optional(),
  }).optional(),
  stepResults: z
    .array(
      z.object({
        index: z.number(),
        kind: z.enum(['step', 'assertion']),
        instruction: z.string(),
        status: z.enum(['passed', 'failed', 'healed', 'skipped']),
        attempts: z.number(),
        healed: z.boolean(),
        handledBy: z.enum(['midscene', 'playwright', 'stagehand', 'deterministic']),
        durationMs: z.number(),
        error: z.string().optional(),
        errorClass: z.string().optional(),
        thought: z.string().optional(),
      }),
    )
    .optional(),
  evidence: z
    .object({
      summary: z
        .object({
          total: z.number(),
          passed: z.number(),
          failed: z.number(),
          healed: z.number(),
        })
        .optional(),
      bugReports: z
        .array(
          z.object({
            id: z.string(),
            assertion: z.string(),
            severity: z.enum(['low', 'medium', 'high']),
            thought: z.string().optional(),
            rootCauseHypothesis: z.string().optional(),
          }),
        )
        .optional(),
      generatedSpec: z.string().optional(),
    })
    .optional(),
});

export type RunRecord = z.infer<typeof runRecordSchema>;

export const suiteDefinitionSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().default(''),
  scenarioPaths: z.array(z.string()).min(1),
  stopOnFailure: z.boolean().default(true),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export type SuiteDefinition = z.infer<typeof suiteDefinitionSchema>;

export const startRunRequestSchema = z.object({
  qaTargetUrl: z.string().url().optional(),
  qaMode: z.enum(['warm-up', 'regression']).optional(),
  qaScenarioPath: z.string().optional(),
  suiteId: z.string().optional(),
  debugCache: z.boolean().optional(),
}).refine(
  (data) => Boolean(data.qaScenarioPath || data.suiteId),
  { message: 'Provide qaScenarioPath or suiteId' },
);

export const defaultSettings: UiSettings = {
  qaTargetUrl: process.env.QA_TARGET_URL ?? 'http://host.docker.internal:3000',
  qaMode: (process.env.QA_MODE as UiSettings['qaMode']) ?? 'warm-up',
  qaScenarioPath: process.env.QA_SCENARIO_PATH ?? 'scenarios/invalid-password.yaml',
  debugCache: process.env.DEBUG?.includes('midscene:cache') ?? false,
  llmBaseUrl: process.env.MIDSCENE_MODEL_BASE_URL,
  llmModelName: process.env.MIDSCENE_MODEL_NAME,
};
