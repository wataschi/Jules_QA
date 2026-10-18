import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const BUNDLE = path.join(ROOT, 'dist/qa-cli/jules-qa.mjs');

describe('qa-cli / збірка бандла', () => {
  it('src/qa-cli/templates.ts відповідає файлам плагіна', () => {
    const out = execFileSync(process.execPath, ['scripts/build-qa-cli.mjs', '--check-templates'], { cwd: ROOT, encoding: 'utf-8', timeout: 60_000 });
    expect(out).toContain('актуальний');
  });

  it('збирає самодостатній бандл, і --help працює без node_modules поруч', () => {
    execFileSync(process.execPath, ['scripts/build-qa-cli.mjs'], { cwd: ROOT, encoding: 'utf-8', timeout: 60_000 });
    const text = fs.readFileSync(BUNDLE, 'utf-8');
    expect(text.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(text).toContain('createRequire');

    // Копія поза репо: так бандл живе в репо продукту як qa/bin/jules-qa.mjs.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jules-qa-bundle-'));
    try {
      const copy = path.join(dir, 'jules-qa.mjs');
      fs.copyFileSync(BUNDLE, copy);
      const help = execFileSync(process.execPath, [copy, '--help'], { cwd: dir, encoding: 'utf-8', timeout: 60_000 });
      expect(help).toContain('jules-qa');
      expect(help).toContain('sync');
      expect(help).toContain('push-check');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
