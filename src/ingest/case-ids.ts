/**
 * ID кейсів реєстру в назвах тестів: `CYBER-ACT-014 акт без суми…` або
 * pytest-стиль `test_CYBER_ACT_014_act_without_amount`.
 *
 * Межі слова рахуємо вручну: `\b` не спрацює в `test_CYBER_ACT_014_…`, бо `_`
 * для регексу — літера слова. Тому зліва — не латинська літера/цифра, справа —
 * не літера/цифра (підкреслення після номера дозволене).
 */
const CASE_ID_RE = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]{1,9})[-_]([A-Z][A-Z0-9]{1,7})[-_](\d{3,})(?![A-Za-z0-9])/g;

/** `CYBER-ACT-014`, а також `CYBER_ACT_014` (pytest) → нормалізовано через дефіс, унікальні, в порядку появи. */
export function extractCaseIds(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  for (const match of text.matchAll(CASE_ID_RE)) {
    seen.add(`${match[1]}-${match[2]}-${match[3]}`);
  }
  return [...seen];
}
