/**
 * XML для TestRail: власний серіалізатор і мінімальний парсер (без залежностей).
 *
 * Формат близький до експорту TestRail (`suite → sections → section → cases →
 * case`), з двома власними доповненнями, які роблять round-trip надійним:
 *  - наш ID кейса лежить у `custom/<mapping.idField>` — по ньому `pull`
 *    знаходить кейс у реєстрі;
 *  - канонічні `kind`/`priority` додатково пишемо в `custom/jules_kind` і
 *    `custom/jules_priority`, бо `parseTestrailXml` за контрактом не отримує
 *    мапінг і не може розвернути числові `type_id`/`priority_id`.
 *
 * Секції вкладаються за `sectionPath` («Кібер / Карта договору / Акти»), тому
 * дерево модулів переживає експорт-імпорт.
 */
import type { CaseKind, CasePriority, TestrailMapping } from '../registry/types.js';
import type { ExportCase } from './testrail-csv.js';
import { decodeChecks, encodeChecks } from './testrail-csv.js';

export type { ExportCase };

const PATH_SEPARATOR = ' / ';
const INDENT = '  ';

/* ──────────────────────────── екранування ───────────────────────────── */

export function escapeXml(value: string): string {
  return value
    // Керуючі символи, заборонені в XML 1.0 (крім \t \n \r).
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => codePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => codePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function codePoint(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
  return String.fromCodePoint(code);
}

/** Робить із назви поля безпечне ім'я XML-елемента. */
export function safeElementName(name: string, fallback: string): string {
  const cleaned = name.trim().replace(/[^A-Za-z0-9_.-]/g, '_');
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : fallback;
}

function tag(name: string, value: string, depth: number): string {
  return `${INDENT.repeat(depth)}<${name}>${escapeXml(value)}</${name}>`;
}

/* ──────────────────────────── серіалізація ──────────────────────────── */

interface SectionNode {
  name: string;
  children: Map<string, SectionNode>;
  cases: ExportCase[];
}

function splitPath(sectionPath: string): string[] {
  return sectionPath
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function buildSectionTree(cases: ExportCase[]): SectionNode {
  const root: SectionNode = { name: '', children: new Map(), cases: [] };
  for (const item of cases) {
    const segments = splitPath(item.sectionPath || '');
    let node = root;
    for (const segment of segments) {
      let child = node.children.get(segment);
      if (!child) {
        child = { name: segment, children: new Map(), cases: [] };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.cases.push(item);
  }
  return root;
}

function serializeCase(item: ExportCase, mapping: TestrailMapping, depth: number): string[] {
  const pad = INDENT.repeat(depth);
  const idField = safeElementName(mapping.idField || 'custom_tc_id', 'custom_tc_id');
  const typeValue = mapping.typeMap[item.kind];
  const priorityValue = mapping.priorityMap[item.priority];

  const lines: string[] = [`${pad}<case>`];
  if (item.testrailCaseId) lines.push(tag('id', `C${item.testrailCaseId}`, depth + 1));
  lines.push(tag('title', item.title, depth + 1));
  lines.push(tag('type', typeof typeValue === 'number' ? String(typeValue) : item.kind, depth + 1));
  lines.push(
    tag('priority', typeof priorityValue === 'number' ? String(priorityValue) : item.priority, depth + 1),
  );
  lines.push(tag('template', mapping.template, depth + 1));
  if (item.refs.length > 0) lines.push(tag('refs', item.refs.join(','), depth + 1));

  lines.push(`${INDENT.repeat(depth + 1)}<custom>`);
  lines.push(tag(idField, item.id, depth + 2));
  lines.push(tag('jules_kind', item.kind, depth + 2));
  lines.push(tag('jules_priority', item.priority, depth + 2));
  if (item.preconditions) lines.push(tag('preconds', item.preconditions, depth + 2));
  if (item.tags.length > 0) lines.push(tag('tags', item.tags.join(','), depth + 2));
  if (item.checks.length > 0) lines.push(tag('checks', encodeChecks(item.checks), depth + 2));
  if (item.steps.length > 0) {
    lines.push(`${INDENT.repeat(depth + 2)}<steps_separated>`);
    item.steps.forEach((step, index) => {
      lines.push(`${INDENT.repeat(depth + 3)}<step>`);
      lines.push(tag('index', String(index + 1), depth + 4));
      lines.push(tag('content', step.action, depth + 4));
      lines.push(tag('expected', step.expected, depth + 4));
      lines.push(`${INDENT.repeat(depth + 3)}</step>`);
    });
    lines.push(`${INDENT.repeat(depth + 2)}</steps_separated>`);
  }
  lines.push(`${INDENT.repeat(depth + 1)}</custom>`);
  lines.push(`${pad}</case>`);
  return lines;
}

function serializeSection(node: SectionNode, mapping: TestrailMapping, depth: number): string[] {
  const pad = INDENT.repeat(depth);
  const lines: string[] = [`${pad}<section>`];
  lines.push(tag('name', node.name, depth + 1));
  if (node.children.size > 0) {
    lines.push(`${INDENT.repeat(depth + 1)}<sections>`);
    for (const child of node.children.values()) {
      lines.push(...serializeSection(child, mapping, depth + 2));
    }
    lines.push(`${INDENT.repeat(depth + 1)}</sections>`);
  }
  if (node.cases.length > 0) {
    lines.push(`${INDENT.repeat(depth + 1)}<cases>`);
    for (const item of node.cases) lines.push(...serializeCase(item, mapping, depth + 2));
    lines.push(`${INDENT.repeat(depth + 1)}</cases>`);
  }
  lines.push(`${pad}</section>`);
  return lines;
}

/** Будує XML-набір для імпорту в TestRail. */
export function buildTestrailXml(cases: ExportCase[], mapping: TestrailMapping): string {
  const root = buildSectionTree(cases);
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<suite>'];
  lines.push(tag('name', mapping.name || 'Jules registry export', 1));
  lines.push(`${INDENT}<sections>`);
  for (const child of root.children.values()) {
    lines.push(...serializeSection(child, mapping, 2));
  }
  // Кейси без секції лишаємо в службовій секції, щоб не втратити їх.
  if (root.cases.length > 0) {
    lines.push(...serializeSection({ name: 'Без секції', children: new Map(), cases: root.cases }, mapping, 2));
  }
  lines.push(`${INDENT}</sections>`);
  lines.push('</suite>');
  return `${lines.join('\n')}\n`;
}

/* ─────────────────────────── мінімальний парсер ──────────────────────── */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

/** Розбирає XML у дерево вузлів. Достатньо для експорту TestRail. */
export function parseXml(xml: string, warnings: string[] = []): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const tokenRe = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/?[^>]+>/g;
  let lastIndex = 0;
  let token: RegExpExecArray | null;

  const appendText = (raw: string) => {
    if (!raw) return;
    const node = stack[stack.length - 1]!;
    node.text += raw;
  };

  while ((token = tokenRe.exec(xml)) !== null) {
    appendText(unescapeXml(xml.slice(lastIndex, token.index)));
    lastIndex = token.index + token[0].length;
    const raw = token[0];

    if (raw.startsWith('<!--') || raw.startsWith('<?') || raw.startsWith('<!DOCTYPE')) continue;
    if (raw.startsWith('<![CDATA[')) {
      appendText(raw.slice(9, -3));
      continue;
    }
    if (raw.startsWith('</')) {
      const name = raw.slice(2, -1).trim();
      const index = [...stack].reverse().findIndex((node) => node.name === name);
      if (index === -1) {
        warnings.push(`XML: закриваючий тег </${name}> без відкриваючого — проігноровано.`);
        continue;
      }
      const target = stack.length - 1 - index;
      if (target < stack.length - 1) {
        warnings.push(`XML: незакриті теги перед </${name}> — закрито автоматично.`);
      }
      stack.length = Math.max(1, target);
      continue;
    }

    const selfClosing = raw.endsWith('/>');
    const body = raw.slice(1, selfClosing ? -2 : -1).trim();
    const nameMatch = body.match(/^([^\s/]+)/);
    if (!nameMatch) continue;
    const name = nameMatch[1]!;
    const attrs: Record<string, string> = {};
    const attrRe = /([^\s=]+)\s*=\s*"([^"]*)"|([^\s=]+)\s*=\s*'([^']*)'/g;
    let attr: RegExpExecArray | null;
    while ((attr = attrRe.exec(body.slice(name.length))) !== null) {
      const key = attr[1] ?? attr[3];
      const value = attr[2] ?? attr[4] ?? '';
      if (key) attrs[key] = unescapeXml(value);
    }
    const node: XmlNode = { name, attrs, children: [], text: '' };
    stack[stack.length - 1]!.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  appendText(unescapeXml(xml.slice(lastIndex)));
  return root;
}

function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((item) => item.name.toLowerCase() === name.toLowerCase());
}

function childText(node: XmlNode, name: string): string {
  return (child(node, name)?.text ?? '').trim();
}

function childrenOf(node: XmlNode, containerName: string, itemName: string): XmlNode[] {
  const container = child(node, containerName);
  if (!container) return [];
  return container.children.filter((item) => item.name.toLowerCase() === itemName.toLowerCase());
}

const OUR_ID_RE = /^[A-Z][A-Z0-9]{1,9}-[A-Z][A-Z0-9]{1,7}-\d{3,}$/;
const ID_FIELD_HINT_RE = /(tc[_-]?id|case[_-]?id|jules|registry)/i;

const KNOWN_KINDS = new Set<CaseKind>([
  'positive',
  'negative',
  'neutral',
  'security',
  'a11y',
  'performance',
]);
const KNOWN_PRIORITIES = new Set<CasePriority>(['P1', 'P2', 'P3', 'P4']);

/**
 * Знаходить наш ID у `custom` без мапінгу: спершу за значенням (формат
 * `CYBER-REG-014`), потім за схожою назвою поля.
 */
function findOurId(custom: XmlNode | undefined): string | undefined {
  if (!custom) return undefined;
  for (const node of custom.children) {
    const value = node.text.trim();
    if (OUR_ID_RE.test(value)) return value;
  }
  for (const node of custom.children) {
    if (ID_FIELD_HINT_RE.test(node.name) && node.text.trim()) return node.text.trim();
  }
  return undefined;
}

function parseCaseNode(node: XmlNode, sectionPath: string, warnings: string[]): Partial<ExportCase> {
  const custom = child(node, 'custom');
  const parsed: Partial<ExportCase> = {};

  const title = childText(node, 'title');
  if (title) parsed.title = title;
  if (sectionPath) parsed.sectionPath = sectionPath;

  const ourId = findOurId(custom);
  if (ourId) parsed.id = ourId;
  else warnings.push(`XML: кейс «${title || '(без заголовка)'}» без нашого ID — round-trip неможливий.`);

  const testrailId = childText(node, 'id').replace(/^C/i, '');
  if (testrailId) {
    const numeric = Number(testrailId);
    if (Number.isInteger(numeric) && numeric > 0) parsed.testrailCaseId = numeric;
    else warnings.push(`XML: нечисловий ID TestRail «${testrailId}» — проігноровано.`);
  }

  const kindRaw = (custom ? childText(custom, 'jules_kind') : '') || childText(node, 'type');
  if (kindRaw && KNOWN_KINDS.has(kindRaw.toLowerCase() as CaseKind)) {
    parsed.kind = kindRaw.toLowerCase() as CaseKind;
  } else if (kindRaw) {
    warnings.push(`XML: тип «${kindRaw}» не розпізнано (потрібен мапінг) — поле не заповнено.`);
  }

  const priorityRaw = (custom ? childText(custom, 'jules_priority') : '') || childText(node, 'priority');
  if (priorityRaw && KNOWN_PRIORITIES.has(priorityRaw.toUpperCase() as CasePriority)) {
    parsed.priority = priorityRaw.toUpperCase() as CasePriority;
  } else if (priorityRaw) {
    warnings.push(`XML: пріоритет «${priorityRaw}» не розпізнано (потрібен мапінг) — поле не заповнено.`);
  }

  const refs = childText(node, 'refs');
  if (refs) parsed.refs = refs.split(/[,;]/).map((value) => value.trim()).filter(Boolean);

  if (custom) {
    const preconds = childText(custom, 'preconds');
    if (preconds) parsed.preconditions = preconds;
    const tags = childText(custom, 'tags');
    if (tags) parsed.tags = tags.split(/[,;]/).map((value) => value.trim()).filter(Boolean);
    const checks = childText(custom, 'checks');
    if (checks) parsed.checks = decodeChecks(checks);

    const steps = childrenOf(custom, 'steps_separated', 'step');
    if (steps.length > 0) {
      parsed.steps = steps.map((step) => ({
        action: childText(step, 'content'),
        expected: childText(step, 'expected'),
      }));
    }
  }

  return parsed;
}

function walkSections(
  node: XmlNode,
  parentPath: string[],
  out: Partial<ExportCase>[],
  warnings: string[],
): void {
  for (const section of childrenOf(node, 'sections', 'section')) {
    const name = childText(section, 'name');
    const path = name ? [...parentPath, name] : parentPath;
    for (const caseNode of childrenOf(section, 'cases', 'case')) {
      out.push(parseCaseNode(caseNode, path.join(PATH_SEPARATOR), warnings));
    }
    walkSections(section, path, out, warnings);
  }
}

/** Розбирає XML-експорт TestRail (або наш власний). */
export function parseTestrailXml(xml: string): {
  cases: Partial<ExportCase>[];
  warnings: string[];
} {
  const warnings: string[] = [];
  if (!xml || xml.trim().length === 0) return { cases: [], warnings: ['XML порожній.'] };

  const root = parseXml(xml, warnings);
  const suite = child(root, 'suite') ?? root;
  const cases: Partial<ExportCase>[] = [];

  walkSections(suite, [], cases, warnings);
  // Кейси, покладені прямо в suite (без секцій).
  for (const caseNode of childrenOf(suite, 'cases', 'case')) {
    cases.push(parseCaseNode(caseNode, '', warnings));
  }

  if (cases.length === 0) warnings.push('У XML не знайдено жодного кейса.');
  return { cases, warnings };
}
