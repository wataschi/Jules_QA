import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../../src/qa-cli/main.js';
import { expandGlobs } from '../../../src/qa-cli/reports.js';
import { FIXTURES, makeCtx, makeTempRepo, readFile, writeConfig, writeFile } from './_helpers.js';

describe('qa-cli / manifest', () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  function repo(): string {
    const r = makeTempRepo();
    cleanup = r.cleanup;
    writeConfig(r.root, { projectId: 'cyber', reports: { tests: ['test-results/*.xml'] }, levels: { e2e: ['e2e/**'] } });
    writeFile(r.root, 'test-results/junit.xml', fs.readFileSync(path.join(FIXTURES, 'junit.xml'), 'utf-8'));
    return r.root;
  }

  it('будує qa/manifest.json зі звітів: ID кейсів, рівні, стабільний порядок', async () => {
    const root = repo();
    const io = makeCtx({ cwd: root });
    expect(await runCli(['manifest'], io.ctx)).toBe(0);
    const manifest = JSON.parse(readFile(root, 'qa/manifest.json'));
    expect(manifest.version).toBe(1);
    expect(manifest.tests.map((t: { file: string; level: string; caseIds: string[] }) => [t.file, t.level, t.caseIds])).toEqual([
      ['e2e/login.spec.ts', 'e2e', ['CYBER-AUTH-001']],
      ['src/acts/acts.test.ts', 'unit', ['CYBER-ACT-014']],
      ['src/acts/acts.test.ts', 'unit', ['CYBER-ACT-021']],
      ['src/acts/acts.test.ts', 'unit', []],
    ]);
    expect(io.out()).toContain('Без ID кейса: 1');
  });

  it('--check: 0 для свіжого маніфесту, 1 для застарілого (і файл не змінює)', async () => {
    const root = repo();
    await runCli(['manifest'], makeCtx({ cwd: root }).ctx);

    const fresh = makeCtx({ cwd: root });
    expect(await runCli(['manifest', '--check'], fresh.ctx)).toBe(0);
    expect(fresh.out()).toContain('актуальний');

    const stale = '{\n  "version": 1,\n  "tests": []\n}\n';
    writeFile(root, 'qa/manifest.json', stale);
    const io = makeCtx({ cwd: root });
    expect(await runCli(['manifest', '--check'], io.ctx)).toBe(1);
    expect(io.err()).toContain('застарів (+4 −0 ~0)');
    expect(io.err()).toContain('+ e2e/login.spec.ts');
    expect(readFile(root, 'qa/manifest.json')).toBe(stale);
  });

  it('без звітів — код 1 з підказкою запустити тести', async () => {
    const root = repo();
    fs.rmSync(path.join(root, 'test-results'), { recursive: true });
    const io = makeCtx({ cwd: root });
    expect(await runCli(['manifest', '--check'], io.ctx)).toBe(1);
    expect(io.err()).toContain('Звітів тестів не знайдено');
  });

  it('expandGlobs: литеральний шлях, ** і пропуск node_modules', () => {
    const root = repo();
    writeFile(root, 'packages/a/test-results/junit.xml', '<testsuites/>');
    writeFile(root, 'node_modules/x/test-results/junit.xml', '<testsuites/>');
    expect(expandGlobs(root, ['**/test-results/*.xml'])).toEqual(['packages/a/test-results/junit.xml', 'test-results/junit.xml']);
    expect(expandGlobs(root, ['test-results/junit.xml', 'missing.xml'])).toEqual(['test-results/junit.xml']);
    expect(expandGlobs(root, [])).toEqual([]);
  });
});
