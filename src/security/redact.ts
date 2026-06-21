const SENSITIVE_PATTERNS: RegExp[] = [
  /(?:password|passwd|pwd|token|api[_-]?key)\s*[:=]\s*\S+/gi,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
];

const SECRET_TEMPLATE = /\{\{secret:([^.}]+)\.([^}]+)\}\}/g;

let registeredSecrets = new Set<string>();

export function registerSecretsForRedaction(values: string[]): void {
  registeredSecrets = new Set(values.filter((v) => v.length >= 4));
}

export function clearRegisteredSecrets(): void {
  registeredSecrets = new Set();
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
