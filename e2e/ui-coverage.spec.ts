import { test, expect, type Page } from '@playwright/test';

/**
 * Покриття в чотири шари і тести в коді (режим фікстур `?mock=1`).
 *
 * Перевіряється: вкладка «Тести в коді» показує тест без кейса, фільтр
 * «упали» залишає лише експорт CSV, у деталях кейса видно тест від агента,
 * а «Попросити тест» відкриває діалог із прив'язкою до кейса.
 */

const baseURL = process.env.UI_BASE_URL ?? 'http://localhost:3840';

async function gotoMock(page: Page, path: string): Promise<void> {
  const url = new URL(path, baseURL);
  url.searchParams.set('mock', '1');
  await page.goto(url.toString());
  await expect(page.locator('.shell-main')).toBeVisible();
}

test.describe('Покриття: від вимоги до результату і тести в коді', () => {
  test.beforeEach(async ({ page }) => {
    const health = await page.request.get(`${baseURL}/api/health`).catch(() => null);
    test.skip(!health?.ok(), `Дашборд не запущено на ${baseURL}`);
  });

  test('Вкладка «Тести в коді» показує тест без кейса і пояснює, чому це прогалина', async ({ page }) => {
    await gotoMock(page, '/coverage');
    await page.getByRole('tab', { name: 'Тести в коді' }).click();
    await expect(page).toHaveURL(/tab=tests/);
    await expect(page.getByRole('heading', { name: 'Тести в коді продукту' })).toBeVisible();

    const orphan = page.locator('table.tbl tbody tr', { hasText: 'форматує суму з копійками' });
    await expect(orphan).toBeVisible();
    await expect(orphan.getByText('Без кейса')).toBeVisible();
    await expect(page.getByText(/перевірили те, чого ніхто не просив/)).toBeVisible();

    // «Показати лише їх» звужує перелік до тестів без кейса — і це видно в адресі.
    await page.getByRole('button', { name: 'Показати лише їх' }).click();
    await expect(page).toHaveURL(/nocase=1/);
    await expect(page.locator('table.tbl tbody tr')).toHaveCount(1);
  });

  test('Фільтр «упали» лишає тільки експорт у CSV і переживає перезавантаження', async ({ page }) => {
    await gotoMock(page, '/coverage?tab=tests');
    await expect(page.locator('table.tbl tbody tr').first()).toBeVisible();

    // Стан прапорця живе в адресі й оновлюється після переходу, тож клік, а не check().
    await page.getByLabel('Лише ті, що впали').click();
    await expect(page).toHaveURL(/failed=1/);
    await expect(page.getByLabel('Лише ті, що впали')).toBeChecked();
    const rows = page.locator('table.tbl tbody tr');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('CYBER-REP-001 експорт у CSV');
    await expect(rows.first()).toContainText('упав');

    await page.reload();
    await expect(page.getByLabel('Лише ті, що впали')).toBeChecked();
    await expect(page.locator('table.tbl tbody tr')).toHaveCount(1);
  });

  test('Трасування показує вимоги без кейсів і кейси без тестів', async ({ page }) => {
    await gotoMock(page, '/coverage?tab=trace');
    await expect(page.getByRole('heading', { name: 'Вимога → кейс → тест у коді → результат' })).toBeVisible();
    await expect(page.locator('.kpi', { hasText: 'Кейсів із тестами' })).toBeVisible();
    await expect(page.locator('.trace-row.gap').first()).toBeVisible();
    await expect(page.locator('.trace-case.no-tests').first()).toBeVisible();

    await page.getByLabel('Показати', { exact: true }).selectOption('no-cases');
    await expect(page).toHaveURL(/gap=no-cases/);
    await expect(page.locator('.trace-case')).toHaveCount(0);
    await expect(page.locator('.trace-row.gap').first()).toBeVisible();
  });

  test('У деталях кейса CYBER-REGC-001 видно e2e-тест, який написав агент', async ({ page }) => {
    await gotoMock(page, '/cases?case=CYBER-REGC-001');
    const section = page.locator('.case-tests');
    await expect(section).toBeVisible();
    await expect(section.getByRole('heading', { name: /Тести в коді/ })).toBeVisible();

    const row = section.locator('.trace-test', { hasText: 'e2e/acts/create.spec.ts' });
    await expect(row).toBeVisible();
    await expect(row.getByText('e2e', { exact: true })).toBeVisible();
    await expect(row.getByText('агент')).toBeVisible();
    await expect(row.getByText('пройшов')).toBeVisible();
  });

  test('«Попросити тест» на кейсі без тесту відкриває діалог із прив’язкою до кейса', async ({ page }) => {
    await gotoMock(page, '/cases?case=CYBER-REGC-002');
    const section = page.locator('.case-tests');
    await expect(section.getByText('Для цього кейса ще немає тесту в коді.')).toBeVisible();

    await section.getByRole('button', { name: 'Попросити тест' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('request-anchor')).toContainText('Кейс CYBER-REGC-002');
    // Назва кейса підставлена як намір — QA лише уточнює.
    await expect(dialog.getByLabel('Що перевірити')).not.toHaveValue('');

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});
