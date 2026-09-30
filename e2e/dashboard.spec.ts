import { test, expect, type Page } from '@playwright/test';

/**
 * Смоук нового веб-інтерфейсу (реєстр тест-кейсів).
 *
 * Тест НЕ вимагає ні LLM, ні наповненого реєстру. Перевіряються дві речі:
 *   1. без бекенда `/api/registry/**` інтерфейс не падає, а показує
 *      ErrorState із кнопкою «Спробувати ще»;
 *   2. у режимі фікстур (`?mock=1`, див. web/README.md) працюють навігація
 *      по шести розділах, таблиці, діалоги, клавіатура й адаптивність.
 *
 * `?mock=1` — інструмент розробки інтерфейсу: клієнт API підміняється
 * фікстурами в пам'яті вкладки. Прапорець зберігається в localStorage,
 * тому кожен тест стартує з нового контексту (Playwright так і робить).
 */

const baseURL = process.env.UI_BASE_URL ?? 'http://localhost:3840';

/** Перехід у режимі фікстур: прапорець ставимо явно на кожен перехід. */
async function gotoMock(page: Page, path: string): Promise<void> {
  const url = new URL(path, baseURL);
  url.searchParams.set('mock', '1');
  await page.goto(url.toString());
  // Каркас, а не бокова навігація: до 900 px вона схована в шухляді.
  await expect(page.locator('.shell-main')).toBeVisible();
}

test.describe('Веб-інтерфейс реєстру', () => {
  test.beforeEach(async ({ page }) => {
    const health = await page.request.get(`${baseURL}/api/health`).catch(() => null);
    test.skip(!health?.ok(), `Дашборд не запущено на ${baseURL}`);
  });

  test('Без бекенда реєстру показує помилку, а не порожній екран', async ({ page }) => {
    // Явно вимикаємо режим фікстур, щоб перевірити справжні запити.
    await page.goto(`${baseURL}/?mock=0`);
    await expect(page.locator('.shell-main')).toBeVisible();

    // Або дані завантажились (бекенд готовий), або видно ErrorState із кнопкою.
    const errorRetry = page.getByRole('button', { name: 'Спробувати ще' });
    const kpi = page.locator('.kpi').first();
    await expect(errorRetry.or(kpi).first()).toBeVisible({ timeout: 15_000 });
  });

  test('Навігація по шести розділах', async ({ page }) => {
    await gotoMock(page, '/');
    await expect(page.getByRole('heading', { name: 'Огляд', level: 1 })).toBeVisible();

    const nav = page.locator('.shell-nav');
    await nav.getByRole('link', { name: 'Реєстр' }).click();
    await expect(page).toHaveURL(/\/cases/);
    await expect(page.getByRole('heading', { name: 'Реєстр тест-кейсів', level: 1 })).toBeVisible();

    await nav.getByRole('link', { name: 'Погодження' }).click();
    await expect(page).toHaveURL(/\/proposals/);
    await expect(page.getByRole('heading', { name: 'Погодження', level: 1 })).toBeVisible();

    await nav.getByRole('link', { name: 'Прогони' }).click();
    await expect(page).toHaveURL(/\/runs/);
    await expect(page.getByRole('heading', { name: 'Прогони', level: 1 })).toBeVisible();

    await nav.getByRole('link', { name: 'Покриття' }).click();
    await expect(page).toHaveURL(/\/coverage/);
    await expect(page.getByRole('heading', { name: 'Покриття вимог', level: 1 })).toBeVisible();

    await nav.getByRole('link', { name: 'Налаштування' }).click();
    await expect(page).toHaveURL(/\/settings/);
    await expect(page.getByRole('heading', { name: 'Налаштування', level: 1 })).toBeVisible();

    await nav.getByRole('link', { name: 'Огляд' }).click();
    await expect(page.getByRole('heading', { name: 'Огляд', level: 1 })).toBeVisible();
  });

  test('Невідома адреса дає сторінку 404', async ({ page }) => {
    await gotoMock(page, '/такого-розділу-немає');
    await expect(page.getByRole('heading', { name: 'Сторінки не існує' })).toBeVisible();
    await page.getByRole('link', { name: 'На дашборд' }).click();
    await expect(page.getByRole('heading', { name: 'Огляд', level: 1 })).toBeVisible();
  });

  test('Реєстр: дерево, таблиця, фільтри в адресі', async ({ page }) => {
    await gotoMock(page, '/cases');

    await expect(page.locator('.tree-btn').first()).toBeVisible();
    const rows = page.locator('table.tbl tbody tr');
    await expect(rows.first()).toBeVisible();

    // Фільтр за пріоритетом потрапляє в query і переживає перезавантаження.
    await page.getByLabel('Пріоритет', { exact: true }).selectOption('P1');
    await expect(page).toHaveURL(/priority=P1/);
    await page.reload();
    await expect(page.getByLabel('Пріоритет', { exact: true })).toHaveValue('P1');

    // Сортування колонки також в адресі.
    await page.getByRole('button', { name: 'Назва' }).click();
    await expect(page).toHaveURL(/sort=title/);

    await page.getByRole('button', { name: 'Скинути фільтри' }).click();
    await expect(page).not.toHaveURL(/priority=/);
  });

  test('Реєстр: клавіатура — пошук, рух, вибір рядка', async ({ page }) => {
    await gotoMock(page, '/cases');
    await expect(page.locator('table.tbl tbody tr').first()).toBeVisible();

    // «/» фокусує пошук
    await page.keyboard.press('/');
    await expect(page.locator('#case-search')).toBeFocused();
    await page.keyboard.press('Escape');
    await page.locator('h1').click();

    // j рухає курсор, пробіл вибирає рядок → з'являється панель масових дій
    await page.keyboard.press('j');
    await page.keyboard.press(' ');
    await expect(page.locator('.bulkbar')).toBeVisible();

    // Enter відкриває деталі кейса — вибраний кейс теж в адресі
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/case=/);
    await expect(page.getByRole('heading', { name: 'Деталі кейса' })).toBeVisible();
  });

  test('Реєстр: діалог масової заміни відкривається і закривається по Esc', async ({ page }) => {
    await gotoMock(page, '/cases');
    await expect(page.locator('table.tbl tbody tr').first()).toBeVisible();

    await page.locator('table.tbl tbody tr').first().locator('input[type="checkbox"]').check();
    await expect(page.locator('.bulkbar')).toBeVisible();

    await page.getByRole('button', { name: 'Замінити текст' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    // Поки не порахували — застосувати не можна.
    await expect(dialog.getByRole('button', { name: 'Застосувати' })).toBeDisabled();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('Погодження: видно, де цитата вимоги, а де домисел AI', async ({ page }) => {
    await gotoMock(page, '/proposals');
    await expect(page.locator('.proposal').first()).toBeVisible();

    await expect(page.locator('.proposal.quote').first()).toBeVisible();
    await expect(page.locator('.proposal.derived').first()).toBeVisible();
    await expect(page.getByText('Домисел AI (у вимозі цього немає)').first()).toBeVisible();

    // Кнопки дій вимкнені, поки нічого не вибрано.
    await expect(page.getByRole('button', { name: /Погодити вибрані/ })).toBeDisabled();
    await page.locator('.proposal').first().locator('input[type="checkbox"]').check();
    await expect(page.getByRole('button', { name: /Погодити вибрані/ })).toBeEnabled();

    // Diff розкривається.
    await page.locator('.proposal').first().getByRole('button', { name: 'Показати зміни' }).click();
    await expect(page.locator('.diff').first()).toBeVisible();
  });

  test('Погодження: пачку не пропускає без підтвердження', async ({ page }) => {
    await gotoMock(page, '/proposals');
    await expect(page.locator('.proposal').first()).toBeVisible();

    await page.getByRole('button', { name: 'Вибрати всі на сторінці' }).click();
    await page.getByRole('button', { name: /Погодити вибрані/ }).click();

    // Погодження створює кейси і не відкочується — питаємо явно.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/Скасувати погодження одним рухом не можна/)).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('Прогони: список і режим проходження чек-листа з клавіатури', async ({ page }) => {
    await gotoMock(page, '/runs');
    const runLink = page.locator('table.tbl tbody tr').first().getByRole('link');
    await expect(runLink).toBeVisible();
    await runLink.click();

    await expect(page).toHaveURL(/\/runs\/[^/]+$/);
    await expect(page.getByRole('heading', { name: 'Чек-лист прогону' })).toBeVisible();
    await expect(page.locator('.run-item').first()).toBeVisible();

    // Кнопки керування прогоном на місці.
    await expect(page.getByRole('button', { name: 'Завершити прогін' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Перезапустити впалі' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Запустити автоматизовані' })).toBeVisible();

    // Клавіша «1» ставить статус «пройдено» поточному кейсу.
    const first = page.locator('.run-item').first();
    await page.keyboard.press('1');
    await expect(first.locator('.chip', { hasText: 'пройдено' }).first()).toBeVisible();

    // j / k рухають курсор по кейсах.
    await page.keyboard.press('j');
    await expect(page.locator('.run-item.cursor')).toHaveCount(1);
    await page.keyboard.press('k');
    await expect(page.locator('.run-item.cursor')).toHaveCount(1);
  });

  test('Покриття: матриця з прогалинами та імпорт джерела', async ({ page }) => {
    await gotoMock(page, '/coverage');
    await expect(page.getByRole('heading', { name: 'Вимога → кейси, які її перевіряють' })).toBeVisible();
    await expect(page.locator('.matrix-row').first()).toBeVisible();
    await expect(page.locator('.matrix-row.gap').first()).toBeVisible();

    await page.getByRole('button', { name: 'Імпортувати вимоги' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Імпортувати' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('Прогін: автоматичний відкривається на результатах рушія', async ({ page }) => {
    await gotoMock(page, '/runs');
    // У моці є прогін із автопрогонами — заходимо в перший.
    await page.locator('table.tbl tbody tr').first().getByRole('link').click();
    await expect(page).toHaveURL(/\/runs\/[^/]+$/);

    // Вкладки зʼявляються лише там, де є що показати з рушія.
    const results = page.getByRole('tab', { name: 'Результати рушія' });
    await expect(results).toBeVisible();
    await results.click();

    // Покрокова картина, а не ручний чек-лист.
    await expect(page.locator('.step').first()).toBeVisible();
    await expect(page.locator('.step.failed').first()).toBeVisible();
    await expect(page.getByText('На місці списку порожній блок').first()).toBeVisible();

    // Непідтверджений вердикт названо своїм іменем і показано, що йому суперечить.
    await expect(page.getByText('під питанням').first()).toBeVisible();
    await expect(page.getByText(/пройшов після цієї перевірки/).first()).toBeVisible();

    // Ручний чек-лист нікуди не зник — на нього можна повернутись.
    await page.getByRole('tab', { name: 'Чек-лист' }).click();
    await expect(page.locator('.status-picker').first()).toBeVisible();
  });

  test('Налаштування: розділи по вкладках, активна вкладка в адресі', async ({ page }) => {
    await gotoMock(page, '/settings');

    // Перша вкладка — проєкт і доступ.
    await expect(page.getByRole('heading', { name: 'Проєкт', exact: true })).toBeVisible();

    await page.getByRole('tab', { name: 'Підключення' }).click();
    await expect(page.getByRole('heading', { name: 'Підключення' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Правила вивантаження в TestRail' })).toBeVisible();
    await expect(page).toHaveURL(/tab=integrations/);

    await page.getByRole('tab', { name: 'Прогони і робота AI' }).click();
    await expect(page.getByRole('heading', { name: 'Типові параметри прогонів' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Журнал роботи AI' })).toBeVisible();

    // Вкладку можна відкрити посиланням — стан живе в адресі, а не в пам'яті.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Журнал роботи AI' })).toBeVisible();
  });

  test('Довідка по клавішах відкривається по «?» і закривається по Esc', async ({ page }) => {
    await gotoMock(page, '/');
    await page.keyboard.press('?');
    const dialog = page.getByRole('dialog', { name: 'Клавіатура' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Фокус у пошук')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('Перемикач теми зберігає вибір', async ({ page }) => {
    await gotoMock(page, '/');
    await page.getByRole('button', { name: /^(Темна|Світла) тема$/ }).click();

    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', /^(light|dark)$/);
    const theme = await html.getAttribute('data-theme');

    // Вибір теми переживає перезавантаження (localStorage + інлайн-скрипт).
    await page.reload();
    await expect(page.locator('.shell-main')).toBeVisible();
    await expect(html).toHaveAttribute('data-theme', theme!);
  });

  test('Дефекти: список, розбір і зміна стану', async ({ page }) => {
    await gotoMock(page, '/defects');
    await expect(page.getByRole('heading', { name: 'Дефекти', level: 1 })).toBeVisible();

    // Рядок розкривається в деталі з керуванням станом.
    const first = page.getByRole('button', { name: /Фільтр реєстру не зберігається/ });
    await expect(first).toBeVisible();
    await first.click();

    const detail = page.locator('.row-detail');
    await expect(detail).toBeVisible();
    await detail.getByLabel('Стан').selectOption('triaged');
    await expect(page.getByText('Дефект оновлено')).toBeVisible();
  });

  test('Огляд веде з лічильника дефектів на їхній екран', async ({ page }) => {
    await gotoMock(page, '/');
    await page.getByRole('link', { name: /Дефекти/ }).first().click();
    await expect(page).toHaveURL(/\/defects/);
  });

  test('На широкому екрані в шапці немає мертвих контролів', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoMock(page, '/');

    // Гамбургер має сенс лише при висувній шухляді. На широкому екрані бокова
    // навігація і так на місці, тож кнопка не має висіти в шапці: раніше її
    // показував `.btn`, що перекривав `.burger { display: none }`.
    await expect(page.getByRole('button', { name: 'Відкрити навігацію' })).toBeHidden();
    await expect(page.locator('.shell-nav')).toBeVisible();

    // З одним проєктом випадний список нічого не перемикає — показуємо підпис.
    await expect(page.locator('#project-picker')).toHaveCount(0);
    await expect(page.locator('.header-project')).toBeVisible();
  });

  test('Огляд показує цикл роботи пʼятьма кроками', async ({ page }) => {
    await gotoMock(page, '/');
    const steps = page.locator('.cycle-step');
    await expect(steps).toHaveCount(5);
    // Кожен крок веде на свій екран — смужка це ще й навігація.
    await steps.nth(2).getByRole('link').click();
    await expect(page).toHaveURL(/\/proposals/);
  });

  test('До 900 px навігація стає висувною шухлядою', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await gotoMock(page, '/cases');

    const burger = page.getByRole('button', { name: 'Відкрити навігацію' });
    const nav = page.locator('.shell-nav');

    await expect(burger).toBeVisible();
    // Закрита шухляда схована повністю — її посилань немає і в tab-порядку.
    await expect(nav).toBeHidden();

    await burger.click();
    await expect(nav).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Покриття' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(nav).toBeHidden();

    // Нічого не обрізається: горизонтального скролу сторінки немає.
    // Вираз рядком — у кореневому tsconfig немає lib "dom", тож типів document тут нема.
    const overflows = await page.evaluate<boolean>(
      'document.documentElement.scrollWidth > document.documentElement.clientWidth + 1',
    );
    expect(overflows).toBe(false);
  });
});
