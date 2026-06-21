import { test, expect } from '@playwright/test';

const baseURL = process.env.UI_BASE_URL ?? 'http://localhost:3840';

test.describe('Dashboard UI smoke', () => {
  test.beforeEach(async ({ page }) => {
    const health = await page.request.get(`${baseURL}/api/health`).catch(() => null);
    test.skip(!health?.ok(), `Dashboard not running at ${baseURL}`);
  });

  test('Overview — stats and quick actions', async ({ page }) => {
    await page.goto(baseURL);
    await expect(page.getByRole('heading', { name: 'Огляд' })).toBeVisible();
    await expect(page.locator('.stat-grid')).toBeVisible();
    await expect(page.getByRole('link', { name: /AI: написати тест/i })).toBeVisible();
  });

  test('Launch page — run form', async ({ page }) => {
    await page.goto(`${baseURL}/launch`);
    await expect(page.getByRole('heading', { name: 'Запуск тестів' })).toBeVisible();
    await expect(page.locator('#target')).toBeVisible();
    await expect(page.locator('#mode')).toBeVisible();
  });

  test('Scenarios — list page', async ({ page }) => {
    await page.goto(`${baseURL}/scenarios`);
    await expect(page.getByRole('heading', { name: 'Сценарії' })).toBeVisible();
    await expect(page.getByRole('link', { name: '+ Новий' })).toBeVisible();
  });

  test('Scenario edit — new form', async ({ page }) => {
    await page.goto(`${baseURL}/scenarios/new`);
    await expect(page.locator('#goal')).toBeVisible();
    await expect(page.getByRole('heading', { name: /Новий сценарій/i })).toBeVisible();
  });

  test('Settings — defaults form', async ({ page }) => {
    await page.goto(`${baseURL}/settings`);
    await expect(page.getByRole('heading', { name: 'Налаштування' })).toBeVisible();
    await expect(page.locator('#defaultUrl')).toBeVisible();
  });

  test('Suites — create new suite', async ({ page }) => {
    const suiteName = `e2e-suite-${Date.now()}`;
    await page.goto(`${baseURL}/suites/new`);
    await expect(page.getByRole('heading', { name: 'Новий набір' })).toBeVisible();
    await page.locator('#name').fill(suiteName);
    await page.locator('.picker-row').first().locator('input[type="checkbox"]').check();
    await page.getByRole('button', { name: 'Зберегти набір' }).click();
    await expect(page).toHaveURL(/\/suites\/[a-z0-9-]+/i);
    await expect(page.getByRole('heading', { name: 'Редагування набору' })).toBeVisible();
    await expect(page.locator('#name')).toHaveValue(suiteName);
  });

  test('AI Lab — generator', async ({ page }) => {
    await page.goto(`${baseURL}/ai-lab`);
    await expect(page.getByRole('heading', { name: 'AI Лабораторія' })).toBeVisible();
    await expect(page.locator('#ai-desc')).toBeVisible();
  });

  test('Reports page', async ({ page }) => {
    await page.goto(`${baseURL}/reports`);
    await expect(page.getByRole('heading', { name: 'Звіти' })).toBeVisible();
  });

  test('Sidebar navigation', async ({ page }) => {
    await page.goto(baseURL);
    await page.getByRole('link', { name: 'Сценарії' }).click();
    await expect(page).toHaveURL(/\/scenarios/);
    await page.getByRole('link', { name: 'Налаштування' }).click();
    await expect(page).toHaveURL(/\/settings/);
    await page.getByRole('link', { name: 'Огляд' }).click();
    await expect(page).toHaveURL(new RegExp(`${baseURL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?$`));
  });
});
