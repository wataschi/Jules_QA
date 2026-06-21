import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';

dotenv.config();

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
    trace: 'on',
    video: 'on',
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
