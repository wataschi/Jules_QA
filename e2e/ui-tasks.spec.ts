import { test, expect, type Page } from '@playwright/test';

/**
 * Екрани «Задачі» у режимі фікстур (`?mock=1`): перелік задач агентів,
 * швидкі вкладки, сторінка задачі з рішенням QA і новий запит.
 * Стан фікстур живе в пам'яті вкладки: кожен `page.goto` починає з нуля,
 * а переходи кліками всередині тесту зберігають зміни.
 */

const baseURL = process.env.UI_BASE_URL ?? 'http://localhost:3840';

async function gotoMock(page: Page, path: string): Promise<void> {
  const url = new URL(path, baseURL);
  url.searchParams.set('mock', '1');
  await page.goto(url.toString());
  await expect(page.locator('.shell-main')).toBeVisible();
}

const row = (page: Page, id: string) => page.locator(`table.tbl-tasks tbody tr[data-task-id="${id}"]`);

test.describe('Задачі агентів', () => {
  test.beforeEach(async ({ page }) => {
    const health = await page.request.get(`${baseURL}/api/health`).catch(() => null);
    test.skip(!health?.ok(), `Дашборд не запущено на ${baseURL}`);
  });

  test('Перелік задач відкривається з активними задачами', async ({ page }) => {
    await gotoMock(page, '/tasks');
    await expect(page.getByRole('heading', { name: 'Задачі', level: 1 })).toBeVisible();
    await expect(row(page, 'CYBER-T-1')).toBeVisible();
    // За замовчуванням закриті задачі сховано.
    await expect(row(page, 'CYBER-T-9')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Активні' })).toHaveAttribute('aria-selected', 'true');
  });

  test('Вкладка «Чекає вашого рішення» показує задачі на перевірці й питання агента', async ({ page }) => {
    await gotoMock(page, '/tasks');
    await page.getByRole('tab', { name: 'Чекає вашого рішення' }).click();
    await expect(page).toHaveURL(/state=review%2Cneeds_info/);

    const rows = page.locator('table.tbl-tasks tbody tr');
    await expect(rows).toHaveCount(3);
    for (const id of ['CYBER-T-3', 'CYBER-T-4', 'CYBER-T-5']) await expect(row(page, id)).toBeVisible();

    // Вкладка — частина адреси: переживає перезавантаження.
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Чекає вашого рішення' })).toHaveAttribute('aria-selected', 'true');
  });

  test('Задача на перевірці: видно «Що перевіряє» і PR, підтвердження наміру змінює стан', async ({ page }) => {
    await gotoMock(page, '/tasks?state=review,needs_info');
    await row(page, 'CYBER-T-3').click();
    await expect(page).toHaveURL(/\/tasks\/CYBER-T-3$/);

    await expect(page.getByRole('heading', { name: 'Що перевіряє' })).toBeVisible();
    await expect(page.getByTestId('task-checks')).toContainText('Користувач лишається на сторінці входу');
    await expect(page.getByRole('link', { name: /PR #42/ }).first()).toHaveAttribute('href', 'https://github.com/acme/cabinet/pull/42');

    await page.getByRole('button', { name: /Підтвердити намір/ }).click();
    await expect(page.getByText('Намір підтверджено').first()).toBeVisible();
    // Задача з PR лишається на перевірці до злиття — кнопка зникає, видно пояснення.
    await expect(page.getByText(/Задача закриється, коли PR зіллють/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Підтвердити намір/ })).toHaveCount(0);
  });

  test('Задача без PR після підтвердження закривається', async ({ page }) => {
    await gotoMock(page, '/tasks/CYBER-T-5');
    await expect(page.getByRole('heading', { name: 'Прочитати зображення: payment-form.png', level: 1 })).toBeVisible();
    await expect(page.locator('.tasks-asset img').first()).toBeVisible();

    await page.getByRole('button', { name: /Підтвердити намір/ }).click();
    await expect(page.getByText('Підтверджено, задачу закрито')).toBeVisible();
    await expect(page.locator('.card-head .chip', { hasText: 'Готово' })).toBeVisible();
  });

  test('Агент питає: видно питання, відповідь повертає задачу в чергу', async ({ page }) => {
    await gotoMock(page, '/tasks/CYBER-T-4');
    const question = page.getByTestId('task-question');
    await expect(question).toContainText('Сума 0 — це помилка валідації');

    await question.getByLabel('Ваша відповідь').fill('Сума 0 — помилка: акт-коригування робимо окремо.');
    await question.getByRole('button', { name: 'Надіслати відповідь' }).click();

    await expect(page.getByText('Відповідь надіслано — задача знову в черзі')).toBeVisible();
    await expect(page.locator('.card-head .chip', { hasText: 'У черзі' })).toBeVisible();
    await expect(page.getByTestId('task-question')).toHaveCount(0);
    await expect(page.locator('.tev-answer')).toContainText('акт-коригування робимо окремо');
  });

  test('Новий запит з’являється в переліку', async ({ page }) => {
    await gotoMock(page, '/tasks');
    await expect(row(page, 'CYBER-T-1')).toBeVisible();

    await page.getByRole('button', { name: /Новий запит/ }).first().click();
    let dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Модуль').selectOption({ label: 'Автентифікація' });
    await dialog.getByRole('button', { name: /Далі/ }).click();

    dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('request-anchor')).toContainText('Автентифікація');
    await dialog.getByLabel('Що перевірити').fill('Після виходу кнопка «Назад» не повертає в кабінет');
    await dialog.getByRole('button', { name: 'Надіслати' }).click();
    await expect(dialog).toBeHidden();

    await expect(page.getByRole('cell', { name: /Після виходу кнопка «Назад»/ })).toBeVisible();
    await expect(row(page, 'CYBER-T-10')).toBeVisible();
  });

  test('Клавіатура: j рухає курсор, Enter відкриває задачу', async ({ page }) => {
    await gotoMock(page, '/tasks');
    await expect(page.locator('table.tbl-tasks tbody tr').first()).toBeVisible();
    await page.locator('h1').click();
    await page.keyboard.press('j');
    await expect(page.locator('table.tbl-tasks tbody tr.cursor')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/tasks\/CYBER-T-\d+$/);
  });
});
