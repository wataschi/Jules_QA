import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, findRepoRoot, loadConfig, parseConfig, requireHub, requireProject } from '../../../src/qa-cli/config.js';
import { makeTempRepo, writeConfig, writeFile } from './_helpers.js';

describe('qa-cli / config', () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  it('читає qa/jules.config.json і нормалізує адресу хаба', () => {
    const repo = makeTempRepo();
    cleanup = repo.cleanup;
    writeConfig(repo.root, {
      hub: 'https://mac.tail.ts.net/',
      projectId: 'cyber',
      reports: { tests: ['test-results/*.xml'], coverage: 'coverage/lcov.info' },
      levels: { e2e: ['e2e/**'] },
      commands: { testFile: 'npx vitest run {files}' },
    });
    const config = loadConfig({ cwd: repo.root, env: {} });
    expect(config.fileFound).toBe(true);
    expect(config.hub).toBe('https://mac.tail.ts.net');
    expect(config.projectId).toBe('cyber');
    expect(config.reports).toEqual({ tests: ['test-results/*.xml'], coverage: ['coverage/lcov.info'], mutation: [] });
    expect(config.levels).toEqual({ e2e: ['e2e/**'] });
    expect(config.commands.testFile).toBe('npx vitest run {files}');
    expect(config.commands.related).toBeUndefined();
    expect(config.testFileGlobs).toContain('**/*.test.*');
    expect(config.token).toBeUndefined();
  });

  it('env JULES_URL, JULES_TOKEN і JULES_PROJECT перекривають файл', () => {
    const repo = makeTempRepo();
    cleanup = repo.cleanup;
    writeConfig(repo.root, { hub: 'https://file.example', projectId: 'from-file' });
    const config = loadConfig({
      cwd: repo.root,
      env: { JULES_URL: 'http://127.0.0.1:3840', JULES_TOKEN: ' secret-token ', JULES_PROJECT: 'from-env' },
    });
    expect(config.hub).toBe('http://127.0.0.1:3840');
    expect(config.projectId).toBe('from-env');
    expect(config.token).toBe('secret-token');
  });

  it('без файлу працює лише з env і дефолтами', () => {
    const repo = makeTempRepo();
    cleanup = repo.cleanup;
    const config = loadConfig({ cwd: repo.root, env: { JULES_URL: 'https://hub.example' } });
    expect(config.fileFound).toBe(false);
    expect(config.hub).toBe('https://hub.example');
    expect(config.reports.tests).toEqual([]);
    expect(() => requireProject(config)).toThrow(ConfigError);
  });

  it('без адреси хаба requireHub дає зрозумілу помилку', () => {
    const repo = makeTempRepo();
    cleanup = repo.cleanup;
    const config = loadConfig({ cwd: repo.root, env: {} });
    expect(() => requireHub(config)).toThrow(/JULES_URL/);
  });

  it('знаходить корінь репо з підкаталогу', () => {
    const repo = makeTempRepo();
    cleanup = repo.cleanup;
    writeConfig(repo.root, { projectId: 'cyber' });
    writeFile(repo.root, 'src/acts/a.ts', '');
    expect(findRepoRoot(path.join(repo.root, 'src/acts'))).toBe(repo.root);
    expect(loadConfig({ cwd: path.join(repo.root, 'src'), env: {} }).projectId).toBe('cyber');
  });

  it('битий JSON і невідомий рівень — ConfigError', () => {
    expect(() => parseConfig('{ hub: ')).toThrow(ConfigError);
    expect(() => parseConfig('[]')).toThrow(ConfigError);
    expect(() => parseConfig(JSON.stringify({ levels: { smoke: ['x/**'] } }))).toThrow(/smoke/);
    expect(() => parseConfig(JSON.stringify({ reports: { tests: [1] } }))).toThrow(/reports\.tests/);
  });

  it('адреса без http(s) відхиляється', () => {
    const repo = makeTempRepo();
    cleanup = repo.cleanup;
    expect(() => loadConfig({ cwd: repo.root, env: { JULES_URL: 'mac.tail.ts.net' } })).toThrow(ConfigError);
  });
});
