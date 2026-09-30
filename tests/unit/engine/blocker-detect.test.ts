import { describe, expect, it } from 'vitest';
import { detectBlocker, isNavigationStep } from '../../../src/engine/blocker-detect.js';

/**
 * Селектори в детекторі склеєні комами (один `.count()` замість N), тож мок
 * розбиває запит на під-селектори і відповідає, якщо збігся хоч один.
 */
function mockPage(options: {
  selectors?: Record<string, number>;
  visible?: Record<string, boolean>;
  bodyText?: string;
}): Parameters<typeof detectBlocker>[0] {
  const selectors = options.selectors ?? {};
  const visible = options.visible ?? {};
  const bodyText = options.bodyText ?? '';

  const parts = (selector: string): string[] => selector.split(',').map((s) => s.trim());

  const countFor = (selector: string): number =>
    parts(selector).reduce((sum, part) => sum + (selectors[part] ?? 0), 0);

  const visibleFor = (selector: string): boolean =>
    parts(selector).some((part) => visible[part] ?? false);

  return {
    locator(selector: string) {
      return {
        count: async () => countFor(selector),
        first: () => ({ isVisible: async () => visibleFor(selector) }),
        isVisible: async () => visibleFor(selector),
        innerText: async () => (selector === 'body' ? bodyText : ''),
      };
    },
  } as unknown as Parameters<typeof detectBlocker>[0];
}

describe('blocker-detect', () => {
  it('detects reCAPTCHA iframe', async () => {
    const page = mockPage({ selectors: { 'iframe[src*="recaptcha"]': 1 } });
    expect((await detectBlocker(page))?.kind).toBe('captcha');
  });

  it('detects OTP input', async () => {
    const page = mockPage({ visible: { 'input[autocomplete="one-time-code"]': true } });
    expect((await detectBlocker(page))?.kind).toBe('otp');
  });

  it('detects login wall text with password field', async () => {
    const page = mockPage({
      bodyText: 'Sign in to continue using this service',
      visible: { 'input[type="password"]': true },
    });
    expect((await detectBlocker(page))?.kind).toBe('login-wall');
  });

  it('returns null when no blockers', async () => {
    const page = mockPage({ bodyText: 'Welcome to dashboard' });
    expect(await detectBlocker(page)).toBeNull();
  });

  it('detects a dedicated OAuth wall (no main content)', async () => {
    const page = mockPage({
      visible: { 'a:has-text("Sign in with")': true },
      bodyText: 'Sign in with Google',
    });
    expect((await detectBlocker(page))?.kind).toBe('oauth');
  });

  // ── Хибні спрацювання, через які детектор ставив прогони на паузу ────────────

  it('does NOT treat a standalone [data-sitekey] as CAPTCHA', async () => {
    // Невидимий reCAPTCHA v3 / маркетингова форма: атрибут є, iframe немає.
    const page = mockPage({ selectors: { '[data-sitekey]': 1 } });
    expect(await detectBlocker(page)).toBeNull();
  });

  it('treats [data-sitekey] as CAPTCHA only together with a recaptcha iframe', async () => {
    const page = mockPage({
      selectors: { '[data-sitekey]': 1, 'iframe[src*="recaptcha"]': 1 },
    });
    expect((await detectBlocker(page))?.kind).toBe('captcha');
  });

  it('does NOT treat "Enter promo code" as an OTP field', async () => {
    const page = mockPage({
      visible: { 'input[placeholder*="code" i]': true },
      bodyText: 'Enter promo code to get a discount',
    });
    expect(await detectBlocker(page)).toBeNull();
  });

  it('does NOT treat a postal code field as an OTP field', async () => {
    const page = mockPage({
      // maxlength=10 — задовге для одноразового коду.
      visible: { 'input[name*="code" i][maxlength="10"]': true },
      bodyText: 'Shipping address — postal code',
    });
    expect(await detectBlocker(page)).toBeNull();
  });

  it('still detects a short 6-digit verification field', async () => {
    const page = mockPage({
      visible: { 'input[name*="code" i][maxlength="6"]': true },
    });
    expect((await detectBlocker(page))?.kind).toBe('otp');
  });

  it('does NOT treat a marketing page with "Sign in with Google" as a blocker', async () => {
    const page = mockPage({
      selectors: { main: 1 },
      visible: { 'a:has-text("Sign in with")': true },
      bodyText: 'Our product helps teams ship faster. Sign in with Google to try it.',
    });
    expect(await detectBlocker(page)).toBeNull();
  });

  it('does NOT treat a long content page with an OAuth button as a blocker', async () => {
    const page = mockPage({
      visible: { 'button:has-text("Continue with")': true },
      bodyText: 'x'.repeat(2000),
    });
    expect(await detectBlocker(page)).toBeNull();
  });

  it('does NOT treat login-wall wording without a password field as a blocker', async () => {
    const page = mockPage({ bodyText: 'Sign in to continue reading our blog' });
    expect(await detectBlocker(page)).toBeNull();
  });
});

describe('isNavigationStep', () => {
  it('recognises navigation steps in English and Ukrainian', () => {
    expect(isNavigationStep('Navigate to the catalog page')).toBe(true);
    expect(isNavigationStep('Open the dataset detail page')).toBe(true);
    expect(isNavigationStep('Перейди на сторінку каталогу')).toBe(true);
    expect(isNavigationStep('Reload the page')).toBe(true);
  });

  it('does not treat plain interactions as navigation', () => {
    expect(isNavigationStep('Click the Search button')).toBe(false);
    expect(isNavigationStep('Type "hello" into the query field')).toBe(false);
  });
});
