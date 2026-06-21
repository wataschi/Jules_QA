import { describe, expect, it } from 'vitest';
import {
  getProfileStorageStatePath,
  parseAuthStep,
  authProfileSchema,
} from '../../../src/security/auth-profile.js';
import { isStorageStateFresh } from '../../../src/engine/session.js';

describe('auth-profile', () => {
  it('parses secret references from steps', () => {
    const parsed = parseAuthStep('Type password {{secret:demo-site.password}} into field');
    expect(parsed.secretRefs).toEqual([{ profileId: 'demo-site', field: 'password' }]);
    expect(parsed.instruction).toContain('[SECRET]');
    expect(parsed.isHuman).toBe(false);
  });

  it('detects human: steps', () => {
    const parsed = parseAuthStep('human:Complete 2FA verification');
    expect(parsed.isHuman).toBe(true);
    expect(parsed.instruction).toBe('Complete 2FA verification');
  });

  it('validates auth profile schema', () => {
    const profile = authProfileSchema.parse({
      id: 'demo',
      loginUrl: 'https://example.com/login',
      steps: ['Click login'],
    });
    expect(profile.sessionTtlMinutes).toBe(60);
    expect(getProfileStorageStatePath(profile)).toContain('demo.json');
  });
});

describe('session TTL', () => {
  it('returns fresh when within TTL', () => {
    const now = Date.now();
    expect(isStorageStateFresh('/tmp/state.json', 60, now - 30_000)).toBe(true);
  });

  it('returns stale when beyond TTL', () => {
    const now = Date.now();
    expect(isStorageStateFresh('/tmp/state.json', 1, now - 120_000)).toBe(false);
  });
});
