/**
 * Покриття коду: LCOV (`lcov.info`) і Cobertura XML → `FileCoverage[]`.
 *
 * Один файл може трапитися в звіті кілька разів (кілька прогонів, злиті
 * звіти, кілька класів Cobertura в одному файлі), тому рахуємо по рядках:
 * рядок покритий, якщо хоч один запис дав йому hits > 0. Результат
 * відсортовано за шляхом — щоб диф між прогонами був читабельним.
 */
import path from 'node:path';
import { isAbsolutePath, normalizePath, relativeTo, toRepoPath } from './glob.js';
import {
  compareStrings,
  findAll,
  parseXmlReport,
  ReportParseError,
  type FileCoverage,
  type PathOptions,
} from './types.js';

interface Accumulator {
  lines: Map<number, number>;
  branches: Map<string, number>;
  /** Підсумки LF/LH/BRF/BRH для записів без деталізації по рядках. */
  totals?: { lf: number; lh: number; brf?: number; brh?: number };
}

function accumulator(map: Map<string, Accumulator>, filePath: string): Accumulator {
  let acc = map.get(filePath);
  if (!acc) {
    acc = { lines: new Map(), branches: new Map() };
    map.set(filePath, acc);
  }
  return acc;
}

function addHits<K>(map: Map<K, number>, key: K, hits: number): void {
  map.set(key, (map.get(key) ?? 0) + (Number.isFinite(hits) && hits > 0 ? hits : 0));
}

function toCoverage(map: Map<string, Accumulator>): FileCoverage[] {
  const out: FileCoverage[] = [];
  for (const [filePath, acc] of map) {
    const item: FileCoverage = { path: filePath, linesFound: 0, linesHit: 0 };
    if (acc.lines.size > 0) {
      item.linesFound = acc.lines.size;
      item.linesHit = [...acc.lines.values()].filter((hits) => hits > 0).length;
    } else if (acc.totals) {
      item.linesFound = acc.totals.lf;
      item.linesHit = acc.totals.lh;
    }
    if (acc.branches.size > 0) {
      item.branchesFound = acc.branches.size;
      item.branchesHit = [...acc.branches.values()].filter((hits) => hits > 0).length;
    } else if (acc.totals?.brf !== undefined) {
      item.branchesFound = acc.totals.brf;
      item.branchesHit = acc.totals.brh ?? 0;
    }
    out.push(item);
  }
  return out.sort((a, b) => compareStrings(a.path, b.path));
}

/* ─────────────────────────────── LCOV ─────────────────────────────── */

export function parseLcov(content: string, options: PathOptions = {}): FileCoverage[] {
  if (!content.trim()) return [];
  const rootDir = options.rootDir ?? process.cwd();
  const files = new Map<string, Accumulator>();
  let current: Accumulator | undefined;
  let totals: { lf?: number; lh?: number; brf?: number; brh?: number } = {};
  let sawRecord = false;

  // Підсумки LF/LH/BRF/BRH — запасний варіант для записів без DA/BRDA. Для
  // дубля файлу без деталізації точніше за максимум не порахуєш.
  const finish = () => {
    if (current && (totals.lf !== undefined || totals.brf !== undefined)) {
      const previous = current.totals;
      const next: NonNullable<Accumulator['totals']> = {
        lf: Math.max(previous?.lf ?? 0, totals.lf ?? 0),
        lh: Math.max(previous?.lh ?? 0, totals.lh ?? 0),
      };
      if (totals.brf !== undefined || previous?.brf !== undefined) {
        next.brf = Math.max(previous?.brf ?? 0, totals.brf ?? 0);
        next.brh = Math.max(previous?.brh ?? 0, totals.brh ?? 0);
      }
      current.totals = next;
    }
    current = undefined;
    totals = {};
  };

  for (const rawLine of content.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === 'end_of_record') {
      finish();
      continue;
    }
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const tag = line.slice(0, colon);
    const value = line.slice(colon + 1);
    if (tag === 'SF') {
      finish();
      sawRecord = true;
      current = accumulator(files, toRepoPath(value, rootDir));
      continue;
    }
    if (!current) continue;
    switch (tag) {
      case 'DA': {
        const [lineNo, hits] = value.split(',');
        const number = Number(lineNo);
        if (Number.isInteger(number)) addHits(current.lines, number, Number(hits));
        break;
      }
      case 'BRDA': {
        const [lineNo, block, branch, taken] = value.split(',');
        addHits(current.branches, `${lineNo}:${block}:${branch}`, taken === '-' ? 0 : Number(taken));
        break;
      }
      case 'LF':
        totals.lf = Number(value) || 0;
        break;
      case 'LH':
        totals.lh = Number(value) || 0;
        break;
      case 'BRF':
        totals.brf = Number(value) || 0;
        break;
      case 'BRH':
        totals.brh = Number(value) || 0;
        break;
      default:
        break;
    }
  }
  finish();
  if (!sawRecord) {
    throw new ReportParseError('lcov', 'LCOV: не знайдено жодного запису «SF:» — це не lcov.info');
  }
  return toCoverage(files);
}

/* ───────────────────────────── Cobertura ──────────────────────────── */

const CONDITION_RE = /\((\d+)\s*\/\s*(\d+)\)/;

function coberturaPath(filename: string, sources: string[], rootDir: string): string {
  const file = normalizePath(filename);
  if (isAbsolutePath(file)) return toRepoPath(file, rootDir);
  // Istanbul кладе в <source> корінь репо, coverage.py — каталог пакета (`/repo/src`).
  for (const source of sources) {
    const joined = isAbsolutePath(source) ? path.posix.join(source, file) : normalizePath(path.posix.join(source, file));
    const relative = isAbsolutePath(joined) ? relativeTo(joined, rootDir) : joined;
    if (relative) return relative;
  }
  return file;
}

export function parseCobertura(content: string, options: PathOptions = {}): FileCoverage[] {
  const root = parseXmlReport(content, 'cobertura', 'Cobertura XML');
  if (!root) return [];
  const coverage = findAll(root, 'coverage')[0];
  if (!coverage) {
    throw new ReportParseError('cobertura', 'Cobertura XML: немає кореневого <coverage>');
  }
  const rootDir = options.rootDir ?? process.cwd();
  const sources = findAll(coverage, 'source')
    .map((node) => normalizePath(node.text))
    .filter((source) => source.length > 0);
  const files = new Map<string, Accumulator>();

  for (const cls of findAll(coverage, 'class')) {
    const filename = cls.attrs.filename?.trim();
    if (!filename) continue;
    const acc = accumulator(files, coberturaPath(filename, sources, rootDir));
    // Рядки методів дублюють рядки класу — беремо лише прямий <lines> класу.
    const lines = cls.children.find((node) => node.name.toLowerCase() === 'lines');
    for (const line of lines?.children ?? []) {
      if (line.name.toLowerCase() !== 'line') continue;
      const number = Number(line.attrs.number);
      if (!Number.isInteger(number)) continue;
      addHits(acc.lines, number, Number(line.attrs.hits));
      if (line.attrs.branch === 'true') {
        const match = CONDITION_RE.exec(line.attrs['condition-coverage'] ?? '');
        if (!match) continue;
        const covered = Number(match[1]);
        const total = Number(match[2]);
        for (let index = 0; index < total; index += 1) {
          addHits(acc.branches, `${number}:${index}`, index < covered ? 1 : 0);
        }
      }
    }
  }
  return toCoverage(files);
}
