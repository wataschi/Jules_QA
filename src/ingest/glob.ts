/**
 * Glob-и й шляхи для інжесту: `matchGlob` без залежностей і нормалізація
 * шляхів зі звітів у вигляд «відносно кореня репо, через '/'».
 *
 * Підтримка: `**` (будь-яка глибина, зокрема нуль каталогів), `*` і `?`
 * (у межах одного сегмента), `[abc]`/`[!abc]`. Фігурні дужки не потрібні —
 * конфіг `qa/jules.config.json` задає списки glob-ів.
 */
import path from 'node:path';

const cache = new Map<string, RegExp>();

function escapeRegex(char: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}

function compile(pattern: string): RegExp {
  let source = '';
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index]!;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        const atSegmentStart = index === 0 || pattern[index - 1] === '/';
        if (atSegmentStart && pattern[index + 2] === '/') {
          source += '(?:[^/]*/)*';
          index += 3;
        } else {
          source += '.*';
          index += 2;
        }
        continue;
      }
      source += '[^/]*';
      index += 1;
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }
    if (char === '[') {
      const close = pattern.indexOf(']', index + 2);
      if (close !== -1) {
        let body = pattern.slice(index + 1, close);
        const negate = body.startsWith('!') || body.startsWith('^');
        if (negate) body = body.slice(1);
        source += `[${negate ? '^/' : ''}${body.replace(/\\/g, '\\\\')}]`;
        index = close + 1;
        continue;
      }
    }
    source += escapeRegex(char);
    index += 1;
  }
  // `tests/**` має збігатися і з самим каталогом `tests`.
  source = source.replace(/\/\.\*$/, '(?:/.*)?');
  return new RegExp(`^${source}$`);
}

/** Чи збігається шлях із glob-шаблоном (`**`, `*`, `?`). */
export function matchGlob(pattern: string, filePath: string): boolean {
  const normalizedPattern = normalizePath(pattern);
  let regex = cache.get(normalizedPattern);
  if (!regex) {
    regex = compile(normalizedPattern);
    cache.set(normalizedPattern, regex);
  }
  return regex.test(normalizePath(filePath));
}

export function matchAnyGlob(patterns: readonly string[], filePath: string): boolean {
  return patterns.some((pattern) => matchGlob(pattern, filePath));
}

/** `.\\src\\a.ts` → `src/a.ts`: прямі слеші, без `./`, без `a/../`. */
export function normalizePath(value: string): string {
  const slashed = value.trim().replace(/\\/g, '/');
  if (!slashed) return '';
  const normalized = path.posix.normalize(slashed);
  return normalized === '.' ? '' : normalized.replace(/^(\.\/)+/, '');
}

export function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

/** Відрізає `root` від абсолютного шляху; `undefined`, якщо шлях поза коренем. */
export function relativeTo(filePath: string, root: string): string | undefined {
  const file = normalizePath(filePath);
  const base = normalizePath(root).replace(/\/+$/, '');
  if (!base) return undefined;
  const sameCase = /^[A-Za-z]:/.test(base);
  const fileCmp = sameCase ? file.toLowerCase() : file;
  const baseCmp = sameCase ? base.toLowerCase() : base;
  if (fileCmp === baseCmp) return '';
  if (fileCmp.startsWith(`${baseCmp}/`)) return file.slice(base.length + 1);
  return undefined;
}

/**
 * Шлях зі звіту → шлях відносно кореня репо. Абсолютний шлях поза коренем
 * лишаємо як є (без провідного `/` нічого не вгадуємо): краще явно чужий
 * шлях, ніж тихо неправильний.
 */
export function toRepoPath(filePath: string, rootDir: string = process.cwd()): string {
  const normalized = normalizePath(filePath);
  if (!isAbsolutePath(normalized)) return normalized;
  return relativeTo(normalized, rootDir) ?? normalized;
}
