import { afterEach, describe, expect, it } from 'vitest';
import { clearRegisteredSecrets, redactText, registerSecretsForRedaction } from '../../../src/security/redact.js';

describe('redact', () => {
  afterEach(() => {
    clearRegisteredSecrets();
  });

  it('masks secret template references', () => {
    expect(redactText('Use {{secret:demo.password}} here')).toBe('Use {{secret:***}} here');
  });

  it('masks registered secret values', () => {
    registerSecretsForRedaction(['super-secret-token']);
    expect(redactText('Authorization: super-secret-token')).toBe('Authorization: [REDACTED]');
  });

  it('masks password= patterns', () => {
    expect(redactText('password=MyPass123')).toMatch(/\[REDACTED\]/);
  });
});
