/**
 * Патч знімка екрана для Playwright-сторінок Midscene.
 *
 * Midscene жорстко зашив `page.screenshot({ timeout: 10000 })`. На сайтах із
 * безперервною фоновою CSS-анімацією захоплення кадру через CDP не встигає
 * за 10 с і крок падає з `page.screenshot: Timeout 10000ms exceeded` — саме це
 * спалило 488 с на одному кроці реального прогону. Патч:
 *   1) глушить анімації на час знімка (`animations: 'disabled'`);
 *   2) бере таймаут з MIDSCENE_SCREENSHOT_TIMEOUT_MS (типово 30 с);
 *   3) якщо з глушінням не вийшло — один раз пробує зняти як є.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const TARGETS = [
  'node_modules/@midscene/web/dist/lib/puppeteer/base-page.js',
  'node_modules/@midscene/web/dist/es/puppeteer/base-page.mjs',
];

const MARKER = 'MIDSCENE_SCREENSHOT_TIMEOUT_MS';

const NEEDLE = `            const buffer = await this.underlyingPage.screenshot({
                type: imgType,
                quality,
                timeout: 10000
            });`;

const PATCH = `            const buffer = await (async () => {
                const timeoutMs = Number(process.env.MIDSCENE_SCREENSHOT_TIMEOUT_MS || 30000);
                try {
                    return await this.underlyingPage.screenshot({
                        type: imgType,
                        quality,
                        timeout: timeoutMs,
                        animations: 'disabled'
                    });
                } catch (error) {
                    console.warn(\`[midscene:warning] screenshot with animations disabled failed (\${(error && error.message) || error}), retrying as-is\`);
                    return await this.underlyingPage.screenshot({
                        type: imgType,
                        quality,
                        timeout: timeoutMs
                    });
                }
            })();`;

function patchFile(relativePath) {
  const filePath = path.join(ROOT, relativePath);
  if (!fs.existsSync(filePath)) {
    console.log(`[patch-midscene-screenshot] skip (missing): ${relativePath}`);
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  if (content.includes(MARKER)) {
    console.log(`[patch-midscene-screenshot] already patched: ${relativePath}`);
    return;
  }
  if (!content.includes(NEEDLE)) {
    console.warn(`[patch-midscene-screenshot] pattern not found: ${relativePath}`);
    return;
  }

  fs.writeFileSync(filePath, content.replace(NEEDLE, PATCH));
  console.log(`[patch-midscene-screenshot] patched: ${relativePath}`);
}

for (const target of TARGETS) patchFile(target);
