import type { Page } from '@playwright/test';

export interface BlockerDetection {
  kind: 'captcha' | 'otp' | 'login-wall' | 'oauth';
  reason: string;
}

const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="turnstile"]',
  'iframe[title*="captcha" i]',
  '.g-recaptcha',
  '.h-captcha',
  '#cf-turnstile',
  '[data-sitekey]',
];

const OTP_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[name*="otp" i]',
  'input[name*="totp" i]',
  'input[placeholder*="code" i]',
  'input[aria-label*="verification code" i]',
];

const LOGIN_WALL_PATTERNS = [
  /verify you are human/i,
  /sign in to continue/i,
  /log in to continue/i,
  /authentication required/i,
  /увійдіть/i,
  /підтвердіть/i,
];

export async function detectBlocker(page: Page): Promise<BlockerDetection | null> {
  for (const selector of CAPTCHA_SELECTORS) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (count > 0) {
      return { kind: 'captcha', reason: 'CAPTCHA detected — operator action required' };
    }
  }

  for (const selector of OTP_SELECTORS) {
    const visible = await page.locator(selector).first().isVisible().catch(() => false);
    if (visible) {
      return { kind: 'otp', reason: '2FA/OTP input detected — operator action required' };
    }
  }

  const bodyText = await page.locator('body').innerText().catch(() => '');
  for (const pattern of LOGIN_WALL_PATTERNS) {
    if (pattern.test(bodyText)) {
      const hasPasswordField = await page.locator('input[type="password"]').isVisible().catch(() => false);
      if (hasPasswordField) {
        return { kind: 'login-wall', reason: 'Login wall detected — operator action required' };
      }
    }
  }

  const oauthVisible = await page
    .locator('button:has-text("Continue with"), a:has-text("Sign in with")')
    .first()
    .isVisible()
    .catch(() => false);
  if (oauthVisible) {
    return { kind: 'oauth', reason: 'OAuth provider selection detected — operator action required' };
  }

  return null;
}
