/**
 * Залежності CLI `jules-qa`, які підміняються в тестах: оточення, fetch, запуск процесів,
 * stdin/stdout і годинник. Команди отримують усе через `CliContext` і не торкаються
 * `process` напряму — так їх можна перевіряти без окремого процесу.
 */
import { execFile, spawn } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Запуск програми без оболонки (git, тощо). Ненульовий код — не виняток, а `code`. */
export type ExecFn = (
  file: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number },
) => Promise<ExecResult>;

/** Запуск рядка-команди з конфігу (`npx vitest run …`) через оболонку; вивід — злитий. */
export type ShellFn = (
  command: string,
  opts: { cwd: string; timeoutMs?: number; env?: Record<string, string | undefined> },
) => Promise<{ code: number; output: string }>;

export type Env = Record<string, string | undefined>;

export interface CliContext {
  cwd: string;
  env: Env;
  fetch: typeof fetch;
  exec: ExecFn;
  shell: ShellFn;
  readStdin: () => Promise<string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  now: () => Date;
  /** Шлях до зібраного бандла, який `init` копіює в `qa/bin/`. */
  selfPath?: string;
  /** Пауза між повторами на 429; у тестах — миттєва. */
  sleep: (ms: number) => Promise<void>;
}

const MAX_BUFFER = 64 * 1024 * 1024;

export const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 60_000, maxBuffer: MAX_BUFFER, encoding: 'utf-8' },
      (error, stdout, stderr) => {
        const code =
          error == null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? Number((error as { code: number }).code) : 127;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? error?.message ?? '') });
      },
    );
  });

export const defaultShell: ShellFn = (command, opts) =>
  new Promise((resolve) => {
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const collect = (chunk: Buffer) => {
      // Хвіст важливіший за початок: тримаємо останні ~MAX_BUFFER байт.
      chunks.push(chunk);
      size += chunk.length;
      while (size > MAX_BUFFER && chunks.length > 1) size -= chunks.shift()!.length;
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          chunks.push(Buffer.from(`\n[jules-qa] команду зупинено за таймаутом ${opts.timeoutMs} мс\n`));
          child.kill('SIGTERM');
        }, opts.timeoutMs)
      : null;
    const finish = (code: number) => {
      if (timer) clearTimeout(timer);
      resolve({ code, output: Buffer.concat(chunks).toString('utf-8') });
    };
    child.on('error', (error) => {
      chunks.push(Buffer.from(String(error.message)));
      finish(127);
    });
    child.on('close', (code, signal) => finish(code ?? (signal ? 1 : 0)));
  });

async function readProcessStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8');
}

export function createDefaultContext(overrides: Partial<CliContext> = {}): CliContext {
  return {
    cwd: process.cwd(),
    env: process.env,
    fetch: globalThis.fetch.bind(globalThis),
    exec: defaultExec,
    shell: defaultShell,
    readStdin: readProcessStdin,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    now: () => new Date(),
    selfPath: process.argv[1],
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...overrides,
  };
}

/** Рядок у stdout із переведенням рядка. */
export function println(ctx: CliContext, line = ''): void {
  ctx.stdout(`${line}\n`);
}

export function eprintln(ctx: CliContext, line = ''): void {
  ctx.stderr(`${line}\n`);
}
