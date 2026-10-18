/**
 * Пошук ослаблених перевірок у PR: які НАЯВНІ асерти в тест-файлах видалено
 * або змінено. Це сигнал для ревʼю — агенту розробника міняти асерти можна
 * лише в задачі `change_test`.
 *
 * Розбираємо unified diff (`git diff`): нові файли (`--- /dev/null`) і додані
 * рядки самі по собі не рахуються — новий тест нічого не послаблює. Видалений
 * рядок-перевірка, за яким у тому ж ханку йде доданий схожий, — `modified`.
 */
import { matchAnyGlob, normalizePath } from './glob.js';
import type { AssertionChange } from './types.js';

export const DEFAULT_TEST_FILE_GLOBS: readonly string[] = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/test_*.py',
  '**/*_test.py',
  'tests/**',
  'e2e/**',
];

const ASSERTION_RE = /\bexpect\s*\(|\bassert|(?:^|[.\s(])should\s*[.(]|\.should\b|\.toBe|\.toEqual|\.toHave|self\.assert/;
const COMMENT_RE = /^(?:\/\/|#|\/\*|\*)/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function isAssertion(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && !COMMENT_RE.test(trimmed) && ASSERTION_RE.test(trimmed);
}

/** Для порівняння «це той самий рядок»: без пробілів і хвостових `;`/`,`. */
function canonical(line: string): string {
  return line.replace(/\s+/g, '').replace(/[;,]+$/, '');
}

/** Предмет перевірки: `expect(total)` / `assert total` / `self.assertEqual(total`. */
function subject(line: string): string | undefined {
  const trimmed = line.trim();
  const expectMatch = /\bexpect\s*\(([^)]*)\)/.exec(trimmed);
  if (expectMatch) return expectMatch[1]!.replace(/\s+/g, '');
  const selfMatch = /self\.assert\w*\s*\(\s*([^,)]+)/.exec(trimmed);
  if (selfMatch) return selfMatch[1]!.replace(/\s+/g, '');
  const assertMatch = /^assert\s+([^=<>!,]+?)(?:\s*(?:==|!=|<=|>=|<|>|\bis\b|\bin\b|,)|$)/.exec(trimmed);
  if (assertMatch) return assertMatch[1]!.replace(/\s+/g, '');
  return undefined;
}

function tokens(line: string): Set<string> {
  return new Set(line.split(/[^A-Za-z0-9_$]+/).filter((token) => token.length > 0));
}

function similar(removed: string, added: string): boolean {
  const left = subject(removed);
  const right = subject(added);
  if (left !== undefined && left === right) return true;
  const a = tokens(removed);
  const b = tokens(added);
  if (a.size === 0 || b.size === 0) return false;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return common / new Set([...a, ...b]).size >= 0.5;
}

interface HunkLine {
  kind: '-' | '+';
  text: string;
  oldLine: number;
}

function analyzeHunk(file: string, lines: HunkLine[], out: AssertionChange[]): void {
  const usedAdded = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind !== '-' || !isAssertion(line.text)) return;
    let pairedIndex = -1;
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next]!;
      if (candidate.kind !== '+' || usedAdded.has(next) || !isAssertion(candidate.text)) continue;
      if (similar(line.text, candidate.text)) {
        pairedIndex = next;
        break;
      }
    }
    if (pairedIndex !== -1) {
      usedAdded.add(pairedIndex);
      const added = lines[pairedIndex]!.text;
      // Переформатування (відступ, `;`) — не зміна перевірки.
      if (canonical(added) === canonical(line.text)) return;
      out.push({ file, line: line.oldLine, before: line.text.trim(), after: added.trim(), kind: 'modified' });
      return;
    }
    out.push({ file, line: line.oldLine, before: line.text.trim(), kind: 'removed' });
  });
}

function stripPrefix(value: string, prefix: 'a/' | 'b/'): string {
  const unquoted = value.trim().replace(/^"(.*)"$/, '$1').replace(/\t.*$/, '');
  return normalizePath(unquoted.startsWith(prefix) ? unquoted.slice(2) : unquoted);
}

export function analyzeAssertionChanges(
  unifiedDiff: string,
  opts: { testFileGlobs?: string[] } = {},
): AssertionChange[] {
  if (!unifiedDiff.trim()) return [];
  const globs = opts.testFileGlobs ?? DEFAULT_TEST_FILE_GLOBS;
  const out: AssertionChange[] = [];
  const lines = unifiedDiff.split(/\r?\n/);

  let oldPath: string | undefined;
  let newPath: string | undefined;
  let isNewFile = false;
  let tracked = false;

  const startFile = () => {
    oldPath = undefined;
    newPath = undefined;
    isNewFile = false;
    tracked = false;
  };
  const decide = () => {
    // Для видаленого файлу шлях беремо зі старого боку.
    const file = newPath && newPath !== '/dev/null' ? newPath : oldPath;
    tracked = !isNewFile && file !== undefined && file !== '/dev/null' && matchAnyGlob(globs, file);
    return file;
  };

  let index = 0;
  let currentFile: string | undefined;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.startsWith('diff --git ')) {
      startFile();
      const match = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(line);
      if (match) {
        oldPath = normalizePath(match[1]!);
        newPath = normalizePath(match[2]!);
      }
      currentFile = decide();
      index += 1;
      continue;
    }
    if (line.startsWith('new file mode')) {
      isNewFile = true;
      currentFile = decide();
      index += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const value = line.slice(4);
      if (value.trim() === '/dev/null') isNewFile = true;
      else oldPath = stripPrefix(value, 'a/');
      index += 1;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const value = line.slice(4).trim();
      newPath = value === '/dev/null' ? '/dev/null' : stripPrefix(value, 'b/');
      currentFile = decide();
      index += 1;
      continue;
    }
    const hunk = HUNK_RE.exec(line);
    if (!hunk) {
      index += 1;
      continue;
    }
    // Ханк читаємо за лічильниками з заголовка: рядок «--- …» усередині ханку —
    // це видалений рядок коду, а не заголовок наступного файлу.
    let oldLine = Number(hunk[1]);
    let oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
    let newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
    const hunkLines: HunkLine[] = [];
    index += 1;
    while (index < lines.length && (oldLeft > 0 || newLeft > 0)) {
      const body = lines[index]!;
      const marker = body[0];
      if (marker === '\\') {
        index += 1;
        continue;
      }
      if (marker === '-') {
        hunkLines.push({ kind: '-', text: body.slice(1), oldLine });
        oldLine += 1;
        oldLeft -= 1;
      } else if (marker === '+') {
        hunkLines.push({ kind: '+', text: body.slice(1), oldLine });
        newLeft -= 1;
      } else if (marker === ' ' || body === '') {
        oldLine += 1;
        oldLeft -= 1;
        newLeft -= 1;
      } else {
        break;
      }
      index += 1;
    }
    if (tracked && currentFile) analyzeHunk(currentFile, hunkLines, out);
  }
  return out;
}
