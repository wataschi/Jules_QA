/**
 * Тижневий звіт QA (потік H плану): цифри збирає Jules детерміновано, а висновки
 * (`insights`) дописує агент QA-ліда скілом `qa-weekly` — тож модель не вигадує числа.
 *
 * Один зміст рендериться у два формати:
 *  - `wikiMarkup` — опис задачі Jira Server/Data Center (вікі-розмітка, не ADF, як у Cloud);
 *  - `markdown` — для Telegram і дашборда. Без таблиць: Telegram їх не показує.
 *
 * Мітка `jules-weekly-<рік>-W<тиждень>` — ключ ідемпотентності: повторний запуск
 * оновлює задачу тижня, а не створює дубль (див. `upsertWeeklyIssue` у integrations/jira.ts).
 */

export interface WeeklyReportData {
  projectName: string;
  projectKey: string;
  /** ISO-тиждень: `2026-W42`. */
  weekLabel: string;
  period: { from: string; to: string };
  /** Успішність — відсоток 0–100. */
  runsOnMain: { count: number; passRate: number | null; prevPassRate: number | null };
  defects: {
    opened: Array<{ id: string; title: string; severity: string }>;
    closed: Array<{ id: string; title: string }>;
  };
  coverage: { totalCases: number; casesWithTests: number; casesWithTestsPrev: number; p1WithoutTests: number };
  tasks: { created: number; done: number; open: number; oldest: Array<{ id: string; title: string; ageDays: number }> };
  /** `flakeScore` — частка 0–1. */
  flaky: { count: number; quarantined: number; top: Array<{ caseId: string; title: string; flakeScore: number }> };
  changes: { requirements: number; designs: number };
  insights?: string;
  dashboardUrl?: string;
}

export interface WeeklyReport {
  summary: string;
  wikiMarkup: string;
  markdown: string;
  label: string;
}

/* ───────────────────────────── ISO-тижні ─────────────────────────────── */

const DAY_MS = 86_400_000;
const WEEK_LABEL_RE = /^(\d{4})-W(\d{2})$/;

/** ISO-8601 тиждень дати (за UTC): `2026-W42`. 29.12.2025 → `2026-W01`. */
export function isoWeekLabel(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  // Четвер того ж тижня визначає, якому року належить тиждень.
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const year = day.getUTCFullYear();
  const week = Math.ceil(((day.getTime() - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Понеділок першого ISO-тижня року (тиждень, що містить 4 січня). */
function isoWeekOneMonday(year: number): number {
  const jan4 = Date.UTC(year, 0, 4);
  const weekday = new Date(jan4).getUTCDay() || 7;
  return jan4 - (weekday - 1) * DAY_MS;
}

/** Межі тижня: понеділок 00:00Z — неділя 23:59:59.999Z, у форматі ISO. */
export function weekRange(label: string): { from: string; to: string } {
  const match = WEEK_LABEL_RE.exec(label.trim());
  if (!match) {
    throw new Error(`Неправильна мітка тижня «${label}». Очікується формат 2026-W42.`);
  }
  const year = Number(match[1]);
  const week = Number(match[2]);
  const weeksInYear = isoWeekLabel(new Date(Date.UTC(year, 11, 28))).endsWith('W53') ? 53 : 52;
  if (week < 1 || week > weeksInYear) {
    throw new Error(`У ${year} році немає тижня W${match[2]}: ISO-тижнів у ньому ${weeksInYear}.`);
  }
  const from = isoWeekOneMonday(year) + (week - 1) * 7 * DAY_MS;
  return { from: new Date(from).toISOString(), to: new Date(from + 7 * DAY_MS - 1).toISOString() };
}

/* ─────────────────────── модель документа ────────────────────────────── */

/** Шматок рядка: звичайний текст (екранується) або посилання. */
type Inline = string | { text: string; url: string } | { bold: string };

type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'para'; parts: Inline[] }
  | { kind: 'list'; items: Inline[][] }
  /** Пари «показник — значення»: у Jira таблиця, у markdown список. */
  | { kind: 'metrics'; rows: Array<[string, string]> }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'quote'; text: string };

/* ───────────────────────────── форматування ──────────────────────────── */

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${Math.round(value)}%`;
}

function signed(n: number, unit: string): string {
  if (n === 0) return `0 ${unit}`.trim();
  return `${n > 0 ? '+' : '−'}${Math.abs(n)}${unit ? ` ${unit}` : ''}`;
}

/** «91% (+3 п.п.)»: різниця округлених значень, щоб цифри в дужках збігались із видимими. */
function passRateWithTrend(current: number | null, previous: number | null): string {
  const base = formatPercent(current);
  if (current === null || previous === null || !Number.isFinite(current) || !Number.isFinite(previous)) {
    return base;
  }
  const delta = Math.round(current) - Math.round(previous);
  return delta === 0 ? `${base} (без змін)` : `${base} (${signed(delta, 'п.п.')})`;
}

function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n);
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

function inline(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const COLLATOR = new Intl.Collator('uk', { numeric: true, sensitivity: 'variant' });

function compareText(a: string, b: string): number {
  return COLLATOR.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

function datePart(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : iso;
}

/* ───────────────────────────── зміст звіту ───────────────────────────── */

function buildBlocks(data: WeeklyReportData): Block[] {
  const blocks: Block[] = [];
  blocks.push({
    kind: 'para',
    parts: [`Період: ${datePart(data.period.from)} — ${datePart(data.period.to)} · проєкт ${data.projectKey}`],
  });

  const runs = data.runsOnMain;
  blocks.push({ kind: 'heading', text: 'Прогони на main' });
  blocks.push({
    kind: 'metrics',
    rows: [
      ['Прогонів', String(runs.count)],
      ['Успішність', passRateWithTrend(runs.passRate, runs.prevPassRate)],
    ],
  });

  const cov = data.coverage;
  const growth = cov.casesWithTests - cov.casesWithTestsPrev;
  const covPct = cov.totalCases > 0 ? ` (${Math.round((cov.casesWithTests / cov.totalCases) * 100)}%)` : '';
  blocks.push({ kind: 'heading', text: 'Покриття кейсів тестами' });
  blocks.push({
    kind: 'metrics',
    rows: [
      ['Кейсів із тестами', `${cov.casesWithTests} з ${cov.totalCases}${covPct}`],
      ['Приріст за тиждень', signed(growth, '')],
      ['P1 без тестів', String(cov.p1WithoutTests)],
    ],
  });

  const { opened, closed } = data.defects;
  blocks.push({ kind: 'heading', text: 'Дефекти' });
  blocks.push({
    kind: 'metrics',
    rows: [
      ['Нових', String(opened.length)],
      ['Закрито', String(closed.length)],
    ],
  });
  if (opened.length > 0) {
    blocks.push({ kind: 'para', parts: [{ bold: 'Нові:' }] });
    blocks.push({
      kind: 'table',
      header: ['ID', 'Назва', 'Серйозність'],
      rows: [...opened].sort((a, b) => compareText(a.id, b.id)).map((d) => [d.id, d.title, d.severity]),
    });
  }
  if (closed.length > 0) {
    blocks.push({ kind: 'para', parts: [{ bold: 'Закриті:' }] });
    blocks.push({
      kind: 'list',
      items: [...closed].sort((a, b) => compareText(a.id, b.id)).map((d) => [`${d.id} ${d.title}`]),
    });
  }

  const tasks = data.tasks;
  blocks.push({ kind: 'heading', text: 'Запити QA' });
  blocks.push({
    kind: 'metrics',
    rows: [
      ['Створено', String(tasks.created)],
      ['Виконано', String(tasks.done)],
      ['Відкрито зараз', String(tasks.open)],
    ],
  });
  if (tasks.oldest.length > 0) {
    blocks.push({ kind: 'para', parts: [{ bold: 'Найстаріші:' }] });
    blocks.push({
      kind: 'list',
      items: [...tasks.oldest]
        .sort((a, b) => b.ageDays - a.ageDays || compareText(a.id, b.id))
        .map((t) => [`${t.id} ${t.title} — ${plural(t.ageDays, 'день', 'дні', 'днів')}`]),
    });
  }

  const flaky = data.flaky;
  blocks.push({ kind: 'heading', text: 'Флейки' });
  blocks.push({
    kind: 'metrics',
    rows: [
      ['Нестабільних тестів', String(flaky.count)],
      ['У карантині', String(flaky.quarantined)],
    ],
  });
  if (flaky.top.length > 0) {
    blocks.push({
      kind: 'list',
      items: [...flaky.top]
        .sort((a, b) => b.flakeScore - a.flakeScore || compareText(a.caseId, b.caseId))
        .map((f) => [`${f.caseId} ${f.title} — ${f.flakeScore.toFixed(2).replace('.', ',')}`]),
    });
  }

  blocks.push({ kind: 'heading', text: 'Зміни у вимогах і макетах' });
  blocks.push({
    kind: 'metrics',
    rows: [
      ['Змінених вимог', String(data.changes.requirements)],
      ['Змінених макетів', String(data.changes.designs)],
    ],
  });

  const insights = data.insights?.trim();
  if (insights) {
    blocks.push({ kind: 'heading', text: 'Висновки' });
    blocks.push({ kind: 'quote', text: insights });
  }

  if (data.dashboardUrl) {
    blocks.push({ kind: 'para', parts: [{ text: 'Відкрити дашборд Jules', url: data.dashboardUrl }] });
  }
  return blocks;
}

/* ───────────────────────────── Jira wiki ─────────────────────────────── */

/**
 * Екранування вікі-розмітки Jira: `* _ + ^ ~ { } [ ] | ! #` мають значення будь-де,
 * `-` — лише на межі слова (закреслення `-так-`), `??` — цитата.
 * `\` не чіпаємо: подвійний `\\` у Jira — це примусовий перенос рядка.
 */
export function escapeWiki(text: string): string {
  return inline(text)
    .replace(/([*_+^~{}[\]|!#])/g, '\\$1')
    .replace(/(^|\s)-/g, '$1\\-')
    .replace(/-(\s|$)/g, '\\-$1')
    .replace(/\?\?/g, '\\?\\?');
}

function wikiUrl(url: string): string {
  return url.replace(/[|\]\s]/g, (ch) => encodeURIComponent(ch));
}

function wikiInline(parts: Inline[]): string {
  return parts
    .map((p) => {
      if (typeof p === 'string') return escapeWiki(p);
      if ('bold' in p) return `*${escapeWiki(p.bold)}*`;
      return `[${escapeWiki(p.text)}|${wikiUrl(p.url)}]`;
    })
    .join('');
}

function renderWiki(title: string, blocks: Block[]): string {
  const out: string[] = [`h2. ${escapeWiki(title)}`, ''];
  for (const block of blocks) {
    switch (block.kind) {
      case 'heading':
        out.push(`h3. ${escapeWiki(block.text)}`);
        break;
      case 'para':
        out.push(wikiInline(block.parts), '');
        break;
      case 'list':
        out.push(...block.items.map((item) => `* ${wikiInline(item)}`), '');
        break;
      case 'metrics':
        out.push('||Показник||Значення||');
        out.push(...block.rows.map(([k, v]) => `|${escapeWiki(k)}|${escapeWiki(v)}|`), '');
        break;
      case 'table':
        out.push(`||${block.header.map(escapeWiki).join('||')}||`);
        out.push(...block.rows.map((row) => `|${row.map((c) => escapeWiki(c) || ' ').join('|')}|`), '');
        break;
      case 'quote': {
        // Висновки агента — вільний текст; пункти «- …» перетворюємо на вікі-список.
        const lines = block.text.split(/\r?\n/).map((line) => {
          const item = /^\s*[-*•]\s+(.*)$/.exec(line);
          return item ? `* ${escapeWiki(item[1])}` : escapeWiki(line);
        });
        out.push('{quote}', ...lines, '{quote}', '');
        break;
      }
    }
  }
  while (out[out.length - 1] === '') out.pop();
  return `${out.join('\n')}\n`;
}

/* ───────────────────────────── markdown ──────────────────────────────── */

function escapeMd(text: string): string {
  return inline(text).replace(/([\\*_[\]`])/g, '\\$1');
}

function mdInline(parts: Inline[]): string {
  return parts
    .map((p) => {
      if (typeof p === 'string') return escapeMd(p);
      if ('bold' in p) return `**${escapeMd(p.bold)}**`;
      return `[${escapeMd(p.text)}](${p.url.replace(/[()\s]/g, (ch) => encodeURIComponent(ch))})`;
    })
    .join('');
}

function renderMarkdown(title: string, blocks: Block[]): string {
  const out: string[] = [`## ${escapeMd(title)}`, ''];
  for (const block of blocks) {
    switch (block.kind) {
      case 'heading':
        out.push(`### ${escapeMd(block.text)}`);
        break;
      case 'para':
        out.push(mdInline(block.parts), '');
        break;
      case 'list':
        out.push(...block.items.map((item) => `- ${mdInline(item)}`), '');
        break;
      case 'metrics':
        out.push(...block.rows.map(([k, v]) => `- ${escapeMd(k)}: **${escapeMd(v)}**`), '');
        break;
      case 'table':
        out.push(...block.rows.map((row) => `- ${row.map(escapeMd).filter(Boolean).join(' · ')}`), '');
        break;
      case 'quote':
        // Текст агента вже в markdown — лишаємо його розмітку як є.
        out.push(...block.text.split(/\r?\n/).map((line) => (line.trim() ? `> ${line.trimEnd()}` : '>')), '');
        break;
    }
  }
  while (out[out.length - 1] === '') out.pop();
  return `${out.join('\n')}\n`;
}

/* ───────────────────────────── вхідна точка ──────────────────────────── */

/** Будує тижневий звіт: заголовок задачі, вікі-опис для Jira, markdown і мітку тижня. */
export function buildWeeklyReport(data: WeeklyReportData): WeeklyReport {
  const summary = `QA: тижневий звіт ${inline(data.projectName)} ${data.weekLabel}`;
  const blocks = buildBlocks(data);
  return {
    summary,
    label: `jules-weekly-${data.weekLabel}`,
    wikiMarkup: renderWiki(summary, blocks),
    markdown: renderMarkdown(summary, blocks),
  };
}
