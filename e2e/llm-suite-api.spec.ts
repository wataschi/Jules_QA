import dotenv from 'dotenv';
import { test, expect } from '@playwright/test';
import { isLlmAvailable, waitForRunComplete } from './helpers/llm-gate.js';

dotenv.config();

const llmReady = await isLlmAvailable();
const apiBase = process.env.UI_BASE_URL ?? 'http://localhost:3840';

test.describe('@llm LLM-04 universal-smoke suite via API', () => {
  test.beforeAll(() => {
    test.skip(!llmReady, 'LLM endpoint unavailable');
  });

  test('runs universal-smoke suite to completion', async ({ request }) => {
    const health = await request.get(`${apiBase}/api/health`);
    expect(health.ok()).toBeTruthy();

    const runRes = await request.post(`${apiBase}/api/suites/universal-smoke/run`, {
      data: {
        qaTargetUrl: 'https://example.com',
        qaMode: 'warm-up',
      },
    });
    expect(runRes.status()).toBe(201);

    const run = (await runRes.json()) as { id: string; runType: string };
    expect(run.runType).toBe('suite');

    const result = await waitForRunComplete(run.id, apiBase);
    expect(result.status).toBe('passed');
  });
});
