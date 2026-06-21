import { chatJson, parseJsonFromLlm } from '../config/models.js';
import { scenarioYamlSchema, type ScenarioYaml } from '../planning/types.js';

export { parseJsonFromLlm };

export interface GenerateScenarioInput {
  description: string;
  targetUrl?: string;
  testType?: 'smoke' | 'regression' | 'accessibility' | 'security' | 'e2e';
}

export interface EnhanceScenarioInput {
  scenario: Partial<ScenarioYaml>;
  focus?: 'hints' | 'steps' | 'criteria' | 'all';
}

const scenarioResponseSchema = scenarioYamlSchema.omit({ name: true }).partial().extend({
  name: scenarioYamlSchema.shape.name.optional(),
});

/**
 * Shared authoring guidance so AI-generated test cases are precise, atomic and
 * machine-checkable — the foundation of test-case quality.
 */
const AUTHORING_RULES = `Rules for high-quality test cases:
- Each step = exactly ONE UI action from this vocabulary: navigate, click, type, select, scroll, press, wait. No compound steps ("click X and then Y").
- Reference targets by what a human sees: visible label, role, or placeholder (e.g. "the 'Search' button", not a CSS selector).
- Keep 3-8 steps. If a flow is longer, it should be split into multiple scenarios.
- success_criteria must be observable and verifiable (concrete text/state visible on screen), never vague ("works fine").
- Safety: never include payment, account deletion, logout, or other destructive actions unless explicitly requested.`;

function slugFromGoal(goal: string): string {
  return (
    goal
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'ai-scenario'
  );
}

function fallbackTestIdeas(targetUrl: string): string[] {
  let host = targetUrl;
  try {
    host = new URL(targetUrl).hostname;
  } catch {
    /* keep url string */
  }
  return [
    `Перевірити завантаження головної сторінки ${host} — контент видимий, без 404/500`,
    `Знайти та закрити cookie/consent banner, якщо зʼявляється`,
    `Перевірити основну навігацію: перехід на внутрішню сторінку і повернення`,
    `Smoke accessibility: контраст тексту, наявність заголовка h1, фокус на інтерактивних елементах`,
    `Знайти поле пошуку або форму — ввести тестовий запит без небезпечних дій`,
    `Перевірити відображення на viewport 1280×768 без критичних перекриттів UI`,
  ];
}

export async function generateScenarioFromDescription(
  input: GenerateScenarioInput,
): Promise<ScenarioYaml> {
  const systemPrompt = `You are a senior QA engineer assistant. Generate a YAML-ready test scenario JSON for vision-based browser automation (Midscene/Playwright).
Respond ONLY with valid JSON matching this shape:
{
  "name": "kebab-case-id",
  "goal": "natural language goal in Ukrainian",
  "tags": string[],
  "group": string,
  "hints": string[],
  "steps": string[],
  "success_criteria": string[],
  "navigation": { "type": "deterministic" | "ai", "url"?: string }
}
${AUTHORING_RULES}
- name: latin kebab-case, max 60 chars.
- goal, hints, steps, success_criteria: Ukrainian.
- navigation.type: "deterministic" for simple page loads, "ai" for complex flows.`;

  const userPrompt = JSON.stringify(
    {
      description: input.description,
      targetUrl: input.targetUrl,
      testType: input.testType ?? 'e2e',
    },
    null,
    2,
  );

  const raw = await chatJson({ role: 'planning', system: systemPrompt, user: userPrompt, temperature: 0.3 });
  const parsed = scenarioResponseSchema.parse(raw);

  const name = parsed.name ?? slugFromGoal(input.description);
  const draft = scenarioYamlSchema.parse({
    name,
    goal: parsed.goal ?? input.description,
    target_url: input.targetUrl ?? parsed.target_url,
    tags: parsed.tags ?? [input.testType ?? 'e2e', 'ai-generated'],
    group: parsed.group ?? 'ai-lab',
    hints: parsed.hints ?? [],
    steps: parsed.steps ?? [],
    success_criteria: parsed.success_criteria ?? [`Verify: ${input.description}`],
    navigation: parsed.navigation ?? { type: 'deterministic' },
  });

  // Critic pass: refine for atomicity, coverage and safety. Best-effort.
  const refined = await critiqueScenario(draft);
  return refined ?? draft;
}

/**
 * Second-opinion review of a generated scenario. Returns a refined scenario or
 * `null` if the critic model is unavailable / produced nothing usable.
 */
export async function critiqueScenario(scenario: ScenarioYaml): Promise<ScenarioYaml | null> {
  const systemPrompt = `You are a meticulous QA reviewer. Improve the given test scenario WITHOUT changing its intent.
${AUTHORING_RULES}
Specifically: split compound steps, remove ambiguity, add a missing "wait for page to load" where needed, make success_criteria concretely verifiable, and strip unsafe actions.
Respond ONLY with valid JSON: { "hints": string[], "steps": string[], "success_criteria": string[] }. Keep Ukrainian text.`;

  try {
    const raw = (await chatJson({
      role: 'critic',
      system: systemPrompt,
      user: JSON.stringify(scenario, null, 2),
      temperature: 0.2,
    })) as Partial<Pick<ScenarioYaml, 'hints' | 'steps' | 'success_criteria'>>;

    const steps = Array.isArray(raw.steps) && raw.steps.length > 0 ? raw.steps : scenario.steps;
    const criteria =
      Array.isArray(raw.success_criteria) && raw.success_criteria.length > 0
        ? raw.success_criteria
        : scenario.success_criteria;
    const hints = Array.isArray(raw.hints) ? raw.hints : scenario.hints;

    return scenarioYamlSchema.parse({ ...scenario, steps, success_criteria: criteria, hints });
  } catch (error) {
    console.warn('[ai-assistant] critic pass skipped:', error instanceof Error ? error.message : error);
    return null;
  }
}

export async function enhanceScenario(input: EnhanceScenarioInput): Promise<Partial<ScenarioYaml>> {
  const focus = input.focus ?? 'all';
  const systemPrompt = `You are a QA engineer improving test scenarios for AI browser automation.
${AUTHORING_RULES}
Respond ONLY with JSON containing fields to update among: hints, steps, success_criteria (arrays of strings).
Focus area: ${focus}. Language: Ukrainian for human-readable text.`;

  const raw = (await chatJson({
    role: 'critic',
    system: systemPrompt,
    user: JSON.stringify(input.scenario, null, 2),
    temperature: 0.3,
  })) as Partial<ScenarioYaml>;

  return {
    hints: raw.hints ?? input.scenario.hints,
    steps: raw.steps ?? input.scenario.steps,
    success_criteria: raw.success_criteria ?? input.scenario.success_criteria,
  };
}

export async function suggestTestIdeas(targetUrl: string, context?: string): Promise<string[]> {
  const systemPrompt = `You are a QA strategist. Suggest 5-8 high-value test scenarios for the given website.
Respond ONLY with JSON: { "ideas": string[] } — each idea one sentence in Ukrainian.`;

  try {
    const raw = (await chatJson({
      role: 'planning',
      system: systemPrompt,
      user: JSON.stringify({ targetUrl, context: context ?? null }, null, 2),
      temperature: 0.4,
    })) as { ideas?: string[] };
    if (raw.ideas?.length) return raw.ideas;
  } catch (error) {
    console.warn('[ai-assistant] suggestTestIdeas LLM failed, using fallback:', error);
  }

  return fallbackTestIdeas(targetUrl);
}
