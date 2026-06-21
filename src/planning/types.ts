import { z } from 'zod';

/**
 * A checkpoint is an assertion bound to a specific step: it is evaluated
 * immediately AFTER that step runs, while the page is still in the intermediate
 * state the assertion describes (e.g. "catalog list is shown" before the agent
 * clicks into a dataset detail page). `afterStep` is 1-based.
 */
export const checkpointSchema = z.object({
  afterStep: z.number().int().min(1),
  assertion: z.string(),
});

export type Checkpoint = z.infer<typeof checkpointSchema>;

export const checklistSchema = z.object({
  scenarioId: z.string(),
  goal: z.string(),
  targetUrl: z.string().url(),
  steps: z.array(z.string()),
  assertions: z.array(z.string()),
  checkpoints: z.array(checkpointSchema).default([]),
  generatedAt: z.string().optional(),
});

export type Checklist = z.infer<typeof checklistSchema>;

export const scenarioAuthSchema = z.object({
  profile: z.string().min(1),
});

export type ScenarioAuth = z.infer<typeof scenarioAuthSchema>;

export const scenarioYamlSchema = z.object({
  name: z.string(),
  goal: z.string(),
  target_url: z.string().url().optional(),
  tags: z.array(z.string()).default([]),
  group: z.string().optional(),
  hints: z.array(z.string()).default([]),
  steps: z.array(z.string()).default([]),
  checkpoints: z.array(checkpointSchema).default([]),
  success_criteria: z.array(z.string()).default([]),
  auth: scenarioAuthSchema.optional(),
  navigation: z
    .object({
      type: z.enum(['deterministic', 'ai']).default('ai'),
      url: z.string().url().optional(),
      instruction: z.string().optional(),
    })
    .optional(),
});

export type ScenarioYaml = z.infer<typeof scenarioYamlSchema>;

export interface ChecklistItem {
  kind: 'step' | 'assertion';
  instruction: string;
  index: number;
}

/** Step prefixes: `secret:` (vault typing), `human:` (operator pause). */
export type StepMarker = 'normal' | 'secret' | 'human';

export function parseStepMarker(step: string): { marker: StepMarker; instruction: string } {
  const trimmed = step.trimStart();
  if (trimmed.startsWith('secret:')) {
    return { marker: 'secret', instruction: trimmed.slice('secret:'.length).trim() };
  }
  if (trimmed.startsWith('human:')) {
    return { marker: 'human', instruction: trimmed.slice('human:'.length).trim() };
  }
  return { marker: 'normal', instruction: step };
}
