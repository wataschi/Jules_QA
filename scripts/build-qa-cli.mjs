#!/usr/bin/env node
/**
 * Збірка CLI `jules-qa` в один самодостатній файл `dist/qa-cli/jules-qa.mjs`.
 *
 * Спершу перегенеровує `src/qa-cli/templates.ts` із файлів плагіна (`plugin/jules-qa/`) і
 * шаблону CI (`templates/github/qa-ci.yml`): бандл копіюється в репо продукту сам по собі,
 * тож шаблони для `init` мають бути всередині нього, а не поруч на диску.
 *
 *   node scripts/build-qa-cli.mjs                    — шаблони + бандл
 *   node scripts/build-qa-cli.mjs --check-templates  — exit 1, якщо templates.ts застарів
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_DIR = path.join(ROOT, 'plugin/jules-qa');
const TEMPLATES_TS = path.join(ROOT, 'src/qa-cli/templates.ts');
const ENTRY = path.join(ROOT, 'src/qa-cli/main.ts');
const OUTFILE = path.join(ROOT, 'dist/qa-cli/jules-qa.mjs');

function read(file) {
  return fs.readFileSync(file, 'utf-8').replace(/\r\n/g, '\n');
}

/** Ключ шаблону → вміст. Ключі — шляхи відносно плагіна, CI-шаблон — `github/qa-ci.yml`. */
function collectTemplates() {
  const files = {};
  const skillsDir = path.join(PLUGIN_DIR, 'skills');
  for (const name of fs.readdirSync(skillsDir).sort()) {
    const skill = path.join(skillsDir, name, 'SKILL.md');
    if (fs.existsSync(skill)) files[`skills/${name}/SKILL.md`] = read(skill);
  }
  files['hooks/hooks.json'] = read(path.join(PLUGIN_DIR, 'hooks/hooks.json'));
  const templatesDir = path.join(PLUGIN_DIR, 'templates');
  for (const name of fs.readdirSync(templatesDir).sort()) {
    const file = path.join(templatesDir, name);
    if (fs.statSync(file).isFile()) files[`templates/${name}`] = read(file);
  }
  files['github/qa-ci.yml'] = read(path.join(ROOT, 'templates/github/qa-ci.yml'));
  return files;
}

function renderTemplatesModule(files = collectTemplates()) {
  const entries = Object.keys(files)
    .sort()
    .map((key) => `  ${JSON.stringify(key)}:\n    ${JSON.stringify(files[key])},`);
  return [
    '/**',
    ' * ЗГЕНЕРОВАНО scripts/build-qa-cli.mjs з plugin/jules-qa/ і templates/github/qa-ci.yml — не редагуйте',
    ' * вручну: правте файли плагіна й перезберіть CLI (`node scripts/build-qa-cli.mjs`).',
    ' *',
    ' * Шаблони вбудовані в код, бо бандл CLI живе в репо продукту сам по собі (`qa/bin/jules-qa.mjs`).',
    ' */',
    'export const TEMPLATE_FILES: Readonly<Record<string, string>> = {',
    ...entries,
    '};',
    '',
  ].join('\n');
}

async function main() {
  const expected = renderTemplatesModule();
  const current = fs.existsSync(TEMPLATES_TS) ? read(TEMPLATES_TS) : null;

  if (process.argv.includes('--check-templates')) {
    if (current !== expected) {
      console.error('src/qa-cli/templates.ts застарів — запустіть node scripts/build-qa-cli.mjs');
      process.exit(1);
    }
    console.log('src/qa-cli/templates.ts актуальний');
    return;
  }

  if (current !== expected) {
    fs.writeFileSync(TEMPLATES_TS, expected, 'utf-8');
    console.log('src/qa-cli/templates.ts оновлено');
  }

  const { build } = await import('esbuild');
  fs.mkdirSync(path.dirname(OUTFILE), { recursive: true });
  await build({
    entryPoints: [ENTRY],
    outfile: OUTFILE,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    legalComments: 'none',
    logLevel: 'warning',
    banner: {
      js: [
        '#!/usr/bin/env node',
        "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      ].join('\n'),
    },
  });
  fs.chmodSync(OUTFILE, 0o755);
  const size = fs.statSync(OUTFILE).size;
  console.log(`${path.relative(ROOT, OUTFILE)} зібрано (${Math.round(size / 1024)} КБ)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
