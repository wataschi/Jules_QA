/**
 * Рядки Jules 2.0, спільні для кількох екранів: назви задач і станів,
 * навігація до нових розділів, діалог «Попросити тест». Рядки окремого
 * екрана живуть поруч з ним (`pages/<розділ>/strings.ts`).
 */
import type { ReadingState, TaskKind, TaskState } from './types';

export const S2 = {
  empty: {
    noProject: 'Ще немає жодного проєкту',
    noProjectHint: 'Майстер підключить репозиторій, сторінки Confluence і файли Figma та запропонує модулі.',
    noProjectAction: 'Створити проєкт',
  },
  nav: {
    inputs: 'Входи',
    hintInputs: 'Confluence і Figma: які сторінки й макети беремо, що на картинках, що змінилось',
    tasks: 'Задачі',
    hintTasks: 'Що робить агент розробника: запити QA, план модулів, розбір падінь — і що чекає вашого рішення',
    setup: 'Новий проєкт',
  },
  taskKind: {
    add_test: 'Новий тест',
    change_test: 'Змінити тест',
    remove_test: 'Прибрати тест',
    plan_module: 'План модуля',
    read_asset: 'Прочитати картинку',
    triage: 'Розбір падіння',
    stabilize: 'Стабілізувати флейк',
    question: 'Питання до людей',
  } satisfies Record<TaskKind, string>,
  taskState: {
    new: 'Нова',
    queued: 'У черзі',
    claimed: 'В роботі',
    needs_info: 'Агент питає',
    review: 'На перевірці',
    failed: 'Не вдалося',
    done: 'Готово',
    rejected: 'Відхилено',
  } satisfies Record<TaskState, string>,
  readingState: {
    none: 'Текст без моделі',
    needed: 'Потрібне прочитання',
    proposed: 'Чекає вашого рішення',
    approved: 'Погоджено',
    rejected: 'Відхилено',
  } satisfies Record<ReadingState, string>,
  request: {
    button: 'Попросити тест',
    title: 'Запит агенту',
    kind: 'Що зробити',
    what: 'Що перевірити',
    whatHint: 'Одне речення в стилі чек-листа: «Акт без суми не зберігається».',
    details: 'Подробиці (необовʼязково)',
    detailsHint: 'Умови, межові значення, на що звернути увагу. Агент може перепитати.',
    priority: 'Пріоритет',
    send: 'Надіслати',
    sent: 'Задачу створено — агент розробника побачить її на старті сесії',
    anchor: 'Прив’язка',
  },
};

export const TASK_STATE_TONE: Record<TaskState, 'info' | 'good' | 'warn' | 'bad' | undefined> = {
  new: undefined,
  queued: undefined,
  claimed: 'info',
  needs_info: 'warn',
  review: 'warn',
  failed: 'bad',
  done: 'good',
  rejected: undefined,
};
