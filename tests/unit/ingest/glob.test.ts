import { describe, expect, it } from 'vitest';
import { matchGlob, normalizePath, toRepoPath } from '../../../src/ingest/index.js';

describe('matchGlob', () => {
  it('** збігається з будь-якою глибиною, зокрема з нульовою', () => {
    expect(matchGlob('**/*.test.*', 'a.test.ts')).toBe(true);
    expect(matchGlob('**/*.test.*', 'src/deep/a.test.tsx')).toBe(true);
    expect(matchGlob('**/e2e/**', 'apps/web/e2e/login.spec.ts')).toBe(true);
    expect(matchGlob('src/**/x.ts', 'src/x.ts')).toBe(true);
  });

  it('* і ? не перетинають межу каталогу', () => {
    expect(matchGlob('src/*.ts', 'src/a.ts')).toBe(true);
    expect(matchGlob('src/*.ts', 'src/sub/a.ts')).toBe(false);
    expect(matchGlob('src/?.ts', 'src/a.ts')).toBe(true);
    expect(matchGlob('src/?.ts', 'src/ab.ts')).toBe(false);
  });

  it('dir/** збігається і з вмістом, і з самим каталогом', () => {
    expect(matchGlob('tests/**', 'tests/unit/a.ts')).toBe(true);
    expect(matchGlob('tests/**', 'tests')).toBe(true);
    expect(matchGlob('tests/**', 'src/tests/a.ts')).toBe(false);
  });

  it('екранує спецсимволи регексу і розуміє класи символів', () => {
    expect(matchGlob('a+b.(x).ts', 'a+b.(x).ts')).toBe(true);
    expect(matchGlob('a.ts', 'aXts')).toBe(false);
    expect(matchGlob('file[12].ts', 'file2.ts')).toBe(true);
    expect(matchGlob('file[!12].ts', 'file2.ts')).toBe(false);
  });

  it('нормалізує зворотні слеші й ./ у шляху', () => {
    expect(matchGlob('src/**', '.\\src\\a.ts')).toBe(true);
  });

  it('порожній шлях не збігається з конкретним шаблоном', () => {
    expect(matchGlob('src/*.ts', '')).toBe(false);
  });
});

describe('normalizePath / toRepoPath', () => {
  it('приводить шлях до вигляду з / без ./', () => {
    expect(normalizePath('./src//a/../b.ts')).toBe('src/b.ts');
    expect(normalizePath('src\\win\\a.ts')).toBe('src/win/a.ts');
    expect(normalizePath('')).toBe('');
  });

  it('відрізає корінь репо від абсолютного шляху, чужий абсолютний лишає', () => {
    expect(toRepoPath('/repo/src/a.ts', '/repo/')).toBe('src/a.ts');
    expect(toRepoPath('C:\\work\\repo\\src\\a.ts', 'c:/work/repo')).toBe('src/a.ts');
    expect(toRepoPath('/other/a.ts', '/repo')).toBe('/other/a.ts');
    expect(toRepoPath('/repository/a.ts', '/repo')).toBe('/repository/a.ts');
  });
});
