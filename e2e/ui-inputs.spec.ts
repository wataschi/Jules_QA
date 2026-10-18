import { test, expect, type Page } from '@playwright/test';

/**
 * «Входи» і майстер нового проєкту в режимі фікстур (`?mock=1`):
 * дерево Confluence і Figma, перегляд сторінки з картинкою й кадром,
 * погодження прочитання картинки, «не віддавати агентам», кроки майстра.
 */

const baseURL = process.env.UI_BASE_URL ?? 'http://localhost:3840';

async function gotoMock(page: Page, path: string): Promise<void> {
  const url = new URL(path, baseURL);
  url.searchParams.set('mock', '1');
  await page.goto(url.toString());
  await expect(page.locator('.shell-main')).toBeVisible();
}

test.describe('Входи і новий проєкт', () => {
  test.beforeEach(async ({ page }) => {
    const health = await page.request.get(`${baseURL}/api/health`).catch(() => null);
    test.skip(!health?.ok(), `Дашборд не запущено на ${baseURL}`);
  });

  test('Дерево джерел показує сторінку «Реєстр актів» і макет Figma', async ({ page }) => {
    await gotoMock(page, '/inputs');
    await expect(page.getByRole('heading', { name: 'Входи', level: 1 })).toBeVisible();
    const tree = page.locator('.inputs-tree-col');
    await expect(tree.getByRole('button', { name: 'Реєстр актів', exact: true })).toBeVisible();
    await expect(tree.getByRole('button', { name: 'Кабінет — макети' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Майстер нового проєкту/ })).toBeVisible();
  });

  test('Відкрите джерело показує блок «Створення акта» з картинкою і пов’язаним кадром', async ({ page }) => {
    await gotoMock(page, '/inputs');
    await page.locator('.inputs-tree-col').getByRole('button', { name: 'Реєстр актів', exact: true }).click();
    await expect(page).toHaveURL(/\/inputs\/src-acts/);

    const block = page.getByTestId('block-blk-acts-1');
    await expect(block.getByRole('heading', { name: 'Створення акта' })).toBeVisible();
    await expect(block.getByText('Змінено')).toBeVisible();
    await expect(block.getByRole('img', { name: 'Вкладення «payment-form.png»' })).toBeVisible();

    const frame = block.getByRole('article', { name: 'Кадр «Створення акта»' });
    await expect(frame).toBeVisible();
    await expect(frame.getByText('Вкажіть суму більшу за 0')).toBeVisible();

    // «Попросити тест» відкриває діалог із прив’язкою до блоку.
    await block.getByRole('button', { name: 'Попросити тест' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('request-anchor')).toContainText('Створення акта');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('Погодження прочитання картинки змінює стан на «Погоджено»', async ({ page }) => {
    await gotoMock(page, '/inputs/src-acts');
    const asset = page.getByTestId('asset-ast-img-1');
    await expect(asset.getByText('Чекає вашого рішення')).toBeVisible();
    await expect(asset.getByText(/кнопка «Зберегти» неактивна/)).toBeVisible();

    await asset.getByRole('button', { name: 'Погодити', exact: true }).click();
    await expect(asset.getByText('Погоджено', { exact: true })).toBeVisible();
    await expect(asset.getByRole('button', { name: 'Погодити', exact: true })).toHaveCount(0);
  });

  test('Вкладка «Чекають прочитання» збирає картинки без погодженого опису', async ({ page }) => {
    await gotoMock(page, '/inputs');
    await page.getByRole('tab', { name: /Чекають прочитання/ }).click();
    await expect(page).toHaveURL(/tab=readings/);
    await expect(page.getByTestId('asset-ast-img-1')).toBeVisible();
    await expect(page.getByTestId('asset-ast-img-2')).toBeVisible();
    await expect(page.getByTestId('asset-ast-drawio-1')).toHaveCount(0);
  });

  test('Перемикач «не віддавати агентам» перемикається', async ({ page }) => {
    await gotoMock(page, '/inputs');
    const toggle = page.getByRole('switch', { name: 'Не віддавати агентам: Реєстр актів' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  test('Майстер проходить усі кроки і на останньому показує токен CI', async ({ page }) => {
    await gotoMock(page, '/setup');
    await expect(page.getByRole('heading', { name: 'Новий проєкт', level: 1 })).toBeVisible();
    const next = page.getByRole('button', { name: /Далі/ });

    // 1. Confluence → дерево з галочками.
    await page.getByLabel('Посилання на простір або сторінку').fill('https://wiki.corp.local/pages/viewpage.action?pageId=229300000');
    await page.getByRole('button', { name: 'Завантажити дерево' }).click();
    await expect(page.getByText(/Завантажено \d+/)).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Брати «Реєстр актів»' })).toBeVisible();
    await next.click();
    await expect(page).toHaveURL(/step=2/);

    // 2. Figma.
    await page.getByLabel('Посилання Figma 1').fill('https://www.figma.com/design/AbC123xYz/Payments');
    await page.getByRole('button', { name: 'Імпортувати макети' }).click();
    await expect(page.getByText(/Макет імпортовано/)).toBeVisible();
    await next.click();

    // 3. Модулі з першого рівня дерева.
    await expect(page.getByRole('heading', { name: 'Модулі', level: 2 })).toBeVisible();
    await page.getByRole('button', { name: 'Створити модулі й задачі плану' }).click();
    await expect(page.getByTestId('modules-result')).toContainText('Автентифікація');
    await next.click();

    // 4. Репозиторій і Jira.
    await page.getByLabel('Репозиторій на GitHub').fill('acme/cabinet');
    await page.getByLabel('Ключ проєкту Jira (необов’язково)').fill('CYBER');
    await page.getByRole('button', { name: 'Зберегти' }).click();
    await expect(page.getByText('Збережено').first()).toBeVisible();

    // Повернутися назад можна — крок у адресі.
    await page.getByRole('button', { name: /Назад/ }).click();
    await expect(page).toHaveURL(/step=3/);
    await page.getByRole('button', { name: /Далі/ }).click();
    await next.click();
    await expect(page).toHaveURL(/step=5/);

    // 5. CI: токен показується один раз.
    await page.getByRole('button', { name: 'Видати токен CI' }).click();
    await expect(page.getByTestId('ci-token')).toHaveText(/^jqa_/);
    await expect(page.getByRole('button', { name: 'Скопіювати' })).toBeVisible();
    await expect(page.getByText(/JULES_TOKEN/).first()).toBeVisible();
    await expect(page.getByText(/jules-qa\.mjs init --hub/)).toBeVisible();
  });
});
