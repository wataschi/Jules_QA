/**
 * Qwen / LM Studio thinking-mode control (per OpenAI chat-completions request).
 *
 * Local Qwen "thinking" models (e.g. `qwen3.6-35b-a3b`) spend their token budget
 * on an internal `<think>` reasoning pass and frequently return an EMPTY visible
 * `content` — especially with a small `max_tokens` or when the request carries
 * tools/images. Downstream this surfaces as Midscene's
 * `failed to call AI model service: empty content`.
 *
 * Disabling thinking per request makes the *same* model answer directly. This is
 * the exact approach proven in the sibling HiveADE project, which drives the
 * identical local model over a Tailscale tunnel without any webp→png trickery.
 *
 * Mechanism is belt-and-braces because different LM Studio builds honour
 * different fields, and some (Qwen3 + LM Studio issue #1559) ignore the kwargs
 * entirely — so we also prefill an *empty* assistant `<think></think>` turn and
 * ask LM Studio to continue it, which reliably forces the model past reasoning:
 *  - `chat_template_kwargs.enable_thinking = false` → Qwen3 Jinja chat template
 *  - top-level `enable_thinking = false`            → some LM Studio versions
 *  - empty `<think></think>` assistant prefill + `continue_assistant_turn`
 *    → works even when the kwargs above are ignored
 *
 * All three are additive/ignored by backends that don't understand them, so the
 * injection is safe for every model role that routes through it.
 */

const THINK_ARTIFACT_RE = /^\s*(?:<think>[\s\S]*?<\/think>\s*)+/i;

/** Empty reasoning block: the model continues *after* the closed </think>. */
const NO_THINK_PREFILL = '<think>\n\n</think>\n\n';

/** Whether no-think controls should be injected (env-gated, default ON). */
export function thinkingDisabled(): boolean {
  const raw = (process.env.LMSTUDIO_DISABLE_THINKING ?? 'true').trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'off' && raw !== 'no';
}

/**
 * Mutates an OpenAI chat-completions request body in place to disable Qwen
 * thinking. Returns `true` if the body was modified.
 *
 * When the request carries a `messages` array ending in a user turn, an empty
 * `<think></think>` assistant prefill is appended and `continue_assistant_turn`
 * is set so LM Studio resumes that turn — the only reliable lever when the
 * model ignores `enable_thinking`. Pass `{ prefill: false }` for tool-calling
 * loops where continuing the assistant turn would break multi-step flows.
 */
export function applyThinkingControls(
  body: Record<string, unknown>,
  opts: { prefill?: boolean } = {},
): boolean {
  if (!thinkingDisabled()) return false;

  const tpl = (body.chat_template_kwargs as Record<string, unknown> | undefined) ?? {};
  tpl.enable_thinking = false;
  body.chat_template_kwargs = tpl;
  body.enable_thinking = false;

  if (opts.prefill !== false && Array.isArray(body.messages)) {
    const messages = body.messages as Array<Record<string, unknown>>;
    const last = messages[messages.length - 1];
    const lastRole = last?.role;
    if (messages.length > 0 && lastRole !== 'assistant' && lastRole !== 'tool') {
      messages.push({ role: 'assistant', content: NO_THINK_PREFILL });
      body.continue_assistant_turn = true;
    }
  }
  return true;
}

/**
 * Strips a leading `<think>…</think>` block that some models still emit even
 * with thinking disabled, so JSON/text parsers see only the real answer.
 */
export function stripThinkingArtifacts(text: string): string {
  return (text ?? '').replace(THINK_ARTIFACT_RE, '').trim();
}
