import { describe, expect, it } from 'vitest';
import { runDeterministicNavigation } from '../../../src/engine/hybrid-runner.js';
import { isEnvironmentFailure, TARGET_UNAVAILABLE } from '../../../src/engine/healer.js';
import type { Page } from '@playwright/test';

/** Сторінка-заглушка з керованим кодом відповіді та заголовком. */
function page(status: number | null, title = 'Каталог наборів даних'): Page {
  return {
    goto: async () => (status === null ? null : { status: () => status }),
    title: async () => title,
  } as unknown as Page;
}

const go = (p: Page): Promise<void> =>
  runDeterministicNavigation(p, undefined, 'https://target.example/catalog');

describe('runDeterministicNavigation — сторож входу в застосунок', () => {
  it('пропускає нормальну сторінку', async () => {
    await expect(go(page(200))).resolves.toBeUndefined();
  });

  it('падає на 5xx із позначкою недоступного середовища', async () => {
    await expect(go(page(503))).rejects.toThrow(new RegExp(`${TARGET_UNAVAILABLE}.*HTTP 503`));
  });

  it('падає на екрані захисту від ботів навіть із кодом 200', async () => {
    // Саме так поводиться Cloudflare: заголовок-заглушка, порожнє тіло.
    await expect(go(page(200, 'Just a moment...'))).rejects.toThrow(
      new RegExp(`${TARGET_UNAVAILABLE}.*Just a moment`),
    );
  });

  it('падає на 403 із заголовком антибот-захисту', async () => {
    await expect(go(page(403, 'Attention Required! | Cloudflare'))).rejects.toThrow(TARGET_UNAVAILABLE);
  });

  it('не чіпає 403 із нормальним заголовком — це може бути поведінка застосунку', async () => {
    await expect(go(page(403, 'Доступ заборонено — Мій застосунок'))).resolves.toBeUndefined();
  });

  it('не падає, коли відповіді немає (перехід у тому ж документі)', async () => {
    await expect(go(page(null))).resolves.toBeUndefined();
  });
});

describe('isEnvironmentFailure', () => {
  it('розпізнає власну позначку і сітьові збої Chromium', () => {
    expect(isEnvironmentFailure(`${TARGET_UNAVAILABLE}: https://x відповів HTTP 502`)).toBe(true);
    expect(isEnvironmentFailure('page.goto: net::ERR_NAME_NOT_RESOLVED at https://x')).toBe(true);
    expect(isEnvironmentFailure('net::ERR_CONNECTION_REFUSED')).toBe(true);
  });

  it('не приймає за середовище звичайні падіння тесту', () => {
    expect(isEnvironmentFailure('Assertion failed: перелік наборів видно')).toBe(false);
    expect(isEnvironmentFailure('page.screenshot: Timeout 10000ms exceeded')).toBe(false);
    // 503 від моделі — це не ціль тесту, і сюди потрапляти не має.
    expect(isEnvironmentFailure('Failed to call AI model service: 503')).toBe(false);
  });
});
