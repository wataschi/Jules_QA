/**
 * CODEOWNERS: розбір і пошук власників файлу за правилами GitHub.
 *
 * Потрібен, щоб задачі на тести (`add_test`, `triage`) падали на команду, що
 * володіє кодом. Семантика шаблонів — як у GitHub (gitignore-подібна):
 *  - `/docs/` — від кореня репо; шаблон зі слешем усередині (`apps/web/*`) теж
 *    прив'язаний до кореня;
 *  - `*.js`, `apps/` — без слеша на початку/всередині: будь-де в дереві;
 *  - `dir/` — каталог з усім вмістом; `docs` — і файл, і каталог;
 *  - `docs/*` — лише файли безпосередньо в `docs/` (GitHub явно так пише);
 *  - останнє збігле правило перемагає; правило без власників знімає власність.
 */
import { matchGlob, normalizePath } from './glob.js';
import type { CodeownersRule } from './types.js';

export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const rawLine of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    // Секції GitLab (`[Docs]`, `^[Docs]`) GitHub не знає — пропускаємо, щоб не
    // прийняти назву секції за шаблон.
    if (/^\^?\[[^\]]*\]/.test(line)) continue;
    const parts = line.split(/\s+/);
    const pattern = parts[0]!.replace(/^\\#/, '#');
    const owners: string[] = [];
    for (const part of parts.slice(1)) {
      if (part.startsWith('#')) break;
      owners.push(part);
    }
    rules.push({ pattern, owners });
  }
  return rules;
}

const compiled = new Map<string, string[]>();

/** Шаблон CODEOWNERS → набір glob-ів для `matchGlob`. */
function toGlobs(pattern: string): string[] {
  const cached = compiled.get(pattern);
  if (cached) return cached;
  let body = pattern.replace(/\\ /g, ' ');
  const dirOnly = body.endsWith('/');
  body = body.replace(/\/+$/, '');
  const anchored = body.startsWith('/') || body.includes('/');
  body = body.replace(/^\/+/, '');
  if (!body) {
    // `/` або `/*`-подібні вироджені випадки: усе дерево.
    const all = ['**'];
    compiled.set(pattern, all);
    return all;
  }
  const base = anchored || body.startsWith('**/') ? body : `**/${body}`;
  let globs: string[];
  if (dirOnly) globs = [`${base}/**`];
  else if (/(^|\/)\*$/.test(body) && body !== '*') globs = [base];
  else globs = [base, `${base}/**`];
  compiled.set(pattern, globs);
  return globs;
}

export function matchCodeownersPattern(pattern: string, filePath: string): boolean {
  const file = normalizePath(filePath).replace(/^\/+/, '');
  return toGlobs(pattern).some((glob) => matchGlob(glob, file));
}

/** Останнє збігле правило перемагає, як у GitHub. */
export function ownersForPath(rules: CodeownersRule[], filePath: string): string[] {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index]!;
    if (matchCodeownersPattern(rule.pattern, filePath)) return [...rule.owners];
  }
  return [];
}
