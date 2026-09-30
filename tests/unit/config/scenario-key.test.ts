import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  baseScenarioName,
  artifactNameCandidates,
  getCacheId,
  hashTargetUrl,
  normalizeTargetUrl,
  resetEnvCache,
  scenarioKey,
  setActiveTargetUrl,
} from '../../../src/config/env.js';

describe('scenarioKey', () => {
  beforeEach(() => {
    resetEnvCache();
    process.env.QA_TARGET_URL = 'https://example.com';
  });

  afterEach(() => {
    resetEnvCache();
    delete process.env.QA_TARGET_URL;
  });

  it('gives different keys for different target URLs', () => {
    const a = scenarioKey('login-smoke', 'https://site-a.example/app');
    const b = scenarioKey('login-smoke', 'https://site-b.example/app');
    expect(a).not.toBe(b);
    expect(baseScenarioName(a)).toBe('login-smoke');
    expect(baseScenarioName(b)).toBe('login-smoke');
  });

  it('is stable for the same URL', () => {
    const first = scenarioKey('login-smoke', 'https://site-a.example/app');
    const second = scenarioKey('login-smoke', 'https://site-a.example/app');
    expect(first).toBe(second);
    expect(first).toMatch(/^login-smoke--[0-9a-f]{8}$/);
  });

  it('normalises origin+pathname: query, hash, trailing slash and case are ignored', () => {
    expect(normalizeTargetUrl('https://Site.Example/App/?q=1#frag')).toBe('https://site.example/app');
    expect(hashTargetUrl('https://site.example/app')).toBe(
      hashTargetUrl('https://SITE.example/app/?x=2#y'),
    );
  });

  it('distinguishes different pathnames on the same host', () => {
    expect(hashTargetUrl('https://site.example/a')).not.toBe(hashTargetUrl('https://site.example/b'));
  });

  it('is idempotent — passing an existing key back returns it unchanged', () => {
    const key = scenarioKey('login-smoke', 'https://site-a.example');
    expect(scenarioKey(key)).toBe(key);
    expect(scenarioKey(key, 'https://totally-other.example')).toBe(key);
  });

  it('falls back to the raw string for an unparsable URL', () => {
    expect(normalizeTargetUrl('  NOT a url  ')).toBe('not a url');
    expect(scenarioKey('x', 'not a url')).toMatch(/^x--[0-9a-f]{8}$/);
  });

  it('uses the active target URL when none is passed', () => {
    setActiveTargetUrl('https://from-scenario.example/path');
    expect(scenarioKey('s')).toBe(scenarioKey('s', 'https://from-scenario.example/path'));
    setActiveTargetUrl(null);
    expect(scenarioKey('s')).toBe(scenarioKey('s', 'https://example.com'));
  });

  it('cacheId carries the same key', () => {
    expect(getCacheId('demo', 'https://site-a.example')).toBe(
      `jules-${scenarioKey('demo', 'https://site-a.example')}`,
    );
    expect(getCacheId('demo', 'https://site-a.example')).not.toBe(
      getCacheId('demo', 'https://site-b.example'),
    );
  });

  it('artifactNameCandidates puts the key first and the legacy name second', () => {
    const candidates = artifactNameCandidates('demo', 'https://site-a.example');
    expect(candidates).toEqual([scenarioKey('demo', 'https://site-a.example'), 'demo']);
    // Уже готовий ключ не породжує дубля.
    expect(artifactNameCandidates(candidates[0])).toEqual([candidates[0], 'demo']);
  });
});
