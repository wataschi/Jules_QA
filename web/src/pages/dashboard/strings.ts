/** Рядки розділу «Цикл із агентами» на огляді. */

export const SD = {
  title: 'Цикл із агентами',
  sub: 'QA ставить задачу — агент розробника робить — QA погоджує',
  loadError: 'Не вдалося завантажити зведення циклу',

  decide: 'Чекає вашого рішення',
  decideNote: (review: number, needsInfo: number) => `на перевірці: ${review} · агент питає: ${needsInfo}`,
  decideNone: 'Нічого не чекає — агенти працюють самі',
  decideGo: 'Відкрити задачі',
  stale: (hours: number) => `Чекають довше ${hours} год`,
  staleNone: 'Усі задачі взяли вчасно',
  staleGo: 'Усі задачі в черзі',
  questions: 'Питання до людей',
  questionsNote: 'агент не може вирішити сам',
  questionsGo: 'Відповісти',
  pushes: 'Коміти в main повз PR',
  pushesNote: 'мають прийти через PR',

  byState: 'Задачі за станами',
  byStateEmpty: 'Задач ще немає. Попросіть тест із реєстру або з екрана «Входи».',
  ageHours: (hours: number) => (hours >= 48 ? `${Math.round(hours / 24)} дн` : `${Math.round(hours)} год`),
  oldest: 'Найдовше чекають',

  trace: 'Трасування',
  traceSub: 'від вимоги до тесту в коді',
  traceBlocks: 'Блоки вимог з кейсами',
  traceFrames: 'Кадри макетів з кейсами',
  traceCases: 'Погоджені кейси з тестами',
  traceOf: (part: number, total: number) => `${part} з ${total}`,
  p1NoTests: 'P1 без тестів',
  readings: 'Картинки чекають прочитання',
  readingsGo: 'До входів',
  traceEmpty: 'Вимог і макетів ще немає — підключіть Confluence і Figma на екрані «Входи».',

  tests: 'Тести в коді',
  testsTotal: (n: number) => `усього ${n}`,
  testsEmpty: 'CI ще не надсилав маніфест тестів.',
  level: { unit: 'Модульні (unit)', integration: 'Інтеграційні', e2e: 'Наскрізні (e2e)', visual: 'Візуальні' } as Record<string, string>,
  withoutCase: 'Без кейса',
  byAgent: 'Від агентів',
  quarantined: 'У карантині',

  main: 'Останній прогін на main',
  mainNone: 'Результатів з main ще немає. Їх надсилає CI після кожного пушу в main.',
  mainCommit: 'Коміт',
  mainFailed: (failed: number, total: number) => (failed > 0 ? `впало ${failed} з ${total}` : `усі ${total} пройшли`),
  mainMutation: 'Mutation score',
  mainMutationHint: (threshold: number) => `поріг для P1 — ${threshold}%`,
  mainMutationNone: 'не міряли',
  mainOpen: 'Відкрити в CI',

  direct: 'Коміти в main повз PR',
  directSub: 'Агент мав працювати лише через PR — гляньте, що це було',
  directEmpty: 'Усі коміти в main прийшли через PR.',
  directAck: 'Бачив',
  directAckLabel: (sha: string) => `Бачив коміт ${sha}`,
  directAcked: 'Позначено як переглянуте',
  directBy: (author: string) => `автор: ${author}`,

  acceptance: 'Якість роботи агентів',
  acceptanceSub: 'частка задач, які QA погодив з першої спроби',
  acceptanceEmpty: 'Агенти ще не здавали задач на перевірку.',
  acceptanceNote: (first: number, total: number) => `${first} з ${total}`,

  health: 'Зовнішні системи',
  healthOk: 'працює',
  healthDown: (since: string) => `лежить з ${since}`,
  healthNone: 'Перевірок ще не було',
  healthGo: 'Стан систем у налаштуваннях',
  targets: { confluence: 'Confluence', jira: 'Jira', figma: 'Figma', telegram: 'Telegram' } as Record<string, string>,
} as const;

/** «35 хв», «3 год», «2 дн» — скільки триває стан. */
export function formatSpan(iso: string | undefined): string {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 60) return `${minutes} хв`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} год`;
  return `${Math.round(hours / 24)} дн`;
}

/** Момент, з якого триває стан: «13:20» сьогодні, «16.10 13:20» раніше. */
export function formatSinceClock(iso: string | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const time = date.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' })} ${time}`;
}
