/**
 * Рендер коментаря Jules QA до PR.
 *
 * Перший рядок — маркер `<!-- jules-qa -->`: за ним CI знаходить свій попередній
 * коментар і редагує його замість того, щоб додавати новий на кожен пуш.
 *
 * Зміни наявних асертів винесено в окремий помітний розділ одразу після підсумку:
 * це єдиний пункт, який вимагає дії QA до merge (мітка `qa:assertion-change`),
 * і він не повинен загубитися серед списків тестів.
 *
 * Функція чиста й детермінована: однакові дані → однаковий текст.
 */

export interface PrCommentData {
  projectName: string;
  prNumber: number;
  sha: string;
  touchedCases: Array<{
    caseId: string;
    title: string;
    status: 'passed' | 'failed' | 'skipped' | 'untested';
  }>;
  newTests: Array<{ file: string; name: string; caseIds: string[] }>;
  failed: Array<{ file: string; name: string; caseIds: string[]; error?: string }>;
  testsWithoutCase: Array<{ file: string; name: string }>;
  assertionChanges: Array<{
    file: string;
    line: number;
    before: string;
    after?: string;
    kind: 'removed' | 'modified';
  }>;
  coverage?: { linesFound: number; linesHit: number } | null;
  dashboardUrl?: string;
}

export const PR_COMMENT_MARKER = '<!-- jules-qa -->';
export const ASSERTION_CHANGE_LABEL = 'qa:assertion-change';

const LIST_LIMIT = 20;
const ERROR_LIMIT = 300;

const COLLATOR = new Intl.Collator('uk', { numeric: true, sensitivity: 'variant' });

function compareText(a: string, b: string): number {
  return COLLATOR.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

function inline(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Inline-код, що витримує бектики всередині: огорожа довша за найдовший їхній ряд. */
function code(text: string): string {
  const value = inline(text);
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const padded = value.startsWith('`') || value.endsWith('`') ? ` ${value} ` : value;
  return `${fence}${padded}${fence}`;
}

/**
 * Текст помилки в блоці коду: обрізаємо, а ``` розбиваємо невидимим пробілом,
 * щоб тест, який друкує markdown, не закрив наш блок і не зламав увесь коментар.
 */
function errorBlock(error: string): string[] {
  const trimmed = error.trim();
  const short = trimmed.length > ERROR_LIMIT ? `${trimmed.slice(0, ERROR_LIMIT).trimEnd()}…` : trimmed;
  const safe = short.replace(/`{3,}/g, (run) => run.split('').join('​'));
  return ['  ```', ...safe.split(/\r?\n/).map((line) => `  ${line}`.trimEnd()), '  ```'];
}

/** Обрізає список до 20 пунктів і додає «…і ще N». */
function limited<T>(items: T[], render: (item: T) => string[]): string[] {
  const out = items.slice(0, LIST_LIMIT).flatMap(render);
  if (items.length > LIST_LIMIT) out.push(`- …і ще ${items.length - LIST_LIMIT}`);
  return out;
}

function caseList(ids: string[]): string {
  return [...new Set(ids)].sort(compareText).join(', ');
}

const CASE_STATUS: Record<PrCommentData['touchedCases'][number]['status'], string> = {
  passed: '✅',
  failed: '❌',
  skipped: '⏭️',
  untested: '⚪',
};

function coverageLine(coverage: PrCommentData['coverage']): string | null {
  if (!coverage) return null;
  if (coverage.linesFound <= 0) return 'Покриття змінених рядків: —';
  const pct = Math.round((coverage.linesHit / coverage.linesFound) * 100);
  return `Покриття змінених рядків: ${pct}% (${coverage.linesHit} з ${coverage.linesFound})`;
}

function summaryLine(data: PrCommentData): string {
  const counters = [
    `зачеплено кейсів: ${data.touchedCases.length}`,
    `нових тестів: ${data.newTests.length}`,
  ];
  if (data.failed.length > 0) {
    return `❌ **Впало тестів: ${data.failed.length}** · ${counters.join(' · ')}`;
  }
  const warnings: string[] = [];
  if (data.assertionChanges.length > 0) warnings.push(`змінено перевірок: ${data.assertionChanges.length}`);
  if (data.testsWithoutCase.length > 0) warnings.push(`тестів без кейса: ${data.testsWithoutCase.length}`);
  const untested = data.touchedCases.filter((c) => c.status === 'untested').length;
  if (untested > 0) warnings.push(`кейсів без тесту: ${untested}`);
  if (warnings.length > 0) {
    return `⚠️ **Тести зелені, але є що перевірити** · ${[...warnings, ...counters].join(' · ')}`;
  }
  return `✅ **Усі тести пройшли** · ${counters.join(' · ')}`;
}

/** Рендерить коментар до PR. Перший рядок — рівно `<!-- jules-qa -->`. */
export function renderPrComment(data: PrCommentData): string {
  const lines: string[] = [PR_COMMENT_MARKER];
  lines.push(
    `### Jules QA · ${inline(data.projectName)} · PR #${data.prNumber} @ ${data.sha.slice(0, 7)}`,
    '',
    summaryLine(data),
  );
  const coverage = coverageLine(data.coverage);
  if (coverage) lines.push('', coverage);
  lines.push('');

  if (data.assertionChanges.length > 0) {
    const sorted = [...data.assertionChanges].sort(
      (a, b) => compareText(a.file, b.file) || a.line - b.line,
    );
    lines.push(
      '#### ⚠️ Змінено наявні перевірки — потрібне погодження QA',
      '',
      `> [!WARNING]`,
      `> PR змінює або видаляє асерти в наявних тестах. Позначте його міткою \`${ASSERTION_CHANGE_LABEL}\`: ` +
        'merge — лише після підтвердження QA, що зміна навмисна.',
      '',
      ...limited(sorted, (c) => [
        c.kind === 'removed' || c.after === undefined
          ? `- ${code(`${c.file}:${c.line}`)} видалено: ${code(c.before)}`
          : `- ${code(`${c.file}:${c.line}`)} змінено: ${code(c.before)} → ${code(c.after)}`,
      ]),
      '',
    );
  }

  if (data.failed.length > 0) {
    const sorted = [...data.failed].sort(
      (a, b) => compareText(a.file, b.file) || compareText(a.name, b.name),
    );
    lines.push(
      '#### Впали',
      ...limited(sorted, (f) => {
        const ids = caseList(f.caseIds);
        const head = `- **${inline(f.name)}** · ${code(f.file)}${ids ? ` · ${ids}` : ''}`;
        return f.error?.trim() ? [head, ...errorBlock(f.error)] : [head];
      }),
      '',
    );
  }

  if (data.touchedCases.length > 0) {
    const sorted = [...data.touchedCases].sort((a, b) => compareText(a.caseId, b.caseId));
    lines.push(
      '#### Зачеплені кейси',
      ...limited(sorted, (c) => [
        `- ${CASE_STATUS[c.status]} ${inline(c.caseId)} ${inline(c.title)}${c.status === 'untested' ? ' · без тесту' : ''}`,
      ]),
      '',
    );
  }

  if (data.newTests.length > 0) {
    const sorted = [...data.newTests].sort(
      (a, b) => compareText(a.file, b.file) || compareText(a.name, b.name),
    );
    lines.push(
      '#### Нові тести',
      ...limited(sorted, (t) => {
        const ids = caseList(t.caseIds);
        return [`- ${code(t.file)} › ${inline(t.name)}${ids ? ` · ${ids}` : ''}`];
      }),
      '',
    );
  }

  if (data.testsWithoutCase.length > 0) {
    const sorted = [...data.testsWithoutCase].sort(
      (a, b) => compareText(a.file, b.file) || compareText(a.name, b.name),
    );
    lines.push(
      '#### Тести без кейса',
      'Додайте ID кейса в назву тесту або зарезервуйте новий: `jules-qa case reserve`.',
      ...limited(sorted, (t) => [`- ${code(t.file)} › ${inline(t.name)}`]),
      '',
    );
  }

  const nothing =
    data.touchedCases.length === 0 &&
    data.newTests.length === 0 &&
    data.failed.length === 0 &&
    data.testsWithoutCase.length === 0 &&
    data.assertionChanges.length === 0;
  if (nothing) lines.push('Цей PR не зачепив тестів і кейсів.', '');

  if (data.dashboardUrl) lines.push(`[Відкрити в Jules](${data.dashboardUrl})`, '');

  while (lines[lines.length - 1] === '') lines.pop();
  return `${lines.join('\n')}\n`;
}
