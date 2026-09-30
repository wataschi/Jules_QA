import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';

dotenv.config();

type TraceMode = 'on' | 'off' | 'retain-on-failure' | 'on-first-retry' | 'on-all-retries';
type VideoMode = 'on' | 'off' | 'retain-on-failure' | 'on-first-retry';

const TRACE_MODES: readonly TraceMode[] = ['on', 'off', 'retain-on-failure', 'on-first-retry', 'on-all-retries'];
const VIDEO_MODES: readonly VideoMode[] = ['on', 'off', 'retain-on-failure', 'on-first-retry'];

function pickMode<T extends string>(raw: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes(raw as T) ? (raw as T) : fallback;
}

/**
 * Свідомий компроміс: trace/video пишуться для всіх прогонів (повний пакет
 * доказів), АЛЕ trace зберігає ввід з клавіатури — тобто пароль, який
 * `src/engine/secret-type.ts` вводить через `page.keyboard.type`, потрапив би у
 * `trace.zip`, який сервер роздає по HTTP. Тому для сценаріїв із `secret:`-кроком
 * або `auth.profile` рушій (`src/server/test-runner.ts`, `src/cli/run.ts`)
 * виставляє QA_TRACE='off': такі прогони лишаються без трейсу, залишаються лише
 * видео/скриншоти та структурований evidence-pack.
 */
const trace = pickMode<TraceMode>(process.env.QA_TRACE, TRACE_MODES, 'on');
const video = pickMode<VideoMode>(process.env.QA_VIDEO, VIDEO_MODES, 'on');

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  timeout: Number(process.env.PW_TEST_TIMEOUT ?? process.env.MIDSCENE_MODEL_TIMEOUT ?? 600_000),
  reporter: [['html', { open: 'never', outputFolder: 'playwright-report' }], ['list']],
  use: {
    baseURL: process.env.QA_TARGET_URL ?? 'https://example.com',
    headless: process.env.QA_HEADED !== 'true',
    // Full evidence pack: trace + video + screenshots for every run, not just retries.
    // Керується QA_TRACE / QA_VIDEO (дефолт 'on'); див. коментар вище.
    trace,
    video,
    screenshot: 'on',
    viewport: { width: 1280, height: 768 },
    actionTimeout: 60_000,
    navigationTimeout: 60_000,
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: ['**/llm-*.spec.ts', '**/dashboard.spec.ts'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'dashboard',
      testMatch: '**/dashboard.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: process.env.UI_BASE_URL ?? 'http://localhost:3840',
      },
    },
    {
      name: 'llm',
      testMatch: '**/llm-*.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  outputDir: 'test-results',
});
