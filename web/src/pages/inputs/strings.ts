/** Рядки екранів «Входи» і «Новий проєкт». */
import type { Asset, RequirementView, SourceNode } from '../../types';

export const SI = {
  sub: 'Сторінки Confluence і макети Figma, з яких агенти беруть вимоги. Тут видно, що змінилось, і що треба погодити на картинках.',
  wizardLink: 'Майстер нового проєкту',

  tabs: { label: 'Розділи входів', sources: 'Джерела', readings: 'Чекають прочитання' },

  actions: {
    syncAll: 'Оновити все',
    syncing: 'Оновлюємо…',
    addConfluence: 'Додати сторінку Confluence',
    addFigma: 'Додати макет Figma',
    modules: 'Модулі з дерева',
    syncSource: 'Оновити сторінку',
    openOriginal: 'Відкрити оригінал',
    back: '← До списку джерел',
  },

  tree: {
    title: 'Джерела',
    hint: 'Галочка — беремо сторінку у вимоги. Перемикач — вміст лишається в Jules, агентам не віддається.',
    include: (title: string) => `Брати «${title}»`,
    noAgents: 'Не віддавати агентам',
    noAgentsFor: (title: string) => `Не віддавати агентам: ${title}`,
    expand: (title: string) => `Розгорнути «${title}»`,
    collapse: (title: string) => `Згорнути «${title}»`,
    blocks: (n: number) => `${n} ${plural(n, 'блок', 'блоки', 'блоків')}`,
    gaps: (n: number) => `${n} ${plural(n, 'прогалина', 'прогалини', 'прогалин')}`,
    gapsHint: 'Блоки без жодного кейса',
    checked: 'Перевірено',
    notChecked: 'Ще не перевірялось',
    noModule: 'без модуля',
    excluded: 'не беремо',
    empty: 'Джерел ще немає',
    emptyHint: 'Додайте посилання на сторінку Confluence або макет Figma — або пройдіть майстер нового проєкту.',
    flagSaved: 'Збережено',
  },

  kind: {
    confluence: 'Confluence',
    figma: 'Figma',
    file: 'Файл',
    paste: 'Текст',
  } satisfies Record<SourceNode['kind'], string>,

  view: {
    pick: 'Виберіть сторінку або макет зліва',
    pickHint: 'Справа буде текст вимог по блоках, картинки й схеми, пов’язані кадри Figma.',
    module: 'Модуль',
    checked: 'Перевірено',
    version: 'Версія',
    blocks: 'Блоки',
    noBlocks: 'На сторінці ще немає блоків',
    noBlocksHint: 'Натисніть «Оновити сторінку», щоб Jules забрав її вміст.',
    excluded: 'Цю сторінку не беремо у вимоги — зніміть галочку в дереві, щоб повернути.',
    withheld: 'Агентам не віддається',
    lastError: 'Остання перевірка не вдалась',
    synced: 'Сторінку оновлено',
  },

  change: {
    same: '',
    changed: 'Змінено',
    new: 'Нове',
    removed: 'Прибрано',
  } satisfies Record<RequirementView['changeState'], string>,
  changeHint: {
    changed: 'Текст блоку змінився з минулого імпорту — перевірте пов’язані кейси',
    new: 'Блок з’явився в останньому імпорті',
  },

  block: {
    assets: 'Вкладення',
    frames: 'Макет Figma',
    framesLoading: 'Завантажуємо кадри…',
    route: 'Маршрут застосунку',
    routeHint: 'Адреса екрана в застосунку, напр. /acts/new — потрібна для візуальних перевірок.',
    routeSave: 'Зберегти маршрут',
    routeSaved: 'Маршрут збережено',
    texts: 'Тексти кадру',
    request: 'Попросити тест',
    frameLabel: (heading: string) => `Кадр «${heading}»`,
  },

  asset: {
    kind: { image: 'Картинка', diagram: 'Схема', frame: 'Кадр' } satisfies Record<Asset['kind'], string>,
    extracted: 'Текст, витягнутий зі схеми',
    reading: 'Як агент прочитав картинку',
    readingApproved: 'Погоджене прочитання',
    readingBy: 'Описав',
    needed: 'Текст тут лише на картинці. Агент розробника опише її в задачі «Прочитати картинку», а ви погодите опис.',
    error: 'Не вдалося забрати вкладення',
    approve: 'Погодити',
    approveEdit: 'Погодити з правкою',
    reject: 'Відхилити',
    editLabel: 'Прочитання (можна виправити)',
    saveApprove: 'Зберегти й погодити',
    rejectNote: 'Що не так (необов’язково)',
    rejectNoteHint: 'Агент побачить це і опише картинку ще раз.',
    rejectConfirm: 'Відхилити прочитання',
    approved: 'Прочитання погоджено',
    rejected: 'Прочитання відхилено — агент опише ще раз',
    source: 'Джерело',
    openSource: 'Відкрити джерело',
    image: (name: string) => `Вкладення «${name}»`,
  },

  readings: {
    title: 'Картинки, що чекають прочитання',
    hint: 'Помилково прочитана схема дає хибні тести, тому кожне прочитання погоджує людина.',
    empty: 'Усе прочитано',
    emptyHint: 'Нових картинок без тексту немає. Вони з’являться після оновлення сторінок.',
  },

  sync: {
    title: 'Результат оновлення',
    changed: 'змінилось блоків',
    added: 'нових блоків',
    proposals: 'пропозицій змін кейсів',
    errors: 'помилок',
    unchanged: 'без змін',
    sources: 'джерел перевірено',
    readTasks: 'нових задач на прочитання',
    close: 'Сховати',
    oneResult: (r: { changed: number; added: number; proposals: number }) =>
      `Змінилось ${r.changed}, нових ${r.added}, пропозицій ${r.proposals}`,
  },

  addConfluence: {
    title: 'Додати сторінку Confluence',
    why: 'Jules забере сторінку з усіма дочірніми і покаже їх деревом, щоб ви вибрали, що брати.',
    link: 'Посилання на простір або сторінку',
    linkHint: 'Напр. https://wiki.corp.local/pages/viewpage.action?pageId=229300000 або /display/SPACE/Назва',
    load: 'Завантажити дерево',
    loading: 'Завантажуємо дерево…',
    loaded: (n: number) => `Завантажено ${n} ${plural(n, 'сторінку', 'сторінки', 'сторінок')}`,
    truncated: 'Дерево завелике — показано лише частину сторінок. Додайте окремо потрібну гілку.',
  },

  addFigma: {
    title: 'Додати макет Figma',
    why: 'Кадри макета стануть блоками вимог: точні тексти, стани компонентів і знімок екрана.',
    link: 'Посилання на файл, сторінку або кадр Figma',
    linkHint: 'Напр. https://www.figma.com/design/AbC123xYz/Payments',
    import: 'Імпортувати',
    importing: 'Імпортуємо…',
    imported: (r: { added: number; changed: number }) => `Макет імпортовано: нових кадрів ${r.added}, змінених ${r.changed}`,
  },

  modules: {
    title: 'Модулі з дерева',
    why: 'Сторінки першого рівня під коренем стануть модулями, і на кожен модуль агенти отримають задачу «План модуля».',
    root: 'Корінь дерева',
    noRoots: 'Спершу додайте сторінку Confluence з дочірніми сторінками.',
    preview: 'Стануть модулями',
    previewEmpty: 'Під цим коренем немає вибраних сторінок першого рівня.',
    create: 'Створити модулі й задачі плану',
    creating: 'Створюємо…',
    result: 'Готово',
    created: 'новий модуль',
    existed: 'модуль уже був',
    planTask: 'задача плану',
    planExists: 'план уже в роботі',
    summary: (modules: number, tasks: number) => `Модулів: ${modules}, задач плану: ${tasks}`,
  },

  errors: {
    notConfigured: 'Підключення не налаштоване на сервері Jules. Попросіть адміністратора додати змінні в .env і перезапустити Jules.',
    network: 'Jules не дістався до сервера. Confluence і Jira доступні лише через корпоративний VPN — перевірте, що VPN на Mac Studio підключено.',
    auth: 'Сервер відмовив у доступі. Перевірте токен (PAT) сервісного облікового запису і права на простір.',
    notFound: 'Сторінку за цим посиланням не знайдено. Перевірте посилання і доступ сервісного облікового запису.',
    details: 'Подробиці',
  },
};

export const SW = {
  title: 'Новий проєкт',
  sub: 'П’ять кроків: звідки беремо вимоги, як вони діляться на модулі і як репозиторій продукту звітує в Jules.',
  stepsLabel: 'Кроки майстра',
  step: (n: number) => `Крок ${n}`,
  back: 'Назад',
  next: 'Далі',
  skip: 'Пропустити',
  done: 'Готово',
  toInputs: 'Перейти до входів',
  steps: [
    {
      title: 'Confluence',
      why: 'Вимоги живуть у Confluence: Jules забере дерево сторінок, а ви позначите, які з них брати.',
    },
    {
      title: 'Figma',
      why: 'Макети дають точні тексти й стани екранів — агент перевірить їх у тестах і помітить розбіжності з вимогами.',
    },
    {
      title: 'Модулі',
      why: 'Модуль — це одиниця, яку агенти покривають тестами: на кожен створюється задача плану покриття.',
    },
    {
      title: 'Репозиторій і Jira',
      why: 'Репозиторій пов’язує вимоги з кодом і тестами, а Jira знадобиться для щотижневого звіту.',
    },
    {
      title: 'CI',
      why: 'CI репозиторію надсилає в Jules результати тестів — це єдине офіційне джерело стану.',
    },
  ],

  confluence: {
    configured: 'Confluence не налаштовано на сервері Jules — дерево не завантажиться, доки адміністратор не додасть CONFLUENCE_BASE_URL і CONFLUENCE_TOKEN.',
    tree: 'Дерево сторінок',
    treeHint: 'Зніміть галочку зі сторінок, які не стосуються продукту. Перемикач «Не віддавати агентам» — для чутливого вмісту.',
  },
  figma: {
    configured: 'Figma не налаштовано на сервері Jules — потрібен FIGMA_TOKEN користувача з місцем Full або Dev.',
    link: (n: number) => `Посилання Figma ${n}`,
    addLink: 'Ще одне посилання',
    removeLink: (n: number) => `Прибрати посилання ${n}`,
    importAll: 'Імпортувати макети',
    already: 'Уже імпортовані макети',
    optional: 'Якщо макетів немає, крок можна пропустити.',
  },
  repo: {
    repo: 'Репозиторій на GitHub',
    repoHint: 'У форматі owner/name, напр. acme/cabinet',
    repoInvalid: 'Очікується owner/name',
    jira: 'Ключ проєкту Jira (необов’язково)',
    jiraHint: 'Напр. CYBER. Без нього тижневий звіт лишиться лише в Jules.',
    jiraInvalid: 'Ключ — латинські великі літери й цифри, напр. CYBER',
    save: 'Зберегти',
    saved: 'Збережено',
  },
  ci: {
    issue: 'Видати токен CI',
    issuing: 'Видаємо…',
    noRepo: 'Спершу вкажіть репозиторій на кроці 4 — токен прив’язується до нього.',
    tokenLabel: 'Токен CI',
    once: 'Токен показується один раз. Скопіюйте його зараз і покладіть у секрет репозиторію JULES_TOKEN (Settings → Secrets and variables → Actions).',
    copy: 'Скопіювати',
    copied: 'Скопійовано',
    copyFailed: 'Не вдалося скопіювати — виділіть токен і скопіюйте вручну',
    how: 'Що далі в репозиторії продукту',
    s1: 'Покладіть токен у секрет репозиторію JULES_TOKEN.',
    s2: 'У корені репозиторію запустіть — команда додасть workflow, скіли й конфіг:',
    s3: 'Додайте секрети TS_OAUTH_CLIENT_ID і TS_OAUTH_SECRET — OAuth-клієнт Tailscale, через який CI на час прогону підключається до мережі з Jules. Їх можна покласти один раз на рівні організації GitHub.',
    s4: 'Додайте змінну репозиторію JULES_URL з адресою Jules:',
    existing: 'Уже видані токени для цього проєкту',
  },
};

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}
