/**
 * Визначення формату звіту за вмістом (з підказкою від імені файлу) і
 * єдина точка входу `parseTestReport` для звітів тестів.
 *
 * Вміст важливіший за ім'я: `report.json` може бути і Playwright, і Jest.
 * Ім'я вирішує лише тоді, коли вміст порожній або неоднозначний.
 */
import { parseJestLikeJson } from './jest-like.js';
import { parseJunitXml } from './junit.js';
import { parsePlaywrightJson } from './playwright.js';
import {
  isRecord,
  ReportParseError,
  type Framework,
  type ParsedTestResult,
  type PathOptions,
  type ReportFormat,
} from './types.js';

export interface TestReportOptions extends PathOptions {
  /** Перекриває автовизначення фреймворку для JUnit і Jest/Vitest JSON. */
  framework?: Framework;
}

function fromJson(data: unknown): ReportFormat {
  if (!isRecord(data)) return 'unknown';
  if (Array.isArray(data.suites) && isRecord(data.config)) return 'playwright-json';
  if (Array.isArray(data.testResults)) return 'jest-json';
  if (isRecord(data.files)) {
    if ('schemaVersion' in data) return 'stryker';
    const hasMutants = Object.values(data.files).some((file) => isRecord(file) && Array.isArray(file.mutants));
    if (hasMutants) return 'stryker';
  }
  return 'unknown';
}

function fromName(fileName: string): ReportFormat {
  const base = fileName.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  if (base === 'lcov.info' || base.endsWith('.lcov') || /^lcov.*\.info$/.test(base)) return 'lcov';
  if (base.endsWith('.xml')) {
    if (/cobertura|coverage/.test(base)) return 'cobertura';
    if (/junit|test|result|report/.test(base)) return 'junit';
  }
  if (base.endsWith('.json')) {
    if (/mutation|stryker/.test(base)) return 'stryker';
    if (/playwright/.test(base)) return 'playwright-json';
    if (/jest|vitest/.test(base)) return 'jest-json';
  }
  return 'unknown';
}

export function detectReportFormat(fileName: string, content: string): ReportFormat {
  const text = content.replace(/^﻿/, '').trimStart();
  if (text.startsWith('<')) {
    // Дивимось на перший справжній елемент, а не на будь-яку згадку в тексті.
    const head = text.replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>/g, '').trimStart();
    if (/^<testsuites?[\s>/]/.test(head)) return 'junit';
    if (/^<coverage[\s>/]/.test(head)) return 'cobertura';
    if (/<testsuites?[\s>/]/.test(text)) return 'junit';
    if (/<coverage[\s>/]/.test(text)) return 'cobertura';
    return fromName(fileName);
  }
  if (text.startsWith('{')) {
    try {
      const format = fromJson(JSON.parse(text));
      return format === 'unknown' ? fromName(fileName) : format;
    } catch {
      // Обрізаний JSON — формат вгадуємо за іменем, щоб парсер дав зрозумілу помилку.
      return fromName(fileName);
    }
  }
  if (/^SF:/m.test(text)) return 'lcov';
  return fromName(fileName);
}

/** junit | playwright-json | jest-json (vitest json — jest-сумісний). */
export function parseTestReport(
  fileName: string,
  content: string,
  options: TestReportOptions = {},
): ParsedTestResult[] {
  if (!content.trim()) return [];
  const format = detectReportFormat(fileName, content);
  switch (format) {
    case 'junit':
      return parseJunitXml(content, options);
    case 'playwright-json':
      return parsePlaywrightJson(content, { rootDir: options.rootDir });
    case 'jest-json': {
      const framework = options.framework === 'jest' || options.framework === 'vitest' ? options.framework : undefined;
      return parseJestLikeJson(content, { rootDir: options.rootDir, framework });
    }
    default:
      break;
  }
  const what = format === 'unknown' ? 'формат не розпізнано' : `це звіт «${format}», а не тестів`;
  throw new ReportParseError(
    format,
    `Звіт тестів «${fileName}»: ${what}. Підтримуються JUnit XML, Playwright JSON, Jest/Vitest JSON.`,
  );
}
