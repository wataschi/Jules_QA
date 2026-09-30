import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { artifactNameCandidates, getEnv, scenarioKey, setActiveTargetUrl } from '../config/env.js';
import { chatJson, resolveModel } from '../config/models.js';
import { getPlansDir } from '../server/data-paths.js';
import { checklistSchema, type Checklist, type ScenarioYaml } from './types.js';

const plannerCheckpointSchema = z.object({
  afterStep: z.number().int().min(1),
  assertion: z.string(),
});

const plannerResponseSchema = z.object({
  steps: z.array(z.string()),
  assertions: z.array(z.string()),
  checkpoints: z.array(plannerCheckpointSchema).default([]),
});

type PlannerResponse = z.infer<typeof plannerResponseSchema>;

const AUTHORING_RULES = `Rules:
- Each step is exactly ONE imperative UI action for a vision browser agent (navigate, click, type, select, scroll, press, wait). No compound steps.
- Reference targets by visible label/role/placeholder, never CSS selectors.
- Keep 3-8 steps. Add an explicit "wait for the page to finish loading" where a navigation happens.
- Decide WHEN each success check can be verified and place it accordingly:
  - "checkpoints": checks about an INTERMEDIATE page state that stops being true after later steps (e.g. "a list of results is shown" BEFORE clicking into a detail). Each checkpoint has { "afterStep": <1-based step number it must be verified right after>, "assertion": <text> }.
  - "assertions": checks about the FINAL end state, verified after all steps.
- Every check belongs to exactly one of checkpoints/assertions; never duplicate the same check in both.
- assertions and checkpoint assertions describe observable, verifiable UI outcomes (concrete visible text/state).
- Safety: never include payment, deletion, logout or destructive actions unless explicitly requested.`;

export async function loadScenarioYaml(filePath: string): Promise<ScenarioYaml> {
  const { parse } = await import('yaml');
  const { scenarioYamlSchema } = await import('./types.js');
  const raw = await fs.readFile(filePath, 'utf-8');
  return scenarioYamlSchema.parse(parse(raw));
}

export async function planScenario(
  scenario: ScenarioYaml,
  targetUrl: string,
): Promise<Checklist> {
  const scenarioId = scenario.name;

  if (scenario.steps.length > 0) {
    return {
      scenarioId,
      goal: scenario.goal,
      targetUrl,
      steps: scenario.steps,
      assertions: scenario.success_criteria,
      checkpoints: scenario.checkpoints,
      generatedAt: new Date().toISOString(),
    };
  }

  const env = getEnv();
  if (!resolveModel('planning').baseUrl) {
    return buildFallbackChecklist(scenario, targetUrl);
  }

  const systemPrompt = `You are a QA planning agent. Convert a natural-language test goal into executable browser test steps and success checks, choosing the correct verification order.
Respond ONLY with valid JSON: { "steps": string[], "assertions": string[], "checkpoints": { "afterStep": number, "assertion": string }[] }
"afterStep" is the 1-based index into "steps" after which that checkpoint is verified.
${AUTHORING_RULES}
Language: ${env.MIDSCENE_PREFERRED_LANGUAGE}`;

  const userPrompt = JSON.stringify(
    {
      goal: scenario.goal,
      targetUrl,
      hints: scenario.hints,
      successCriteria: scenario.success_criteria,
    },
    null,
    2,
  );

  try {
    const raw = await chatJson({ role: 'planning', system: systemPrompt, user: userPrompt, temperature: 0.2 });
    const parsed = plannerResponseSchema.parse(raw);

    const refined = await critiquePlan(scenario, targetUrl, parsed);
    const finalPlan = refined ?? parsed;

    // Manual checkpoints in the YAML always win; otherwise use the AI-decided ones,
    // clamped to valid step indices.
    const checkpoints =
      scenario.checkpoints.length > 0
        ? scenario.checkpoints
        : sanitizeCheckpoints(finalPlan.checkpoints, finalPlan.steps.length);

    return {
      scenarioId,
      goal: scenario.goal,
      targetUrl,
      steps: finalPlan.steps,
      assertions:
        finalPlan.assertions.length > 0 ? finalPlan.assertions : scenario.success_criteria,
      checkpoints,
      generatedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.warn('Planner error, using fallback checklist:', error);
    return buildFallbackChecklist(scenario, targetUrl);
  }
}

/**
 * Critic pass over a draft plan: enforces atomic steps, adds missing waits and
 * makes assertions verifiable. Best-effort; returns null if unavailable.
 */
async function critiquePlan(
  scenario: ScenarioYaml,
  targetUrl: string,
  draft: PlannerResponse,
): Promise<PlannerResponse | null> {
  const systemPrompt = `You are a meticulous QA reviewer. Improve the draft test plan WITHOUT changing its intent.
${AUTHORING_RULES}
Split compound steps, remove ambiguity, ensure every navigation is followed by a wait, and make checks concretely verifiable. Re-classify any check that describes an intermediate state into "checkpoints" with the correct "afterStep", and keep end-state checks in "assertions".
Respond ONLY with valid JSON: { "steps": string[], "assertions": string[], "checkpoints": { "afterStep": number, "assertion": string }[] }.`;

  try {
    const raw = (await chatJson({
      role: 'critic',
      system: systemPrompt,
      user: JSON.stringify({ goal: scenario.goal, targetUrl, draft }, null, 2),
      temperature: 0.2,
    })) as Partial<PlannerResponse>;

    const steps = Array.isArray(raw.steps) && raw.steps.length > 0 ? raw.steps : draft.steps;
    const assertions =
      Array.isArray(raw.assertions) && raw.assertions.length > 0 ? raw.assertions : draft.assertions;
    const checkpoints = Array.isArray(raw.checkpoints) ? raw.checkpoints : draft.checkpoints;
    return { steps, assertions, checkpoints };
  } catch (error) {
    console.warn('[planner] critic pass skipped:', error instanceof Error ? error.message : error);
    return null;
  }
}

/** Drops checkpoints whose afterStep is out of range so the runner never skips them. */
function sanitizeCheckpoints(
  checkpoints: PlannerResponse['checkpoints'],
  stepCount: number,
): PlannerResponse['checkpoints'] {
  return checkpoints.filter((c) => c.afterStep >= 1 && c.afterStep <= stepCount);
}

function buildFallbackChecklist(scenario: ScenarioYaml, targetUrl: string): Checklist {
  const steps =
    scenario.steps.length > 0
      ? scenario.steps
      : [
          `Navigate to ${targetUrl} if not already there`,
          `Perform actions needed to achieve: ${scenario.goal}`,
          ...scenario.hints.map((hint) => `Follow hint: ${hint}`),
        ];

  const assertions =
    scenario.success_criteria.length > 0
      ? scenario.success_criteria
      : [`Verify that the goal is met: ${scenario.goal}`];

  return {
    scenarioId: scenario.name,
    goal: scenario.goal,
    targetUrl,
    steps,
    assertions,
    checkpoints: scenario.checkpoints,
    generatedAt: new Date().toISOString(),
  };
}

/** Пише `plans/<scenarioKey>.json` — план прив'язаний до пари «сценарій+ціль». */
export async function saveChecklist(checklist: Checklist): Promise<string> {
  const dir = getPlansDir();
  await fs.mkdir(dir, { recursive: true });
  const key = scenarioKey(checklist.scenarioId, checklist.targetUrl);
  const filePath = path.join(dir, `${key}.json`);
  await fs.writeFile(filePath, JSON.stringify(checklist, null, 2), 'utf-8');
  return filePath;
}

/** Читає план за ключем, з fallback на стару назву без хеша. */
export async function loadChecklist(
  scenarioIdOrKey: string,
  targetUrl?: string,
): Promise<Checklist | null> {
  for (const name of artifactNameCandidates(scenarioIdOrKey, targetUrl)) {
    try {
      const raw = await fs.readFile(path.join(getPlansDir(), `${name}.json`), 'utf-8');
      return checklistSchema.parse(JSON.parse(raw));
    } catch {
      /* пробуємо наступного кандидата */
    }
  }
  return null;
}

/**
 * Ефективна ціль сценарію — єдине джерело істини для ключа артефактів.
 *
 * `QA_TARGET_PINNED=1` означає, що ціль явно задав виклик (env прогону реєстру
 * або поле форми): тоді вона перекриває `target_url` сценарію, інакше прогін
 * «на стейджі» все одно йшов туди, де сценарій колись народився, а ключ
 * артефактів у сервера й воркера розходився.
 */
export function resolveScenarioTargetUrl(scenario: ScenarioYaml): string {
  if (process.env.QA_TARGET_PINNED === '1') return getEnv().QA_TARGET_URL;
  return scenario.target_url ?? getEnv().QA_TARGET_URL;
}

const SECRET_STEP_RE = /^\s*secret:/i;
const HUMAN_STEP_RE = /^\s*human:/i;

/**
 * Чи задіює сценарій секрети (крок `secret:` або профіль автентифікації).
 *
 * Такі прогони запускаються з QA_TRACE='off'. Свідомий компроміс:
 * `src/engine/secret-type.ts` вводить пароль через `page.keyboard.type`, а
 * Playwright-трейс зберігає ввід з клавіатури — значення потрапило б у
 * `trace.zip`, який сервер роздає по HTTP. Для сценаріїв зі секретами трейс
 * вимкнений; доказами лишаються відео, скриншоти та evidence-pack.
 */
export function scenarioHasSecrets(scenario: ScenarioYaml): boolean {
  if (scenario.auth?.profile) return true;
  return scenario.steps.some((step) => SECRET_STEP_RE.test(step));
}

/** Чи потребує сценарій видимого браузера (пауза оператора або автентифікація). */
export function scenarioNeedsHeaded(scenario: ScenarioYaml): boolean {
  if (scenario.auth?.profile) return true;
  return scenario.steps.some((step) => HUMAN_STEP_RE.test(step));
}

export async function prepareChecklist(scenarioPath: string): Promise<Checklist> {
  const scenario = await loadScenarioYaml(scenarioPath);
  const targetUrl = resolveScenarioTargetUrl(scenario);
  // Фіксуємо ціль для всього процесу, щоб cacheId у Playwright-фікстурі (де є
  // лише назва сценарію) дав той самий ключ, що й plans/results/aggregate.
  setActiveTargetUrl(targetUrl);

  const existing = await loadChecklist(scenario.name, targetUrl);
  if (existing && isRegressionMode()) {
    return existing;
  }

  const checklist = await planScenario(scenario, targetUrl);
  await saveChecklist(checklist);
  return checklist;
}

function isRegressionMode(): boolean {
  return getEnv().QA_MODE === 'regression';
}
