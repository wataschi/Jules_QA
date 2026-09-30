const SENSITIVE_PATTERNS: RegExp[] = [
  /(?:password|passwd|pwd|token|api[_-]?key)\s*[:=]\s*\S+/gi,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
];

const SECRET_TEMPLATE = /\{\{secret:([^.}]+)\.([^}]+)\}\}/g;

let registeredSecrets = new Set<string>();

/** Замінює реєстр значень для маскування (повне перезаписування). */
export function registerSecretsForRedaction(values: string[]): void {
  registeredSecrets = new Set(values.filter((v) => v.length >= 4));
}

/**
 * Додає значення до реєстру, не прибираючи вже зареєстровані.
 *
 * Потрібно серверному процесу: `registerSecretsForRedaction` виконувався лише в
 * дочірньому процесі Playwright, тому в сервері реєстр завжди був порожній і
 * `redactText` над логами прогону не маскував нічого, крім статичних регексів.
 * Сервер реєструє секрети перед кожним spawn — тож реєстрація мусить бути
 * накопичувальною, інакше кожен наступний прогін стирав би попередні значення.
 */
export function addSecretsForRedaction(values: string[]): void {
  for (const value of values) {
    if (value.length >= 4) registeredSecrets.add(value);
  }
}

export function clearRegisteredSecrets(): void {
  registeredSecrets = new Set();
}

/** Кількість зареєстрованих значень (для діагностики; самі значення не віддаємо). */
export function registeredSecretsCount(): number {
  return registeredSecrets.size;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactText(text: string): string {
  let result = text.replace(SECRET_TEMPLATE, '{{secret:***}}');

  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, (match) => match.replace(/[:=]\s*\S+$/, (sep) => `${sep[0]} [REDACTED]`));
  }

  for (const secret of registeredSecrets) {
    if (result.includes(secret)) {
      result = result.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED]');
    }
  }

  return result;
}
