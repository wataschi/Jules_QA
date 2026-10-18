import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CliContext, ExecFn, ShellFn } from '../../../src/qa-cli/context.js';

export const FIXTURES = path.resolve(__dirname, '../../fixtures/qa-cli');

export function makeTempRepo(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jules-qa-cli-'));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

export function writeFile(root: string, rel: string, content: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
}

export function readFile(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf-8');
}

export function writeConfig(root: string, config: Record<string, unknown>): void {
  writeFile(root, 'qa/jules.config.json', JSON.stringify(config, null, 2));
}

export interface GitFake {
  changed?: string[];
  uncommitted?: string[];
  untracked?: string[];
  diff?: string;
  head?: string;
  branch?: string;
  message?: string;
  author?: { name: string; email: string };
  notRepo?: boolean;
}

/** Підробний git: відповідає на ті виклики, які робить `src/qa-cli/git.ts`. */
export function fakeGitExec(fake: GitFake = {}): ExecFn & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = (async (file: string, args: string[]) => {
    calls.push([file, ...args]);
    if (file !== 'git') return { code: 127, stdout: '', stderr: 'unknown' };
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
    if (fake.notRepo) return { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
    const [cmd, ...rest] = args;
    if (cmd === 'rev-parse' && rest[0] === '--is-inside-work-tree') return ok('true\n');
    if (cmd === 'rev-parse' && rest[0] === 'HEAD') return ok(`${fake.head ?? 'abc1234def5678'}\n`);
    if (cmd === 'rev-parse' && rest[0] === '--abbrev-ref') return ok(`${fake.branch ?? 'feature/acts'}\n`);
    if (cmd === 'diff' && rest.includes('--name-only')) {
      const last = rest[rest.length - 1]!;
      if (last.endsWith('...HEAD')) return ok((fake.changed ?? []).join('\n'));
      return ok((fake.uncommitted ?? []).join('\n'));
    }
    if (cmd === 'diff') return ok(fake.diff ?? '');
    if (cmd === 'ls-files') return ok((fake.untracked ?? []).join('\n'));
    if (cmd === 'log' && rest.includes('--format=%B')) return ok(`${fake.message ?? 'feat: акти'}\n`);
    if (cmd === 'log') return ok(`${fake.author?.name ?? 'Dev'}\n${fake.author?.email ?? 'dev@example.com'}\n`);
    return { code: 1, stdout: '', stderr: `unexpected git ${args.join(' ')}` };
  }) as unknown as ExecFn & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

export function fakeShell(result: { code: number; output?: string } = { code: 0 }): ShellFn & { commands: string[] } {
  const commands: string[] = [];
  const fn = (async (command: string) => {
    commands.push(command);
    return { code: result.code, output: result.output ?? '' };
  }) as unknown as ShellFn & { commands: string[] };
  fn.commands = commands;
  return fn;
}

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

type Responder = (call: FetchCall) => Response | Promise<Response>;

export function fakeFetch(responder: Responder): typeof fetch & { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return responder(call);
  }) as unknown as typeof fetch & { calls: FetchCall[] };
  fn.calls = calls;
  return fn;
}

export const offlineFetch = () =>
  fakeFetch(() => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  });

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export interface TestIo {
  ctx: Partial<CliContext>;
  out: () => string;
  err: () => string;
}

export function makeCtx(overrides: Partial<CliContext> & { stdin?: string } = {}): TestIo {
  let out = '';
  let err = '';
  const { stdin, ...rest } = overrides;
  return {
    ctx: {
      env: {},
      exec: fakeGitExec(),
      shell: fakeShell(),
      fetch: offlineFetch(),
      readStdin: async () => stdin ?? '',
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
      now: () => new Date('2026-10-18T12:00:00.000Z'),
      sleep: async () => {},
      selfPath: undefined,
      ...rest,
    },
    out: () => out,
    err: () => err,
  };
}
