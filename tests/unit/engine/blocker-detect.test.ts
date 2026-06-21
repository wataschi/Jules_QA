import { describe, expect, it } from 'vitest';
import { detectBlocker } from '../../../src/engine/blocker-detect.js';

function mockPage(options: {
  selectors?: Record<string, number>;
  visible?: Record<string, boolean>;
  bodyText?: string;
}): Parameters<typeof detectBlocker>[0] {
  const selectors = options.selectors ?? {};
  const visible = options.visible ?? {};
  const bodyText = options.bodyText ?? '';

  return {
    locator(selector: string) {
      const locator = {
        count: async () => selectors[selector] ?? 0,
        first: () => ({
          isVisible: async () => visible[selector] ?? false,
        }),
        isVisible: async () => visible[selector] ?? false,
        innerText: async () => (selector === 'body' ? bodyText : ''),
      };
      return locator;
    },
  } as unknown as Parameters<typeof detectBlocker>[0];
}

describe('blocker-detect', () => {
  it('detects reCAPTCHA iframe', async () => {
    const page = mockPage({
      selectors: { 'iframe[src*="recaptcha"]': 1 },
    });
    const blocker = await detectBlocker(page);
    expect(blocker?.kind).toBe('captcha');
  });

  it('detects OTP input', async () => {
    const page = mockPage({
      visible: { 'input[autocomplete="one-time-code"]': true },
    });
    const blocker = await detectBlocker(page);
    expect(blocker?.kind).toBe('otp');
  });

  it('detects login wall text with password field', async () => {
    const page = mockPage({
      bodyText: 'Sign in to continue using this service',
      visible: { 'input[type="password"]': true },
    });
    const blocker = await detectBlocker(page);
    expect(blocker?.kind).toBe('login-wall');
  });

  it('returns null when no blockers', async () => {
    const page = mockPage({ bodyText: 'Welcome to dashboard' });
    expect(await detectBlocker(page)).toBeNull();
  });
});
