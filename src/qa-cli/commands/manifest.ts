/**
 * `jules-qa manifest [--check]` — `qa/manifest.json` зі звітів раннерів: тест ↔ кейс ↔ рівень ↔ файл.
 *
 * Маніфест комітиться разом із тестами; `--check` (для pre-commit і CI) лише порівнює і
 * повертає 1, якщо файл застарів.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildManifest, diffManifest, serializeManifest, type LevelConfig, type Manifest } from '../../ingest/index.js';
import { loadConfig, CONFIG_PATH } from '../config.js';
import { eprintln, println, type CliContext } from '../context.js';
import { collectTestResults } from '../reports.js';
import { flagBool, type CommandHandler } from './common.js';

export const MANIFEST_PATH = 'qa/manifest.json';

export interface ManifestOutcome {
  manifest: Manifest;
  content: string;
  reportFiles: string[];
  warnings: string[];
}

export function buildRepoManifest(root: string, patterns: readonly string[], levels?: LevelConfig): ManifestOutcome {
  const reports = collectTestResults(root, patterns);
  const manifest = buildManifest(reports.results, levels);
  return {
    manifest,
    content: serializeManifest(manifest),
    reportFiles: reports.files,
    warnings: reports.warnings.map((w) => `${w.file}: ${w.message}`),
  };
}

function readManifest(file: string): Manifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Manifest;
    return parsed && Array.isArray(parsed.tests) ? parsed : null;
  } catch {
    return null;
  }
}

export const manifestCommand: CommandHandler = async (ctx: CliContext, args) => {
  const config = loadConfig({ cwd: ctx.cwd, env: ctx.env });
  if (!config.reports.tests.length) {
    eprintln(ctx, `У ${CONFIG_PATH} не задано reports.tests — звідки брати звіти тестів.`);
    return 1;
  }
  const outcome = buildRepoManifest(config.root, config.reports.tests, { levels: config.levels });
  for (const warning of outcome.warnings) eprintln(ctx, `Попередження: ${warning}`);
  if (!outcome.reportFiles.length) {
    eprintln(ctx, `Звітів тестів не знайдено за шаблонами ${config.reports.tests.join(', ')}. Спершу запустіть тести.`);
    return 1;
  }

  const file = path.join(config.root, MANIFEST_PATH);
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
  const check = flagBool(args, 'check');

  if (current === outcome.content) {
    println(ctx, `${MANIFEST_PATH} актуальний (${outcome.manifest.tests.length} тестів).`);
    return 0;
  }

  const before = (current && readManifest(file)) || { version: 1 as const, tests: [] };
  const diff = diffManifest(before, outcome.manifest);
  const summary = `+${diff.added.length} −${diff.removed.length} ~${diff.changed.length}`;

  if (check) {
    eprintln(ctx, `${MANIFEST_PATH} застарів (${summary}). Оновіть: node qa/bin/jules-qa.mjs manifest`);
    for (const t of diff.added.slice(0, 10)) eprintln(ctx, `  + ${t.file} › ${t.fullName}`);
    for (const t of diff.removed.slice(0, 10)) eprintln(ctx, `  − ${t.file} › ${t.fullName}`);
    for (const t of diff.changed.slice(0, 10)) eprintln(ctx, `  ~ ${t.file} › ${t.fullName}`);
    return 1;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, outcome.content, 'utf-8');
  println(ctx, `${MANIFEST_PATH} оновлено: ${outcome.manifest.tests.length} тестів (${summary}).`);
  const withoutCase = outcome.manifest.tests.filter((t) => !t.caseIds.length).length;
  if (withoutCase) println(ctx, `Без ID кейса: ${withoutCase}. Зарезервуйте ID: jules-qa case reserve --section <код> --title "…"`);
  return 0;
};
