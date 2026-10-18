/**
 * JUnit XML (`testsuites/testsuite/testcase`) → `ParsedTestResult[]`.
 *
 * Один формат пишуть дуже різні раннери, тому файл тесту шукаємо по черзі:
 * атрибут `file` у testcase → `file` найближчого testsuite → `classname`.
 * Vitest кладе в `classname` шлях файлу, pytest — модуль через крапки
 * (`tests.unit.test_x.TestClass`), Java — ім'я класу (його лишаємо як є).
 */
import { normalizePath, toRepoPath } from './glob.js';
import {
  cleanError,
  findAll,
  parseXmlReport,
  ReportParseError,
  type Framework,
  type ParsedTestResult,
  type PathOptions,
  type XmlNode,
} from './types.js';

export interface JunitOptions extends PathOptions {
  /** Перекриває автовизначення фреймворку (за назвою testsuites, розширенням файлу). */
  framework?: Framework;
}

const LABEL = 'JUnit XML';
const FULL_NAME_SEPARATOR = ' > ';
const KNOWN_EXTENSION_RE = /\.(?:[cm]?[jt]sx?|py|java|kt|kts|go|rb|cs|php|rs|swift|scala|feature)$/i;
const SPLITS_NAME = new Set<Framework>(['vitest', 'jest']);
const GENERIC_SUITE_RE = /^(?:pytest|vitest tests|jest tests|root|default suite|mocha tests)$/i;
/** Сегменти, що повторюють «чому впало» ще раз: рахуємо як ретраї (surefire, rerunfailures). */
const RERUN_TAGS = new Set(['flakyfailure', 'flakyerror', 'rerunfailure', 'rerunerror']);

function looksLikePath(value: string): boolean {
  return value.includes('/') || value.includes('\\') || KNOWN_EXTENSION_RE.test(value);
}

interface ClassnameInfo {
  file?: string;
  /** Класи pytest після модуля: `TestActTotals`. */
  classes: string[];
}

/**
 * `tests.unit.test_acts.TestActTotals` → `tests/unit/test_acts.py` + [`TestActTotals`].
 * Модуль — останній сегмент виду `test_*` або `*_test`; якщо такого немає,
 * це не pytest-модуль, і шлях не вигадуємо.
 */
function fileFromClassname(classname: string): ClassnameInfo {
  if (!classname) return { classes: [] };
  if (looksLikePath(classname)) return { file: classname, classes: [] };
  const segments = classname.split('.');
  if (segments.some((segment) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment))) {
    return { classes: [] };
  }
  let moduleIndex = -1;
  segments.forEach((segment, index) => {
    if (/^test_|_test$|^test$/.test(segment)) moduleIndex = index;
  });
  if (moduleIndex === -1) return { classes: [] };
  return {
    file: `${segments.slice(0, moduleIndex + 1).join('/')}.py`,
    classes: segments.slice(moduleIndex + 1),
  };
}

function detectFramework(root: XmlNode): Framework {
  const suites = findAll(root, 'testsuites')[0];
  const label = `${suites?.attrs.name ?? ''} ${findAll(root, 'testsuite')[0]?.attrs.name ?? ''}`;
  if (/\bpytest\b/i.test(label)) return 'pytest';
  if (/\bvitest\b/i.test(label)) return 'vitest';
  if (/\bjest\b/i.test(label)) return 'jest';
  return 'junit';
}

function secondsToMs(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const seconds = Number(value.replace(/,/g, ''));
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}

function failureText(node: XmlNode): string | undefined {
  const message = node.attrs.message?.trim() ?? '';
  const body = node.text.trim();
  if (message && body && !body.includes(message)) return cleanError(`${message}\n${body}`);
  return cleanError(body || message || node.attrs.type);
}

function sameFile(a: string, b: string): boolean {
  const left = normalizePath(a);
  const right = normalizePath(b);
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

interface SuiteFrame {
  name: string;
  file?: string;
}

function parseCase(
  testcase: XmlNode,
  suites: SuiteFrame[],
  framework: Framework,
  rootDir: string,
): ParsedTestResult {
  const classname = testcase.attrs.classname?.trim() ?? '';
  const fromClassname = fileFromClassname(classname);
  const suiteFile = [...suites].reverse().find((suite) => suite.file)?.file;
  const rawFile = testcase.attrs.file?.trim() || suiteFile || fromClassname.file || classname;
  const file = toRepoPath(rawFile, rootDir);

  const rawName = (testcase.attrs.name ?? '').trim();
  // Лише Vitest/Jest пишуть у name ланцюжок describe через « > »; у pytest і
  // Java символ «>» — частина назви (параметри, повідомлення).
  const nameSegments = SPLITS_NAME.has(framework)
    ? rawName.split(FULL_NAME_SEPARATOR).filter((segment) => segment.length > 0)
    : [rawName];
  const name = nameSegments[nameSegments.length - 1] ?? rawName;

  const prefix: string[] = [];
  const skip = (value: string) =>
    !value ||
    GENERIC_SUITE_RE.test(value) ||
    value === classname ||
    sameFile(value, rawFile) ||
    sameFile(value, file);
  for (const suite of suites) {
    if (!skip(suite.name) && !prefix.includes(suite.name)) prefix.push(suite.name);
  }
  for (const className of fromClassname.classes) {
    if (!prefix.includes(className)) prefix.push(className);
  }
  const fullName = [...prefix, ...(nameSegments.length > 0 ? nameSegments : [rawName])].join(
    FULL_NAME_SEPARATOR,
  );

  const lowerChildren = testcase.children.map((item) => ({ item, tag: item.name.toLowerCase() }));
  const failure = lowerChildren.find(({ tag }) => tag === 'failure' || tag === 'error');
  const skipped = lowerChildren.find(({ tag }) => tag === 'skipped');
  const reruns = lowerChildren.filter(({ tag }) => RERUN_TAGS.has(tag)).length;

  const effectiveFramework: Framework =
    framework === 'junit' && /\.py$/i.test(file) ? 'pytest' : framework;

  const result: ParsedTestResult = {
    file,
    name,
    fullName,
    status: failure ? 'failed' : skipped ? 'skipped' : 'passed',
    framework: effectiveFramework,
  };
  const durationMs = secondsToMs(testcase.attrs.time);
  if (durationMs !== undefined) result.durationMs = durationMs;
  if (failure) {
    const error = failureText(failure.item);
    if (error) result.error = error;
  }
  if (reruns > 0) result.retries = reruns;
  return result;
}

function walk(
  node: XmlNode,
  suites: SuiteFrame[],
  framework: Framework,
  rootDir: string,
  out: ParsedTestResult[],
): void {
  for (const item of node.children) {
    const tag = item.name.toLowerCase();
    if (tag === 'testsuite' || tag === 'testsuites') {
      const frame: SuiteFrame = { name: (item.attrs.name ?? '').trim() };
      if (item.attrs.file?.trim()) frame.file = item.attrs.file.trim();
      walk(item, tag === 'testsuite' ? [...suites, frame] : suites, framework, rootDir, out);
    } else if (tag === 'testcase') {
      out.push(parseCase(item, suites, framework, rootDir));
    }
  }
}

export function parseJunitXml(content: string, options: JunitOptions = {}): ParsedTestResult[] {
  const root = parseXmlReport(content, 'junit', LABEL);
  if (!root) return [];
  const top = root.children.find((item) => !item.name.startsWith('#'));
  const topName = top?.name.toLowerCase();
  if (topName !== 'testsuites' && topName !== 'testsuite') {
    throw new ReportParseError(
      'junit',
      `${LABEL}: очікувався кореневий <testsuites> або <testsuite>, а знайдено <${top?.name ?? '?'}>`,
    );
  }
  const framework = options.framework ?? detectFramework(root);
  const out: ParsedTestResult[] = [];
  walk(root, [], framework, options.rootDir ?? process.cwd(), out);
  return out;
}
