/**
 * Виклики git для CLI: змінені файли, unified diff відносно бази, SHA, гілка, автор коміту.
 * Лише `execFile` без оболонки, щоб назви гілок і шляхи не інтерпретувалися як команди.
 */
import type { ExecFn } from './context.js';

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

export interface Git {
  isRepo(): Promise<boolean>;
  /** Файли, змінені відносно бази (коміти гілки + незакомічене + untracked), без видалених. */
  changedFiles(base: string): Promise<string[]>;
  /** Unified diff `base...HEAD`; бази немає — diff незакоміченого відносно HEAD. */
  diff(base: string): Promise<string>;
  head(): Promise<string>;
  branch(): Promise<string>;
  commitMessage(sha: string): Promise<string>;
  commitAuthor(sha: string): Promise<{ name: string; email: string }>;
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function createGit(exec: ExecFn, cwd: string): Git {
  async function git(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    const result = await exec('git', args, { cwd, timeoutMs: 60_000 });
    return { ok: result.code === 0, stdout: result.stdout, stderr: result.stderr };
  }

  async function must(args: string[]): Promise<string> {
    const result = await git(args);
    if (!result.ok) {
      throw new GitError(`git ${args.join(' ')} завершився з помилкою: ${result.stderr.trim() || 'без виводу'}`);
    }
    return result.stdout;
  }

  return {
    async isRepo() {
      const result = await git(['rev-parse', '--is-inside-work-tree']);
      return result.ok && result.stdout.trim() === 'true';
    },

    async changedFiles(base) {
      const files = new Set<string>();
      // Кожна частина опційна: бази може не бути (локальна гілка без origin), HEAD — теж (порожнє репо).
      const committed = await git(['diff', '--name-only', '--diff-filter=d', '--no-renames', `${base}...HEAD`]);
      if (committed.ok) lines(committed.stdout).forEach((f) => files.add(f));
      const uncommitted = await git(['diff', '--name-only', '--diff-filter=d', '--no-renames', 'HEAD']);
      if (uncommitted.ok) lines(uncommitted.stdout).forEach((f) => files.add(f));
      else {
        const staged = await git(['diff', '--name-only', '--diff-filter=d', '--cached']);
        if (staged.ok) lines(staged.stdout).forEach((f) => files.add(f));
      }
      const untracked = await git(['ls-files', '--others', '--exclude-standard']);
      if (untracked.ok) lines(untracked.stdout).forEach((f) => files.add(f));
      return [...files].sort();
    },

    async diff(base) {
      const args = ['diff', '--no-color', '--no-ext-diff', '-M'];
      const ranged = await git([...args, `${base}...HEAD`]);
      if (ranged.ok) return ranged.stdout;
      return must([...args, 'HEAD']);
    },

    async head() {
      return (await must(['rev-parse', 'HEAD'])).trim();
    },

    async branch() {
      return (await must(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    },

    async commitMessage(sha) {
      return (await must(['log', '-1', '--format=%B', sha])).trim();
    },

    async commitAuthor(sha) {
      const [name = '', email = ''] = (await must(['log', '-1', '--format=%an%n%ae', sha])).split('\n');
      return { name: name.trim(), email: email.trim() };
    },
  };
}
