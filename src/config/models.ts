/**
 * Model-role registry.
 *
 * Decouples the four logical model roles used across the system so that each can
 * be pointed at a different endpoint via configuration only — no code change.
 * Today everything defaults to the single local LM Studio endpoint; once
 * stronger/cloud models are introduced post-prod, only `.env` changes.
 *
 *  - grounding : multimodal VLM driving Midscene (vision localization + asserts)
 *  - planning  : text model turning goals/PRD into executable checklists
 *  - critic    : text model reviewing/refining generated checklists
 *  - embedding : embeddings for future RAG (v2)
 */

import { applyThinkingControls, stripThinkingArtifacts } from './thinking.js';

export type ModelRole = 'grounding' | 'planning' | 'critic' | 'embedding';

export interface ResolvedModel {
  role: ModelRole;
  baseUrl?: string;
  apiKey: string;
  name?: string;
}

function firstDefined(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value !== '');
}

export function resolveModel(role: ModelRole): ResolvedModel {
  const env = process.env;
  const groundingBase = firstDefined(env.MIDSCENE_MODEL_BASE_URL, env.MIDSCENE_OPENAI_BASE_URL);
  const groundingKey = firstDefined(env.MIDSCENE_MODEL_API_KEY, env.MIDSCENE_OPENAI_API_KEY);
  const groundingName = env.MIDSCENE_MODEL_NAME;

  switch (role) {
    case 'grounding':
      return {
        role,
        baseUrl: groundingBase,
        apiKey: groundingKey ?? 'lm-studio',
        name: groundingName,
      };
    case 'planning':
      return {
        role,
        baseUrl: firstDefined(env.PLANNER_MODEL_BASE_URL, groundingBase),
        apiKey: firstDefined(env.PLANNER_MODEL_API_KEY, groundingKey) ?? 'lm-studio',
        name: firstDefined(env.PLANNER_MODEL_NAME, groundingName),
      };
    case 'critic':
      return {
        role,
        baseUrl: firstDefined(env.CRITIC_MODEL_BASE_URL, env.PLANNER_MODEL_BASE_URL, groundingBase),
        apiKey:
          firstDefined(env.CRITIC_MODEL_API_KEY, env.PLANNER_MODEL_API_KEY, groundingKey) ??
          'lm-studio',
        name: firstDefined(env.CRITIC_MODEL_NAME, env.PLANNER_MODEL_NAME, groundingName),
      };
    case 'embedding':
      return {
        role,
        baseUrl: firstDefined(env.EMBEDDING_MODEL_BASE_URL, groundingBase),
        apiKey: firstDefined(env.EMBEDDING_MODEL_API_KEY, groundingKey) ?? 'lm-studio',
        name: env.EMBEDDING_MODEL_NAME,
      };
    default:
      return { role, apiKey: 'lm-studio' };
  }
}

export interface ChatJsonOptions {
  role?: ModelRole;
  system: string;
  user: string;
  temperature?: number;
  timeoutMs?: number;
}

/**
 * Parses JSON from an LLM response, tolerating ```json fenced blocks and
 * leading/trailing prose.
 */
export function parseJsonFromLlm(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let jsonStr = (fenced?.[1] ?? trimmed).trim();

  if (!fenced) {
    const firstBrace = jsonStr.search(/[[{]/);
    const lastBrace = Math.max(jsonStr.lastIndexOf('}'), jsonStr.lastIndexOf(']'));
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
    }
  }

  return JSON.parse(jsonStr);
}

/**
 * Calls a chat model for a JSON object response. Retries once without
 * `response_format` for backends (e.g. some local models) that reject json mode.
 */
export async function chatJson(options: ChatJsonOptions): Promise<unknown> {
  const model = resolveModel(options.role ?? 'planning');
  if (!model.baseUrl) {
    throw new Error('LLM не налаштовано. Вкажіть MIDSCENE_MODEL_BASE_URL у .env');
  }
  if (!model.name) {
    throw new Error('Не задано назву моделі (MIDSCENE_MODEL_NAME / PLANNER_MODEL_NAME)');
  }

  const url = `${model.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const messages = [
    { role: 'system', content: options.system },
    { role: 'user', content: options.user },
  ];
  const temperature = options.temperature ?? 0.2;
  const timeoutMs = options.timeoutMs ?? Number(process.env.MIDSCENE_MODEL_TIMEOUT ?? 120_000);

  // Each attempt gets its own messages copy so the no-think prefill is applied
  // independently (the prefill mutates the array in place).
  const attempts: Array<Record<string, unknown>> = [
    { model: model.name, messages: [...messages], temperature, response_format: { type: 'json_object' } },
    { model: model.name, messages: [...messages], temperature },
  ];
  // Suppress Qwen thinking via kwargs only (no assistant prefill): these calls
  // are uncapped text/JSON, and a `<think>` prefill would clash with the
  // json_object grammar. Any leftover think block is removed before parsing.
  for (const body of attempts) {
    applyThinkingControls(body, { prefill: false });
  }

  let lastError = '';
  for (const body of attempts) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${model.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      lastError = await response.text().catch(() => response.statusText);
      if (response.status === 400 && body.response_format) {
        continue;
      }
      throw new Error(
        `LLM API error: ${response.status}${lastError ? ` — ${lastError.slice(0, 300)}` : ''}`,
      );
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Порожня відповідь LLM');
    }

    try {
      return parseJsonFromLlm(stripThinkingArtifacts(content));
    } catch {
      throw new Error('LLM повернув невалідний JSON. Спробуйте іншу модель або коротший запит.');
    }
  }

  throw new Error(
    `LLM API error: 400 — ${lastError.slice(0, 300) || 'модель не підтримує json_object'}`,
  );
}
