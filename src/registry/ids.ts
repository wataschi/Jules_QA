/**
 * Ідентифікатори реєстру.
 *
 *  - ID кейса: `<PROJECT.KEY>-<SECTION.CODE>-<NNN>`, лічильник у межах секції,
 *    номер мінімум із 3 цифр. ID НІКОЛИ не змінюється: ні при перейменуванні,
 *    ні при переміщенні кейса в іншу секцію.
 *  - `code` секції: транслітерація назви (укр/рос → латиниця), 3–6 літер,
 *    унікально в межах проєкту.
 */
import { randomUUID } from 'node:crypto';
import { execute, queryOne } from './db.js';

/** Укр/рос → латиниця. Довші послідовності перевіряються першими. */
const TRANSLIT: Array<[RegExp, string]> = [
  [/щ/g, 'shch'],
  [/ш/g, 'sh'],
  [/ч/g, 'ch'],
  [/ц/g, 'ts'],
  [/ю/g, 'yu'],
  [/я/g, 'ya'],
  [/є/g, 'ye'],
  [/ї/g, 'yi'],
  [/ж/g, 'zh'],
  [/х/g, 'kh'],
  [/ё/g, 'yo'],
  [/э/g, 'e'],
  [/й/g, 'y'],
  [/а/g, 'a'],
  [/б/g, 'b'],
  [/в/g, 'v'],
  [/г/g, 'h'],
  [/ґ/g, 'g'],
  [/д/g, 'd'],
  [/е/g, 'e'],
  [/з/g, 'z'],
  [/и/g, 'y'],
  [/і/g, 'i'],
  [/к/g, 'k'],
  [/л/g, 'l'],
  [/м/g, 'm'],
  [/н/g, 'n'],
  [/о/g, 'o'],
  [/п/g, 'p'],
  [/р/g, 'r'],
  [/с/g, 's'],
  [/т/g, 't'],
  [/у/g, 'u'],
  [/ф/g, 'f'],
  [/ь/g, ''],
  [/ъ/g, ''],
  [/ы/g, 'y'],
  [/['’ʼ]/g, ''],
];

/** Транслітерує рядок у латиницю (нижній регістр, без пунктуації). */
export function transliterate(input: string): string {
  let out = (input ?? '').normalize('NFC').toLowerCase();
  for (const [pattern, replacement] of TRANSLIT) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Слаг для `project.id` / `selection.id`: латиниця, дефіси. */
export function slugify(input: string, fallback = 'item'): string {
  const slug = transliterate(input).replace(/\s+/g, '-').slice(0, 60).replace(/^-+|-+$/g, '');
  return slug || fallback;
}

/**
 * Код секції з назви: 3–6 великих латинських літер/цифр, унікальний у проєкті.
 * Береться від початку слів (акроніми для багатослівних назв), потім
 * дописуються літери першого слова, у крайньому разі — цифра.
 */
export function generateSectionCode(name: string, taken: Iterable<string> = []): string {
  const used = new Set(Array.from(taken, (code) => code.toUpperCase()));
  const words = transliterate(name).split(' ').filter(Boolean);
  const candidates: string[] = [];

  if (words.length >= 2) {
    const acronym = words.map((w) => w[0]).join('').toUpperCase();
    if (acronym.length >= 3) candidates.push(acronym.slice(0, 6));
    // «Карта договору» → KARDOG
    candidates.push(words.map((w) => w.slice(0, 3)).join('').toUpperCase().slice(0, 6));
  }

  const first = (words[0] ?? '').toUpperCase();
  if (first) {
    const consonants = first.replace(/[AEIOUY]/g, '');
    if (consonants.length >= 3) candidates.push((first[0] + consonants.slice(1)).slice(0, 6));
    candidates.push(first.slice(0, 6));
    candidates.push(first.slice(0, 4));
    candidates.push(first.slice(0, 3));
  }

  for (const raw of candidates) {
    const code = padCode(raw);
    if (!code) continue;
    if (!used.has(code)) return code;
  }

  const base = padCode(first || 'SEC') || 'SEC';
  for (let i = 2; i < 1000; i += 1) {
    const suffix = String(i);
    const code = `${base.slice(0, Math.max(3, 6 - suffix.length))}${suffix}`;
    if (!used.has(code)) return code;
  }
  return `SEC${Date.now().toString(36).slice(-3).toUpperCase()}`;
}

function padCode(raw: string): string {
  const cleaned = raw.replace(/[^A-Z0-9]/g, '');
  if (!cleaned) return '';
  if (!/^[A-Z]/.test(cleaned)) return padCode(`S${cleaned}`);
  if (cleaned.length >= 3) return cleaned.slice(0, 6);
  return (cleaned + 'XXX').slice(0, 3);
}

export const CASE_ID_PATTERN = /^[A-Z][A-Z0-9]{1,9}-[A-Z][A-Z0-9]{1,7}-\d{3,}$/;

export function formatCaseId(projectKey: string, sectionCode: string, counter: number): string {
  return `${projectKey}-${sectionCode}-${String(counter).padStart(3, '0')}`;
}

/**
 * Наступний вільний ID кейса в секції. Лічильник зберігається в
 * `case_counters` і не зменшується — навіть після видалення кейсів.
 */
export function nextCaseId(projectKey: string, sectionId: string, sectionCode: string): string {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    execute(
      `INSERT INTO case_counters (section_id, next) VALUES (?, 1)
       ON CONFLICT(section_id) DO UPDATE SET next = next + 1`,
      [sectionId],
    );
    const row = queryOne<{ next: number }>('SELECT next FROM case_counters WHERE section_id = ?', [
      sectionId,
    ]);
    const id = formatCaseId(projectKey, sectionCode, Number(row?.next ?? 1));
    const clash = queryOne<{ id: string }>('SELECT id FROM cases WHERE id = ?', [id]);
    if (!clash) return id;
  }
  throw new Error(`Не вдалося видати ID кейса для секції ${sectionId}: лічильник переповнений`);
}

/** Піднімає лічильник секції щонайменше до `value` (використовує скрипт міграції). */
export function bumpCaseCounter(sectionId: string, value: number): void {
  execute(
    `INSERT INTO case_counters (section_id, next) VALUES (?, ?)
     ON CONFLICT(section_id) DO UPDATE SET next = MAX(next, excluded.next)`,
    [sectionId, value],
  );
}

/** Короткий унікальний ID для службових сутностей (ревізії, прогони, дефекти). */
export function newId(prefix = ''): string {
  const raw = randomUUID();
  return prefix ? `${prefix}_${raw}` : raw;
}
