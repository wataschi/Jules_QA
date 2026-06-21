import dotenv from 'dotenv';
import { applyTlsPolicy } from '../src/config/midscene-env.js';
import { applyThinkingControls, stripThinkingArtifacts } from '../src/config/thinking.js';

dotenv.config();
applyTlsPolicy();

const baseUrl =
  process.env.MIDSCENE_MODEL_BASE_URL ??
  (process.env.LM_STUDIO_HOST
    ? `${process.env.LM_STUDIO_USE_HTTPS === 'true' ? 'https' : 'http'}://${process.env.LM_STUDIO_HOST}:${process.env.LM_STUDIO_PORT ?? '1234'}/v1`
    : null);

async function main(): Promise<void> {
  if (!baseUrl) {
    console.error('Вкажіть MIDSCENE_MODEL_BASE_URL або LM_STUDIO_HOST у .env');
    process.exit(1);
  }

  const url = `${baseUrl.replace(/\/$/, '')}/models`;
  console.log(`[check] GET ${url}`);

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.MIDSCENE_MODEL_API_KEY ?? 'lm-studio'}`,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      console.error(`[check] HTTP ${response.status}: ${await response.text()}`);
      process.exit(1);
    }

    const data = (await response.json()) as { data?: Array<{ id: string }> };
    const models = data.data?.map((m) => m.id) ?? [];

    console.log('[check] LM Studio доступний');
    console.log('[check] Моделі:', models.length > 0 ? models.join(', ') : '(порожньо — завантажте модель у LM Studio)');

    const expected = process.env.MIDSCENE_MODEL_NAME;
    if (expected && models.length > 0 && !models.some((id) => id === expected || id.includes(expected) || expected.includes(id))) {
      console.warn(`[check] WARN: MIDSCENE_MODEL_NAME="${expected}" не знайдено серед доступних моделей`);
      console.warn('[check] Скопіюйте точний ідентифікатор з LM Studio → Loaded Models');
    }

    const embedding = process.env.EMBEDDING_MODEL_NAME;
    if (embedding && models.some((id) => id.includes('embedding') || id.includes(embedding))) {
      console.log(`[check] Embedding model "${embedding}" доступна (для v2 RAG)`);
    }

    await visionProbe();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cause = (error as { cause?: { code?: string } }).cause;
    if (cause?.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || /certificate/i.test(message)) {
      console.error('[check] TLS: Node не може перевірити сертифікат ендпоінта (Tailscale Funnel).');
      console.error('[check] Виправлення: ALLOW_INSECURE_TLS=true у .env (безпечно — трафік у тунелі Tailscale),');
      console.error('[check] або на Node 22+ запустіть з NODE_OPTIONS=--use-system-ca.');
    } else {
      console.error('[check] Немає з\'єднання з LM Studio через Tailscale');
      console.error('[check] Перевірте: Tailscale на обох машинах, LM Studio Server запущений, Serve on Local Network');
    }
    console.error(error);
    process.exit(1);
  }
}

// 64x64 solid-colour PNG. Large enough for LM Studio's image decoder (a 1x1
// pixel is rejected with "Failed to load image"). We reuse the same bytes with
// a webp prefix to reproduce the LM Studio prefix bug without crafting a webp.
const PNG_PROBE =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwJfEnEY0liH8OITBAtxm7fN1wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYBfXDhPC2QOT8AAAAASUVORK5CYII=';

async function callVision(
  dataUri: string,
  model = process.env.MIDSCENE_MODEL_NAME,
): Promise<{ ok: boolean; content: string; status: number; finishReason?: string; error?: string }> {
  const url = `${baseUrl!.replace(/\/$/, '')}/chat/completions`;
  // 64 tokens leaves room even for a model that still emits a short <think>
  // block; thinking is disabled to prevent the empty-content failure mode.
  const body: Record<string, unknown> = {
    model,
    temperature: 0,
    max_tokens: 64,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Reply with the single word: OK' },
          { type: 'image_url', image_url: { url: dataUri } },
        ],
      },
    ],
  };
  applyThinkingControls(body);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.MIDSCENE_MODEL_API_KEY ?? 'lm-studio'}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, content: '', status: response.status, error: text.slice(0, 200) };
    }
    const data = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    };
    const raw = data.choices?.[0]?.message?.content ?? '';
    return {
      ok: true,
      content: stripThinkingArtifacts(raw),
      status: response.status,
      finishReason: data.choices?.[0]?.finish_reason,
    };
  } catch (error) {
    return { ok: false, content: '', status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Heuristic: models whose names suggest multimodal / UI-grounding capability. */
function visionCandidates(models: string[]): string[] {
  const current = process.env.MIDSCENE_MODEL_NAME;
  return models
    .filter((id) => /gemma-4|omni|[-/]vl\b|vl-|qwen3\.6-35b-a3b$|qwen3\.6-27b|locateanything|nemotron-3-nano-omni|magistral|seed-oss/i.test(id))
    .filter((id) => !/embedding|coder|text-/i.test(id))
    .filter((id) => id !== current)
    .slice(0, 5);
}

async function findWorkingVisionModel(models: string[]): Promise<void> {
  const candidates = visionCandidates(models);
  if (candidates.length === 0) {
    console.warn('[vision] У списку немає очевидних мультимодальних моделей. Завантажте VL-модель у LM Studio.');
    return;
  }

  console.log(`[vision] Шукаю робочу VL-модель серед: ${candidates.join(', ')}`);
  const working: string[] = [];
  for (const model of candidates) {
    const res = await callVision(`data:image/png;base64,${PNG_PROBE}`, model);
    if (res.ok && res.content.trim()) {
      console.log(`[vision]   ✓ ${model} → бачить зображення ("${res.content.trim().slice(0, 30)}")`);
      working.push(model);
    } else {
      console.log(`[vision]   ✗ ${model} → ${res.ok ? 'порожньо' : `HTTP ${res.status}`}`);
    }
  }

  if (working.length > 0) {
    console.log('');
    console.log('[vision] РЕКОМЕНДАЦІЯ: задайте у .env для grounding робочу VL-модель, напр.:');
    console.log(`[vision]   MIDSCENE_MODEL_NAME=${working[0]}`);
    console.log('[vision] (planner/critic можуть лишатися текстовою моделлю)');
  } else {
    console.warn('[vision] Жодна з кандидатів не повернула контент. Перевірте, що у LM Studio для VL-моделі завантажено mmproj-проектор.');
  }
}

async function visionProbe(): Promise<void> {
  if (!process.env.MIDSCENE_MODEL_NAME) {
    console.warn('[vision] MIDSCENE_MODEL_NAME не задано — пропускаю vision-probe');
    return;
  }

  console.log('[vision] Перевірка передачі зображень (PNG, thinking вимкнено)...');
  const png = await callVision(`data:image/png;base64,${PNG_PROBE}`);
  if (png.ok && png.content.trim()) {
    console.log(`[vision] PNG OK — модель бачить зображення (відповідь: "${png.content.trim().slice(0, 40)}")`);
  } else if (png.ok && !png.content.trim()) {
    if (png.finishReason === 'length') {
      console.error('[vision] PNG: порожній content із finish_reason=length — модель витратила бюджет на reasoning.');
      console.error('[vision] Виправлення: LMSTUDIO_DISABLE_THINKING=true (за замовч.) і/або підніміть max_tokens.');
    } else {
      console.error(`[vision] PNG: порожня відповідь (finish_reason=${png.finishReason ?? 'n/a'}).`);
      console.error('[vision] Перевірте, що у LM Studio завантажено vision-проектор (mmproj) для цієї моделі.');
    }
  } else {
    console.error(`[vision] PNG помилка HTTP ${png.status}: ${png.error ?? ''}`);
  }

  console.log('[vision] Перевірка webp-префікса (відомий баг LM Studio)...');
  const webp = await callVision(`data:image/webp;base64,${PNG_PROBE}`);
  if (!webp.ok || !webp.content.trim()) {
    console.warn('[vision] webp відхилено/порожньо — це очікувано. Тримайте LMSTUDIO_PROXY_ENABLED=true (webp->png).');
  } else {
    console.log('[vision] webp також працює — проксі не обовʼязковий, але не шкодить.');
  }
}

main();
