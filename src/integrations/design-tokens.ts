/**
 * Звірка дизайн-токенів: змінні Figma проти CSS-змінних у коді (перший рівень
 * візуальних перевірок, браузер не потрібен).
 *
 * Джерела з боку Figma: `GET /v1/files/:key/variables/local` (REST API змінних
 * доступний лише на тарифі Enterprise) або той самий формат, отриманий через
 * Figma MCP / експорт. Імена нормалізуються до CSS-вигляду:
 * `color/primary/500` → `--color-primary-500`.
 *
 * Порівняння: кольори — після `normalizeColor` (будь-який hex/rgb → `#rrggbb[aa]`),
 * розміри `16px` ↔ `16` — як числа з допуском, решта — як рядки.
 * Усі функції чисті.
 */

/* ─────────────────────────────── CSS ─────────────────────────────────── */

/**
 * Витягує `--name: value;` з усіх селекторів (`:root`, `[data-theme]`, …).
 * Останнє визначення перемагає — як у каскаді для однакової специфічності.
 */
export function parseCssVariables(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!css) return out;
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const declRe = /(?<=^|[{;\s])(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]*)/g;
  let match: RegExpExecArray | null;
  while ((match = declRe.exec(clean)) !== null) {
    const value = match[2]!.replace(/\s*!important\s*$/i, '').trim();
    out[match[1]!] = value;
  }
  return out;
}

/* ────────────────────────────── кольори ──────────────────────────────── */

function hex2(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
}

function toHex(r: number, g: number, b: number, a = 1): string {
  const base = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  const alpha = hex2(a * 255);
  return alpha === 'ff' ? base : `${base}${alpha}`;
}

function parseChannel(raw: string): number | null {
  const value = raw.trim();
  if (value.endsWith('%')) {
    const pct = Number(value.slice(0, -1));
    return Number.isFinite(pct) ? (pct / 100) * 255 : null;
  }
  const num = Number(value);
  return value !== '' && Number.isFinite(num) ? num : null;
}

function parseAlpha(raw: string | undefined): number | null {
  if (raw === undefined) return 1;
  const value = raw.trim();
  if (value.endsWith('%')) {
    const pct = Number(value.slice(0, -1));
    return Number.isFinite(pct) ? pct / 100 : null;
  }
  const num = Number(value);
  return value !== '' && Number.isFinite(num) ? Math.max(0, Math.min(1, num)) : null;
}

/**
 * Колір → `#rrggbb` (непрозорий) або `#rrggbbaa` у нижньому регістрі.
 * Підтримує hex 3/4/6/8 і `rgb()`/`rgba()` (через кому чи пробіл, з `/ alpha`).
 * Не колір → `null`.
 */
export function normalizeColor(value: string): string | null {
  if (typeof value !== 'string') return null;
  const input = value.trim().toLowerCase();

  const hex = input.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    let digits = hex[1]!;
    if (digits.length === 3 || digits.length === 4) {
      digits = [...digits].map((ch) => ch + ch).join('');
    }
    if (digits.length === 6) return `#${digits}`;
    if (digits.length === 8) return digits.endsWith('ff') ? `#${digits.slice(0, 6)}` : `#${digits}`;
    return null;
  }

  const fn = input.match(/^rgba?\(\s*([^)]*)\)$/);
  if (fn) {
    const body = fn[1]!.trim();
    let parts: string[];
    let alphaRaw: string | undefined;
    if (body.includes(',')) {
      parts = body.split(',').map((part) => part.trim());
      if (parts.length === 4) alphaRaw = parts.pop();
    } else {
      const [channels, alpha] = body.split('/');
      parts = (channels ?? '').trim().split(/\s+/);
      alphaRaw = alpha?.trim();
    }
    if (parts.length !== 3) return null;
    const [r, g, b] = parts.map(parseChannel);
    const a = parseAlpha(alphaRaw);
    if (r === null || g === null || b === null || r === undefined || g === undefined || b === undefined || a === null) {
      return null;
    }
    return toHex(r, g, b, a);
  }
  return null;
}

/* ───────────────────────────── змінні Figma ──────────────────────────── */

interface FigmaRgba {
  r: number;
  g: number;
  b: number;
  a?: number;
}

interface FigmaAlias {
  type: 'VARIABLE_ALIAS';
  id: string;
}

interface FigmaVariable {
  id?: string;
  name?: string;
  resolvedType?: string;
  variableCollectionId?: string;
  valuesByMode?: Record<string, unknown>;
}

interface FigmaVariableCollection {
  defaultModeId?: string;
  modes?: Array<{ modeId?: string; name?: string }>;
}

export interface FigmaVariablesPayload {
  meta?: {
    variables?: Record<string, FigmaVariable>;
    variableCollections?: Record<string, FigmaVariableCollection>;
  };
}

/** `Color/Primary 500` → `--color-primary-500`. */
export function figmaVariableToCssName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .split('/')
    .map((part) => part.trim().replace(/[^\p{L}\p{N}_-]+/gu, '-'))
    .filter(Boolean)
    .join('-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `--${slug}`;
}

function isAlias(value: unknown): value is FigmaAlias {
  return Boolean(value && typeof value === 'object' && (value as FigmaAlias).type === 'VARIABLE_ALIAS');
}

function isRgba(value: unknown): value is FigmaRgba {
  const v = value as FigmaRgba;
  return Boolean(v && typeof v === 'object' && typeof v.r === 'number' && typeof v.g === 'number' && typeof v.b === 'number');
}

/**
 * Відповідь `GET /v1/files/:key/variables/local` → `{ '--color-primary-500': '#1d4ed8' }`.
 * Береться перший режим колекції; аліаси розв'язуються; BOOLEAN пропускаються
 * (у CSS їм немає відповідника).
 */
export function figmaVariablesToTokens(payload: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const meta = (payload as FigmaVariablesPayload | null)?.meta;
  const variables = meta?.variables;
  if (!variables || typeof variables !== 'object') return out;
  const collections = meta?.variableCollections ?? {};

  const firstModeValue = (variable: FigmaVariable): unknown => {
    const values = variable.valuesByMode ?? {};
    const collection = variable.variableCollectionId ? collections[variable.variableCollectionId] : undefined;
    const modeId = collection?.modes?.[0]?.modeId ?? collection?.defaultModeId;
    if (modeId && modeId in values) return values[modeId];
    const firstKey = Object.keys(values)[0];
    return firstKey === undefined ? undefined : values[firstKey];
  };

  const resolve = (variable: FigmaVariable, seen: Set<string>): string | null => {
    const value = firstModeValue(variable);
    if (isAlias(value)) {
      if (seen.has(value.id)) return null;
      seen.add(value.id);
      const target = variables[value.id];
      return target ? resolve(target, seen) : null;
    }
    if (isRgba(value)) {
      return toHex(value.r * 255, value.g * 255, value.b * 255, value.a ?? 1);
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      // Figma віддає float з шумом (15.999999…), у коді там ціле число.
      return String(Math.round(value * 1000) / 1000);
    }
    if (typeof value === 'string') return value.trim();
    return null;
  };

  const entries = Object.entries(variables).filter(([, variable]) => variable && typeof variable.name === 'string');
  for (const [id, variable] of entries) {
    if (variable.resolvedType === 'BOOLEAN') continue;
    const value = resolve(variable, new Set([variable.id ?? id]));
    if (value === null) continue;
    out[figmaVariableToCssName(variable.name!)] = value;
  }
  return out;
}

/* ───────────────────────────── порівняння ─────────────────────────────── */

export interface TokenComparison {
  matched: string[];
  mismatched: Array<{ name: string; figma: string; code: string }>;
  missingInCode: string[];
  extraInCode: string[];
}

const NUMBER_RE = /^(-?(?:\d+\.?\d*|\.\d+))(px)?$/i;

function asNumber(value: string): number | null {
  const match = value.trim().match(NUMBER_RE);
  return match ? Number(match[1]) : null;
}

/** `var(--a)` у CSS → значення `--a` (з fallback, якщо змінної немає). */
function resolveCss(css: Record<string, string>, value: string, depth = 0): string {
  if (depth > 10) return value;
  const match = value.trim().match(/^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*(.+))?\)$/);
  if (!match) return value;
  const ref = css[match[1]!];
  if (ref !== undefined) return resolveCss(css, ref, depth + 1);
  return match[2] !== undefined ? resolveCss(css, match[2], depth + 1) : value;
}

function plain(value: string): string {
  return value.trim().replace(/^(['"])(.*)\1$/, '$2').replace(/\s+/g, ' ').toLowerCase();
}

function sameValue(figma: string, code: string, tolerance: number): boolean {
  const colorA = normalizeColor(figma);
  const colorB = normalizeColor(code);
  if (colorA !== null || colorB !== null) return colorA === colorB;
  const numA = asNumber(figma);
  const numB = asNumber(code);
  if (numA !== null && numB !== null) return Math.abs(numA - numB) <= tolerance + 1e-9;
  return plain(figma) === plain(code);
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Звіряє токени Figma з CSS-змінними. Усі списки відсортовані за назвою.
 * `tolerance` — допуск для чисел/px (дефолт 0).
 */
export function compareTokens(
  figma: Record<string, string>,
  css: Record<string, string>,
  opts?: { tolerance?: number },
): TokenComparison {
  const tolerance = opts?.tolerance ?? 0;
  const result: TokenComparison = { matched: [], mismatched: [], missingInCode: [], extraInCode: [] };
  for (const name of sorted(Object.keys(figma))) {
    const figmaValue = figma[name]!;
    if (!(name in css)) {
      result.missingInCode.push(name);
      continue;
    }
    const codeValue = resolveCss(css, css[name]!);
    if (sameValue(figmaValue, codeValue, tolerance)) result.matched.push(name);
    else result.mismatched.push({ name, figma: figmaValue, code: codeValue });
  }
  result.extraInCode = sorted(Object.keys(css).filter((name) => !(name in figma)));
  return result;
}
