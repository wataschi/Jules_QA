/**
 * Рендер `QA_STATUS.md` — файлу стану тестування, який бот комітить у main.
 *
 * Файл лежить у репо продукту й змінюється бот-комітом, тому вміст має бути
 * детермінованим: однакові дані → байт-у-байт однаковий текст. Звідси правила:
 *  - час з'являється лише в шапці й лише якщо його передали явно;
 *  - усі списки сортуються стабільно (модулі — за назвою, решта — за ID);
 *  - колонки таблиці вирівнюються пробілами, щоб диф читався й у сирому вигляді.
 *
 * Функція чиста: дані збирає сервер, тут лише текст.
 */

export interface StatusModuleRow {
  name: string;
  cases: number;
  withTests: number;
  passed: number;
  failed: number;
  /** Відсоток 0–100, як у звіті Stryker; `null` — мутаційне тестування не запускалось. */
  mutationScore: number | null;
  openTasks: number;
}

export interface StatusData {
  projectName: string;
  branch: string;
  sha: string;
  generatedAt?: string;
  modules: StatusModuleRow[];
  failed: Array<{ caseIds: string[]; title: string; file: string; defectId?: string }>;
  p1WithoutTests: Array<{ caseId: string; title: string }>;
  contradictions: Array<{ module: string; text: string; openDays: number }>;
  testsWithoutCase: number;
  directPushes: Array<{ sha: string; author?: string }>;
  dashboardUrl?: string;
}

const COLLATOR = new Intl.Collator('uk', { numeric: true, sensitivity: 'variant' });

function compareText(a: string, b: string): number {
  return COLLATOR.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Один рядок без переносів і зайвих пробілів — інакше ламається список чи таблиця. */
function inline(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function cell(text: string): string {
  return inline(text).replace(/\|/g, '\\|');
}

function formatMutation(score: number | null): string {
  if (score === null || !Number.isFinite(score)) return '—';
  return `${Math.round(score)}%`;
}

/** 1 день, 2 дні, 5 днів, 11 днів, 21 день. */
function pluralDays(n: number): string {
  const abs = Math.abs(n);
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} день`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} дні`;
  return `${n} днів`;
}

/**
 * Загальний mutation score — середнє, зважене кількістю кейсів модуля:
 * модуль на 3 кейси не повинен важити стільки ж, скільки модуль на 40.
 */
function totalMutation(modules: StatusModuleRow[]): number | null {
  const scored = modules.filter((m) => m.mutationScore !== null && Number.isFinite(m.mutationScore));
  if (scored.length === 0) return null;
  const weight = scored.reduce((sum, m) => sum + Math.max(m.cases, 0), 0);
  if (weight === 0) {
    return scored.reduce((sum, m) => sum + (m.mutationScore as number), 0) / scored.length;
  }
  return scored.reduce((sum, m) => sum + (m.mutationScore as number) * Math.max(m.cases, 0), 0) / weight;
}

type Align = 'left' | 'right';

function renderTable(header: string[], align: Align[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const pad = (value: string, i: number) =>
    align[i] === 'right' ? value.padStart(widths[i]) : value.padEnd(widths[i]);
  const line = (values: string[]) => `| ${values.map(pad).join(' | ')} |`;
  const separator = `|${widths
    .map((w, i) => (align[i] === 'right' ? `${'-'.repeat(w + 1)}:` : '-'.repeat(w + 2)))
    .join('|')}|`;
  return [line(header), separator, ...rows.map(line)];
}

function renderModules(modules: StatusModuleRow[]): string[] {
  const sorted = [...modules].sort((a, b) => compareText(a.name, b.name));
  const row = (m: Omit<StatusModuleRow, 'name'>, name: string) => [
    name,
    String(m.cases),
    String(m.withTests),
    String(m.passed),
    String(m.failed),
    formatMutation(m.mutationScore),
    String(m.openTasks),
  ];
  const sum = (key: 'cases' | 'withTests' | 'passed' | 'failed' | 'openTasks') =>
    sorted.reduce((acc, m) => acc + m[key], 0);
  const total = {
    cases: sum('cases'),
    withTests: sum('withTests'),
    passed: sum('passed'),
    failed: sum('failed'),
    mutationScore: totalMutation(sorted),
    openTasks: sum('openTasks'),
  };
  return renderTable(
    ['Модуль', 'Кейси', 'З тестами', 'Пройшли', 'Впали', 'Мутації', 'Задачі QA'],
    ['left', 'right', 'right', 'right', 'right', 'right', 'right'],
    [...sorted.map((m) => row(m, cell(m.name))), row(total, '**Разом**')],
  );
}

function firstKey(ids: string[]): string {
  return [...ids].sort(compareText)[0] ?? '';
}

function renderFailed(failed: StatusData['failed']): string[] {
  const sorted = [...failed].sort(
    (a, b) =>
      compareText(firstKey(a.caseIds), firstKey(b.caseIds)) ||
      compareText(a.file, b.file) ||
      compareText(a.title, b.title),
  );
  return sorted.map((f) => {
    const ids = [...new Set(f.caseIds)].sort(compareText).join(', ');
    const head = ids ? `${ids} ${inline(f.title)}` : inline(f.title);
    const defect = f.defectId ? ` · дефект ${inline(f.defectId)}` : '';
    return `- ${head} · ${inline(f.file)}${defect}`;
  });
}

/** Рендерить `QA_STATUS.md`. Результат завжди закінчується одним `\n`. */
export function renderStatusMarkdown(data: StatusData): string {
  const lines: string[] = [];
  const sha7 = data.sha.slice(0, 7);
  lines.push(`# Стан тестування · ${inline(data.branch)} @ ${sha7}`, '');

  const meta = [`Проєкт: ${inline(data.projectName)}`];
  if (data.generatedAt) meta.push(`оновлено ${inline(data.generatedAt)}`);
  lines.push(meta.join(' · '), '');

  if (data.modules.length === 0) {
    lines.push('Модулів із кейсами ще немає.', '');
  } else {
    lines.push(...renderModules(data.modules), '');
  }

  let problems = false;
  const section = (title: string, body: string[]) => {
    problems = true;
    lines.push(`## ${title}`, ...body, '');
  };

  if (data.failed.length > 0) section('Впали', renderFailed(data.failed));

  if (data.p1WithoutTests.length > 0) {
    const sorted = [...data.p1WithoutTests].sort(
      (a, b) => compareText(a.caseId, b.caseId) || compareText(a.title, b.title),
    );
    section(
      'P1 без тестів',
      sorted.map((c) => `- ${inline(c.caseId)} ${inline(c.title)}`),
    );
  }

  if (data.contradictions.length > 0) {
    const sorted = [...data.contradictions].sort(
      (a, b) => compareText(a.module, b.module) || compareText(a.text, b.text),
    );
    section(
      'Суперечності вимога ↔ макет ↔ код',
      sorted.map(
        (c) =>
          `- ${inline(c.module)} / ${inline(c.text)} · питання до QA відкрите ${pluralDays(c.openDays)}`,
      ),
    );
  }

  if (data.testsWithoutCase > 0) {
    section(`Тести без кейса: ${data.testsWithoutCase}`, [
      'Додайте ID кейса в назву тесту або зарезервуйте новий кейс (`jules-qa case reserve`).',
    ]);
  }

  if (data.directPushes.length > 0) {
    // Порядок комітів — хронологія з git, тому не пересортовуємо, лише прибираємо дублі.
    const seen = new Set<string>();
    const body: string[] = [];
    for (const push of data.directPushes) {
      if (seen.has(push.sha)) continue;
      seen.add(push.sha);
      body.push(`- ${push.sha.slice(0, 7)}${push.author ? ` · ${inline(push.author)}` : ''}`);
    }
    section('Коміти в main повз PR', body);
  }

  if (!problems && data.modules.length > 0) lines.push('✅ Усе зелено', '');

  if (data.dashboardUrl) lines.push(`[Відкрити дашборд](${data.dashboardUrl})`, '');
  lines.push('_Файл згенеровано Jules QA. Не редагуйте вручну._');

  return `${lines.join('\n')}\n`;
}
