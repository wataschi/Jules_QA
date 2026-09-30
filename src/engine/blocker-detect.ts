import type { Page } from '@playwright/test';

export interface BlockerDetection {
  kind: 'captcha' | 'otp' | 'login-wall' | 'oauth';
  reason: string;
}

/**
 * Детектор блокерів (CAPTCHA / OTP / login-wall / OAuth-стіна).
 *
 * Раніше він викликався після КОЖНОГО кроку і робив до 8 `.count()`, 5
 * `.isVisible()` та повний `body.innerText()` — дорого і з купою хибних
 * спрацювань. Тепер:
 *  - викликається лише після падіння кроку та після навігаційних кроків
 *    (див. `hybrid-runner.ts`);
 *  - селектори склеєні в один запит на категорію (1 `.count()` замість N);
 *  - `body.innerText()` читається лише тоді, коли на сторінці вже видно поле
 *    пароля, тобто коли login-wall узагалі можливий;
 *  - евристики звужені (див. коментарі нижче).
 */

/**
 * `[data-sitekey]` сам по собі не блокер: цей атрибут ставлять і на невидимий
 * reCAPTCHA v3, і на маркетингові форми. Враховуємо його ЛИШЕ разом з
 * recaptcha/hcaptcha-iframe — тому він у власному списку.
 */
const CAPTCHA_WIDGET_SELECTOR = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="turnstile"]',
  'iframe[title*="captcha" i]',
  '.g-recaptcha',
  '.h-captcha',
  '#cf-turnstile',
].join(', ');

const CAPTCHA_IFRAME_SELECTOR = 'iframe[src*="recaptcha"], iframe[src*="hcaptcha"]';
const SITEKEY_SELECTOR = '[data-sitekey]';

/** Явні маркери одноразового коду — самодостатні. */
const OTP_EXPLICIT_SELECTOR = [
  'input[autocomplete="one-time-code"]',
  'input[name*="otp" i]',
  'input[id*="otp" i]',
  'input[name*="totp" i]',
  'input[name*="2fa" i]',
  'input[id*="2fa" i]',
  'input[name*="verification" i]',
  'input[id*="verification" i]',
  'input[aria-label*="verification code" i]',
].join(', ');

/**
 * Загальне поле «…code…» вважаємо OTP лише коли `maxlength <= 8`.
 * CSS не має порівнянь, тож перелічуємо допустимі значення явно — це відсікає
 * «Enter promo code» та «ZIP / postal code», де maxlength відсутній або великий.
 */
const SHORT_MAXLENGTHS = [1, 2, 3, 4, 5, 6, 7, 8];
const OTP_SHORT_CODE_SELECTOR = SHORT_MAXLENGTHS.flatMap((n) => [
  `input[name*="code" i][maxlength="${n}"]`,
  `input[id*="code" i][maxlength="${n}"]`,
  `input[placeholder*="code" i][maxlength="${n}"]`,
  `input[aria-label*="code" i][maxlength="${n}"]`,
]).join(', ');

const LOGIN_WALL_PATTERNS = [
  /verify you are human/i,
  /sign in to continue/i,
  /log in to continue/i,
  /authentication required/i,
  /увійдіть/i,
  /підтвердіть/i,
];

const OAUTH_SELECTOR = 'button:has-text("Continue with"), a:has-text("Sign in with")';

/**
 * Ознаки «нормальної» сторінки. Якщо поряд з OAuth-кнопкою є основний контент —
 * це не стіна, а маркетингова/звичайна сторінка з кнопкою входу в хедері.
 */
const MAIN_CONTENT_SELECTOR = 'main, [role="main"], article';

/** Довжина тексту, після якої сторінка вже не схожа на голий екран логіну. */
const MAIN_CONTENT_TEXT_THRESHOLD = 800;

async function count(page: Page, selector: string): Promise<number> {
  return page.locator(selector).count().catch(() => 0);
}

async function firstVisible(page: Page, selector: string): Promise<boolean> {
  return page.locator(selector).first().isVisible().catch(() => false);
}

export async function detectBlocker(page: Page): Promise<BlockerDetection | null> {
  // 1. CAPTCHA-віджет: один запит на всі явні селектори.
  if ((await count(page, CAPTCHA_WIDGET_SELECTOR)) > 0) {
    return { kind: 'captcha', reason: 'CAPTCHA detected — operator action required' };
  }

  // `[data-sitekey]` — лише в парі з recaptcha/hcaptcha-iframe.
  if (
    (await count(page, SITEKEY_SELECTOR)) > 0 &&
    (await count(page, CAPTCHA_IFRAME_SELECTOR)) > 0
  ) {
    return { kind: 'captcha', reason: 'CAPTCHA detected — operator action required' };
  }

  // 2. OTP: явні маркери або коротке «code»-поле.
  if (await firstVisible(page, OTP_EXPLICIT_SELECTOR)) {
    return { kind: 'otp', reason: '2FA/OTP input detected — operator action required' };
  }
  if (await firstVisible(page, OTP_SHORT_CODE_SELECTOR)) {
    return { kind: 'otp', reason: '2FA/OTP input detected — operator action required' };
  }

  // 3. Login-wall: спершу дешева перевірка поля пароля, лише потім текст сторінки.
  if (await firstVisible(page, 'input[type="password"]')) {
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (LOGIN_WALL_PATTERNS.some((pattern) => pattern.test(bodyText))) {
      return { kind: 'login-wall', reason: 'Login wall detected — operator action required' };
    }
  }

  // 4. OAuth-стіна: блокер лише коли на сторінці НЕМА основного контенту.
  if (await firstVisible(page, OAUTH_SELECTOR)) {
    const hasMainContainer = (await count(page, MAIN_CONTENT_SELECTOR)) > 0;
    const bodyText = hasMainContainer
      ? ''
      : await page.locator('body').innerText().catch(() => '');
    const looksLikeContentPage = hasMainContainer || bodyText.length > MAIN_CONTENT_TEXT_THRESHOLD;

    if (!looksLikeContentPage) {
      return { kind: 'oauth', reason: 'OAuth provider selection detected — operator action required' };
    }
  }

  return null;
}

/**
 * Чи є крок навігаційним. Тільки після таких кроків (і після падінь) варто
 * платити за детекцію блокерів — саме тут з'являються CAPTCHA/login-wall.
 */
export function isNavigationStep(step: string): boolean {
  const s = step.trim().toLowerCase();
  return /\b(navigate|go to|open|visit|reload|refresh|load)\b/.test(s) ||
    /(перейд|відкри|заванта|онови)/.test(s);
}
