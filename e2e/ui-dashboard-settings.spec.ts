import { test, expect, type Page } from '@playwright/test';

/**
 * Огляд і налаштування Jules 2.0 у режимі фікстур (`?mock=1`):
 * розділ «Цикл із агентами» на огляді, коміти повз PR, вкладки «Доступ»,
 * «Модулі» і «Звіти». Бекенд потрібен лише для віддачі зібраного web/dist.
 */

const baseURL = process.env.UI_BASE_URL ?? 'http://localhost:3840';

async function gotoMock(page: Page, path: string): Promise<void> {
  const url = new URL(path, baseURL);
  url.searchParams.set('mock', '1');
  await page.goto(url.toString());
  await expect(page.locator('.shell-main')).toBeVisible();
}

test.describe('Огляд і налаштування Jules 2.0', () => {
  test.beforeEach(async ({ page }) => {
    const health = await page.request.get(`${baseURL}/api/health`).catch(() => null);
    test.skip(!health?.ok(), `Дашборд не запущено на ${baseURL}`);
  });

  test('Огляд показує цикл із агентами, а «Чекає вашого рішення» веде на задачі', async ({ page }) => {
    await gotoMock(page, '/');
    await expect(page.getByRole('heading', { name: 'Цикл із агентами' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Трасування/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Якість роботи агентів/ })).toBeVisible();

    await page.getByRole('link', { name: /Чекає вашого рішення/ }).click();
    await expect(page).toHaveURL(/\/tasks\?.*state=review/);
    await expect(page).toHaveURL(/state=needs_info/);
  });

  test('«Бачив» прибирає коміт повз PR з огляду', async ({ page }) => {
    await gotoMock(page, '/');
    const seen = page.getByRole('button', { name: 'Бачив коміт 9e8d7c6' });
    await expect(seen).toBeVisible();
    await seen.click();
    await expect(seen).toBeHidden();
    await expect(page.getByText('Усі коміти в main прийшли через PR.')).toBeVisible();
  });

  test('Доступ: значення нового токена показується лише один раз', async ({ page }) => {
    await gotoMock(page, '/settings?tab=access');
    await expect(page.getByRole('tab', { name: 'Доступ' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Хто я' })).toBeVisible();

    await page.getByLabel('Назва', { exact: true }).fill('CI nightly');
    await page.getByRole('button', { name: 'Видати', exact: true }).click();

    const value = page.getByLabel('Значення токена');
    await expect(value).toBeVisible();
    await expect(value).toHaveValue(/^jqa_/);
    const token = await value.inputValue();
    await expect(page.getByRole('button', { name: 'Скопіювати' })).toBeVisible();
    // Новий токен зʼявився в списку — але лише назвою, без значення.
    await expect(page.getByRole('cell', { name: 'CI nightly', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Я зберіг токен' }).click();
    await expect(value).toBeHidden();
    await expect(page.locator(`input[value="${token}"]`)).toHaveCount(0);
    await expect(page.getByText(token)).toHaveCount(0);
  });

  test('Модулі: шляхи коду зберігаються', async ({ page }) => {
    await gotoMock(page, '/settings?tab=modules');
    const paths = page.getByLabel('Шляхи коду для «Автентифікація»');
    const save = page.getByRole('button', { name: 'Зберегти модуль «Автентифікація»' });
    await expect(paths).toBeVisible();
    await expect(save).toBeDisabled();

    await paths.fill('src/auth/**\nsrc/session/**');
    await expect(save).toBeEnabled();
    await save.click();

    await expect(page.getByText('Модуль «Автентифікація» збережено')).toBeVisible();
    await expect(paths).toHaveValue('src/auth/**\nsrc/session/**');
    await expect(save).toBeDisabled();
  });

  test('Звіти: видно тижневий звіт, його можна опублікувати в Jira', async ({ page }) => {
    await gotoMock(page, '/settings?tab=reports');
    await expect(page.getByRole('heading', { name: 'Тижневий звіт' })).toBeVisible();
    await expect(page.getByText(/Прогонів на main: 14/)).toBeVisible();
    await expect(page.getByLabel('Тиждень')).toBeVisible();

    await page.getByLabel('Висновки').fill('Стабілізували експорт, наступного тижня — P1 автентифікації.');
    await page.getByRole('button', { name: 'Опублікувати в Jira' }).click();
    const weekly = page.getByRole('region', { name: 'Тижневий звіт' });
    await expect(weekly.getByRole('status')).toContainText('CYBER-1234');

    // QA_STATUS.md — у моноширинному блоці, як його бачать у репо.
    await expect(page.locator('pre.status-md')).toContainText('Стан тестування');
  });
});
