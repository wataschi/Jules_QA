/**
 * Інжест звітів CI: спільні типи й дрібні помічники парсерів.
 *
 * Модуль `src/ingest/` — чисті функції без бази й мережі: на вході текст
 * звіту раннера (JUnit, Playwright JSON, Jest/Vitest JSON, LCOV, Cobertura,
 * Stryker), на виході — нормалізовані записи для `POST /ingest/run` і
 * `qa/manifest.json`. Той самий код збирається в CLI `jules-qa`, тому тут
 * немає залежностей поза `node:` і власним XML-парсером.
 */
import { parseXml, type XmlNode } from '../integrations/testrail-xml.js';

export type TestLevel = 'unit' | 'integration' | 'e2e' | 'visual';
export type Framework = 'junit' | 'playwright' | 'vitest' | 'jest' | 'pytest' | 'unknown';

export interface ParsedTestResult {
  /** Шлях відносно кореня репо, з '/'. */
  file: string;
  /** Назва тесту (останній сегмент). */
  name: string;
  /** describe > … > name */
  fullName: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs?: number;
  /** Перші ~2000 символів. */
  error?: string;
  /** >0 і passed → флейк. */
  retries?: number;
  framework: Framework;
}

export type ReportFormat =
  | 'junit'
  | 'playwright-json'
  | 'jest-json'
  | 'lcov'
  | 'cobertura'
  | 'stryker'
  | 'unknown';

export interface FileCoverage {
  path: string;
  linesFound: number;
  linesHit: number;
  branchesFound?: number;
  branchesHit?: number;
}

export interface MutationFile {
  path: string;
  killed: number;
  survived: number;
  noCoverage: number;
  timeout: number;
  total: number;
  score: number | null;
}

export interface LevelConfig {
  levels?: Partial<Record<TestLevel, string[]>>;
}

export interface ManifestTest {
  key: string;
  file: string;
  name: string;
  fullName: string;
  caseIds: string[];
  level: TestLevel;
  framework: Framework;
}

export interface Manifest {
  version: 1;
  tests: ManifestTest[];
}

export interface AssertionChange {
  file: string;
  line: number;
  before: string;
  after?: string;
  kind: 'removed' | 'modified';
}

export interface CodeownersRule {
  pattern: string;
  owners: string[];
}

/** Опції парсерів, де шляхи у звіті можуть бути абсолютними. */
export interface PathOptions {
  /** Корінь репо, від якого рахуються відносні шляхи. Дефолт — `process.cwd()`. */
  rootDir?: string;
}

/** Помилка розбору звіту: зламаний XML/JSON або чужий формат. */
export class ReportParseError extends Error {
  readonly format: ReportFormat;

  constructor(format: ReportFormat, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'ReportParseError';
    this.format = format;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export const ERROR_LIMIT = 2000;

const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** Прибирає ANSI-кольори раннерів і обрізає текст помилки до ~2000 символів. */
export function cleanError(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const text = raw.replace(ANSI_RE, '').trim();
  if (!text) return undefined;
  return text.length > ERROR_LIMIT ? `${text.slice(0, ERROR_LIMIT - 1)}…` : text;
}

/** JSON.parse з людською помилкою; повертає `undefined` для порожнього входу. */
export function parseJsonReport(content: string, format: ReportFormat, label: string): unknown {
  if (!content.trim()) return undefined;
  try {
    return JSON.parse(content.replace(/^﻿/, ''));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ReportParseError(format, `${label}: не вдалося розібрати JSON — ${reason}`, {
      cause: error,
    });
  }
}

const XML_TOKEN_RE =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/?[^\s<>"'\/!?][^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>/g;

/**
 * `parseXml` толерантний (сам закриває теги), а обрізаний звіт CI має падати
 * явно — інакше частина тестів мовчки зникне. Тому спершу перевіряємо баланс.
 * Заодно екрануємо `>` усередині атрибутів (`message="expected 2 > 1"` — це
 * валідний XML), бо токенайзер `parseXml` вважає його кінцем тегу.
 */
export function parseXmlReport(content: string, format: ReportFormat, label: string): XmlNode | undefined {
  if (!content.trim()) return undefined;
  const xml = content.replace(/^\uFEFF/, '');
  const stack: string[] = [];
  const pieces: string[] = [];
  let elements = 0;
  let lastIndex = 0;
  let token: RegExpExecArray | null;
  const fail = (reason: string): never => {
    throw new ReportParseError(format, `${label}: зламаний XML — ${reason}`);
  };
  const regex = new RegExp(XML_TOKEN_RE.source, 'g');
  while ((token = regex.exec(xml)) !== null) {
    const between = xml.slice(lastIndex, token.index);
    if (between.includes('<')) fail('незакритий або некоректний тег');
    pieces.push(between);
    lastIndex = token.index + token[0].length;
    const raw = token[0];
    if (raw.startsWith('<!') || raw.startsWith('<?')) {
      pieces.push(raw);
      continue;
    }
    if (raw.startsWith('</')) {
      const name = raw.slice(2, -1).trim();
      const open = stack.pop();
      if (open !== name) fail(`очікувався </${open ?? '…'}>, а знайдено </${name}>`);
      pieces.push(raw);
      continue;
    }
    const name = raw.slice(1).match(/^([^\s/>]+)/)![1]!;
    elements += 1;
    if (!raw.endsWith('/>')) stack.push(name);
    pieces.push(raw.replace(/"[^"]*"|'[^']*'/g, (quoted) => quoted.replace(/>/g, '&gt;')));
  }
  const tail = xml.slice(lastIndex);
  if (tail.includes('<')) fail('незакритий тег наприкінці файлу');
  if (stack.length > 0) fail(`не закрито <${stack[stack.length - 1]}>`);
  if (elements === 0) fail('не знайдено жодного елемента');
  pieces.push(tail);
  return parseXml(pieces.join(''));
}

export type { XmlNode };

/** Усі нащадки з такою назвою (без урахування регістру), у порядку документа. */
export function findAll(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const item of node.children) {
    if (item.name.toLowerCase() === name) out.push(item);
    findAll(item, name, out);
  }
  return out;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Порівняння без локалі: порядок у маніфесті не має залежати від машини. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
