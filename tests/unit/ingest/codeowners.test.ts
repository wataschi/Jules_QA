import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ownersForPath, parseCodeowners } from '../../../src/ingest/index.js';

const text = readFileSync(path.resolve(import.meta.dirname, '../../fixtures/ingest/CODEOWNERS'), 'utf-8');

describe('parseCodeowners', () => {
  const rules = parseCodeowners(text);

  it('пропускає коментарі й порожні рядки, прибирає хвостові коментарі', () => {
    expect(rules).toHaveLength(10);
    expect(rules[0]).toEqual({ pattern: '*', owners: ['@cyber/core'] });
    expect(rules[7]).toEqual({ pattern: '/build/logs/', owners: ['@cyber/infra'] });
  });

  it('розуміє екранований # і правило без власників', () => {
    expect(rules[8]).toEqual({ pattern: '#weird-file', owners: ['@cyber/core'] });
    expect(rules[9]).toEqual({ pattern: '/vendor/', owners: [] });
  });

  it('для порожнього тексту повертає порожній список', () => {
    expect(parseCodeowners('')).toEqual([]);
    expect(parseCodeowners('# лише коментар\n\n')).toEqual([]);
  });
});

describe('ownersForPath', () => {
  const rules = parseCodeowners(text);

  it('останнє збігле правило перемагає', () => {
    expect(ownersForPath(rules, 'README.md')).toEqual(['@cyber/core']);
    expect(ownersForPath(rules, 'backend/app/acts.py')).toEqual(['@cyber/backend']);
    expect(ownersForPath(rules, 'src/acts/acts.py')).toEqual(['@cyber/acts', '@alice']);
    expect(ownersForPath(rules, 'src/acts/legacy/old/a.ts')).toEqual(['@bob']);
  });

  it('ведучий / — лише від кореня, dir/ — каталог із вмістом', () => {
    expect(ownersForPath(rules, 'docs/guide/setup.md')).toEqual(['@cyber/docs']);
    expect(ownersForPath(rules, 'pkg/docs/guide/setup.md')).toEqual(['@cyber/core']);
    expect(ownersForPath(rules, 'build/logs/2026/x.log')).toEqual(['@cyber/infra']);
    expect(ownersForPath(rules, 'tools/build/logs/x.log')).toEqual(['@cyber/core']);
  });

  it('шаблон без ведучого / збігається будь-де', () => {
    expect(ownersForPath(rules, 'apps/web/index.ts')).toEqual(['@cyber/apps']);
    expect(ownersForPath(rules, 'packages/apps/web/index.ts')).toEqual(['@cyber/apps']);
  });

  it('docs/* — лише файли безпосередньо в каталозі', () => {
    expect(ownersForPath(rules, 'docs/intro.md')).toEqual(['docs@example.com']);
    expect(ownersForPath(rules, 'docs/guide/setup.md')).toEqual(['@cyber/docs']);
  });

  it('правило без власників знімає власність', () => {
    expect(ownersForPath(rules, 'vendor/lib/a.js')).toEqual([]);
  });

  it('без правил власників немає', () => {
    expect(ownersForPath([], 'src/a.ts')).toEqual([]);
  });

  it('шаблон без слеша без * збігається і з файлом, і з каталогом', () => {
    const local = parseCodeowners('Makefile @build\nconfig @ops\n');
    expect(ownersForPath(local, 'tools/Makefile')).toEqual(['@build']);
    expect(ownersForPath(local, 'apps/config/prod.json')).toEqual(['@ops']);
    expect(ownersForPath(local, 'apps/configs/prod.json')).toEqual([]);
  });
});
