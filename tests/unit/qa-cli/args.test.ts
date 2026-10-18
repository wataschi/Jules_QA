import { describe, expect, it } from 'vitest';
import { UsageError } from '../../../src/qa-cli/commands/common.js';
import { parseArgs, runCli } from '../../../src/qa-cli/main.js';
import { makeCtx } from './_helpers.js';

const spec = { hub: 'string', force: 'boolean', check: 'list' } as const;

describe('qa-cli / розбір аргументів', () => {
  it('розбирає --k v, --k=v, булеві й повторювані прапорці', () => {
    const parsed = parseArgs(['reserve', '--hub', 'https://h', '--force', '--check=a', '--check', 'b', 'tail'], spec);
    expect(parsed.positionals).toEqual(['reserve', 'tail']);
    expect(parsed.flags).toEqual({ hub: 'https://h', force: true, check: ['a', 'b'] });
  });

  it('після -- усе йде в позиційні', () => {
    expect(parseArgs(['--', '--force'], spec).positionals).toEqual(['--force']);
  });

  it('порожній argv — порожній результат', () => {
    expect(parseArgs([], spec)).toEqual({ positionals: [], flags: {} });
  });

  it('невідомий прапорець і прапорець без значення — UsageError', () => {
    expect(() => parseArgs(['--nope'], spec)).toThrow(UsageError);
    expect(() => parseArgs(['--hub'], spec)).toThrow(/потрібне значення/);
    expect(() => parseArgs(['--hub', '--force'], spec)).toThrow(UsageError);
    expect(() => parseArgs(['--force=так'], spec)).toThrow(UsageError);
  });

  it('--help друкує перелік команд і повертає 0', async () => {
    const io = makeCtx();
    expect(await runCli(['--help'], io.ctx)).toBe(0);
    for (const name of ['init', 'manifest', 'sync', 'status', 'pr-comment', 'affected', 'hook', 'inbox', 'case', 'assert-guard', 'push-check', 'pr-event', 'import']) {
      expect(io.out()).toContain(name);
    }
  });

  it('довідка команди не виконує її', async () => {
    const io = makeCtx();
    expect(await runCli(['sync', '--help'], io.ctx)).toBe(0);
    expect(io.out()).toContain('sync [--event pr|main|local]');
  });

  it('невідома команда — код 1 і довідка в stderr', async () => {
    const io = makeCtx();
    expect(await runCli(['deploy'], io.ctx)).toBe(1);
    expect(io.err()).toContain('Невідома команда «deploy»');
  });

  it('помилка використання — код 1 і рядок використання', async () => {
    const io = makeCtx();
    expect(await runCli(['case', 'reserve', '--title', 'x'], io.ctx)).toBe(1);
    expect(io.err()).toContain('--section');
    expect(io.err()).toContain('Використання: jules-qa case reserve');
  });
});
