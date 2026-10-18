/**
 * Дрібні частини для тестів у коді: чипи рівня, автора, стану й результату,
 * посилання на файл і коміт на GitHub, завантаження всіх тестів проєкту.
 * Спільні для вкладок «Покриття» і розділу «Тести в коді» в деталях кейса.
 */
import { Fragment, type ReactNode } from 'react';
import { api } from '../../api';
import { Chip } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import type { CodeTest } from '../../types';
import { formatAgo, formatDateTime } from '../../utils/format';
import { SC } from './strings';
import '../../styles/coverage.css';

/** Сервер віддає щонайбільше 500 тестів за запит. */
const PAGE_LIMIT = 500;
/** Стеля, щоб завеликий репозиторій не перетворився на сотню запитів. */
const MAX_PAGES = 6;

export interface AllTests {
  items: CodeTest[];
  total: number;
}

/** Усі тести проєкту кількома сторінками по 500 (зазвичай — одним запитом). */
export async function loadAllTests(projectId: string, signal: AbortSignal): Promise<AllTests> {
  const first = await api.listTests({ projectId, limit: PAGE_LIMIT, page: 1 }, signal);
  const items = [...first.items];
  const pages = Math.min(MAX_PAGES, Math.ceil(first.total / Math.max(first.limit || PAGE_LIMIT, 1)));
  for (let page = 2; page <= pages; page += 1) {
    const next = await api.listTests({ projectId, limit: PAGE_LIMIT, page }, signal);
    items.push(...next.items);
    if (next.items.length === 0) break;
  }
  return { items, total: first.total };
}

/** Тести за ID кейса: один тест може реалізовувати кілька кейсів. */
export function groupByCase(tests: CodeTest[]): Map<string, CodeTest[]> {
  const map = new Map<string, CodeTest[]>();
  for (const test of tests) {
    for (const caseId of test.caseIds) {
      const bucket = map.get(caseId);
      if (bucket) bucket.push(test);
      else map.set(caseId, [test]);
    }
  }
  return map;
}

/** Вкладка «Від вимоги до результату», звужена до одного кейса. */
export const traceHref = (caseId: string) => `/coverage?tab=trace&case=${encodeURIComponent(caseId)}`;

export const isFailed = (test: CodeTest) => test.lastResult?.status === 'failed';

function pathOf(file: string): string {
  return file
    .replace(/^\.?\//, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

export function githubFileUrl(repo: string | undefined, file: string): string | undefined {
  if (!repo || !file) return undefined;
  return `https://github.com/${repo}/blob/main/${pathOf(file)}`;
}

export function githubCommitUrl(repo: string | undefined, sha: string | undefined): string | undefined {
  if (!repo || !sha) return undefined;
  return `https://github.com/${repo}/commit/${encodeURIComponent(sha)}`;
}

/**
 * Хто може класти тести в карантин: сервер пускає QA і адміністратора.
 * Якщо `/me` недоступний (старий сервер, локальний режим), кнопку
 * показуємо — остаточно вирішує сервер, а помилку покаже тост.
 */
export function useCanManageTests(): boolean {
  const me = useAsync((signal) => api.me(signal), []);
  if (!me.data) return true;
  return me.data.role === 'qa' || me.data.role === 'admin';
}

/* ───────────────────────────────── чипи ──────────────────────────────── */

export function TestLevelChip({ level }: { level: CodeTest['level'] }) {
  return (
    <Chip tone={level === 'e2e' || level === 'visual' ? 'accent' : 'neutral'} mono title={SC.levelHint[level]}>
      {SC.level[level]}
    </Chip>
  );
}

export function TestAuthorChip({ author }: { author: CodeTest['author'] }) {
  return (
    <span className={`test-author ${author}`} title={SC.authorHint[author]}>
      <span aria-hidden="true">{author === 'agent' ? '◆' : '●'}</span>
      {SC.author[author]}
    </span>
  );
}

export function TestStateChip({ state }: { state: CodeTest['state'] }) {
  const tone = state === 'quarantined' ? 'warn' : state === 'active' ? 'good' : 'neutral';
  return <Chip tone={tone}>{SC.state[state]}</Chip>;
}

export function TestResultChip({ test }: { test: CodeTest }) {
  const result = test.lastResult;
  if (!result) return <Chip>{SC.result.none}</Chip>;
  const tone = result.status === 'passed' ? 'good' : result.status === 'failed' ? 'bad' : 'neutral';
  return (
    <Chip tone={tone} title={formatDateTime(result.at)}>
      {SC.result[result.status]}
    </Chip>
  );
}

/** «3f2a91c · 2 год тому» з посиланням на коміт, коли відомий репозиторій. */
export function CommitRef({ test, repo }: { test: CodeTest; repo?: string }) {
  const result = test.lastResult;
  if (!result) return null;
  const sha = result.sha;
  const url = githubCommitUrl(repo, sha);
  return (
    <span className="text-xs muted nowrap" title={`${SC.commitTitle}: ${formatDateTime(result.at)}`}>
      {sha && url ? (
        <a href={url} target="_blank" rel="noreferrer noopener" className="mono">
          {sha.slice(0, 7)}
        </a>
      ) : sha ? (
        <span className="mono">{sha.slice(0, 7)}</span>
      ) : null}
      {sha ? ' · ' : ''}
      {formatAgo(result.at)}
    </span>
  );
}

/** Шлях із місцями переносу після «/», щоб довгий шлях не рвався посеред слова. */
function breakablePath(file: string): ReactNode {
  const parts = file.split('/');
  return parts.map((part, index) => (
    <Fragment key={index}>
      {part}
      {index < parts.length - 1 && (
        <>
          /<wbr />
        </>
      )}
    </Fragment>
  ));
}

/** Шлях до файлу; з репозиторієм — посилання на GitHub. */
export function FileLink({ file, repo }: { file: string; repo?: string }) {
  const url = githubFileUrl(repo, file);
  if (!url) return <span className="mono text-xs test-file">{breakablePath(file)}</span>;
  return (
    <a
      className="mono text-xs test-file"
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      title={SC.openFile}
    >
      {breakablePath(file)}
    </a>
  );
}
