import type { Page } from '@playwright/test';
import type { Agent } from '@midscene/core/agent';
import { aiActWithSelfHeal } from './self-heal.js';

export interface SecretTypeParams {
  page: Page;
  agent: Agent;
  /** Instruction for the agent — must NOT contain the secret value. */
  instruction: string;
  secretValue: string;
  label?: string;
}

/**
 * Locates and focuses a field via the vision agent, then types the secret
 * deterministically through Playwright keyboard — the secret never enters the LLM.
 */
export async function runSecretTypeStep({
  page,
  agent,
  instruction,
  secretValue,
  label = 'secret-type',
}: SecretTypeParams): Promise<void> {
  const focusInstruction = instruction.includes('[SECRET]')
    ? instruction.replace('[SECRET]', 'the credential field')
    : `${instruction} (focus the input field only, do not type any value)`;

  await aiActWithSelfHeal(agent, focusInstruction, {
    label,
    onRetry: (attempt, _err, cls) =>
      console.warn(`[secret-type] ${label} focus retry ${attempt} [${cls}]`),
  });

  await page.keyboard.press('Control+A').catch(() => undefined);
  await page.keyboard.press('Meta+A').catch(() => undefined);
  await page.keyboard.press('Backspace').catch(() => undefined);
  await page.keyboard.type(secretValue, { delay: 30 });
}
