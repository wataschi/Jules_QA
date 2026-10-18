/**
 * Команди для подій GitHub у CI продукту:
 *  - `push-check` — на push у main: чи прийшов коміт через злитий PR (гілки не захищені,
 *    тож це єдиний спосіб помітити пуш агента повз PR) → `POST /ingest/push-check`;
 *  - `pr-event --state merged|closed|opened` — подія PR із `GITHUB_EVENT_PATH` → `POST /ingest/pr-event`.
 */
import { loadConfig } from '../config.js';
import { eprintln, println, type CliContext } from '../context.js';
import { createGit } from '../git.js';
import { HubUnavailable } from '../hub.js';
import { registerSecret } from '../../integrations/errors.js';
import { flagInt, flagString, hubFor, readGithubEvent, UsageError, type CommandHandler } from './common.js';

const SKIP_CI_RE = /\[(skip ci|ci skip|no ci|skip actions|actions skip)\]/i;
const GITHUB_TIMEOUT_MS = 15_000;

export interface PushCheckBody {
  projectId?: string;
  sha: string;
  branch: string;
  viaPr: boolean;
  prNumbers: number[];
  author?: string;
}

interface GithubPull {
  number: number;
  merged_at?: string | null;
  state?: string;
  base?: { ref?: string };
}

/** PR, через які коміт потрапив у гілку: `GET /repos/{repo}/commits/{sha}/pulls`. */
export async function findMergedPulls(opts: {
  fetch: typeof fetch;
  apiUrl?: string;
  repository: string;
  sha: string;
  token?: string;
  branch?: string;
}): Promise<number[]> {
  const api = (opts.apiUrl || 'https://api.github.com').replace(/\/+$/, '');
  registerSecret(opts.token);
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'jules-qa',
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const url = `${api}/repos/${opts.repository}/commits/${encodeURIComponent(opts.sha)}/pulls?per_page=100`;
  let response: Response;
  try {
    response = await opts.fetch(url, { headers, signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`GitHub API недоступний: ${(error as Error).message}`);
  }
  if (!response.ok) {
    const text = (await response.text().catch(() => '')).slice(0, 300);
    throw new Error(`GitHub API відповів ${response.status} на ${url.replace(api, '')}: ${text}`);
  }
  const pulls = (await response.json()) as GithubPull[];
  return (Array.isArray(pulls) ? pulls : [])
    .filter((pull) => Boolean(pull.merged_at) && (!opts.branch || !pull.base?.ref || pull.base.ref === opts.branch))
    .map((pull) => pull.number)
    .sort((a, b) => a - b);
}

export const pushCheckCommand: CommandHandler = async (ctx: CliContext, args) => {
  const env = ctx.env;
  const config = loadConfig({ cwd: ctx.cwd, env });
  const event = readGithubEvent(env, ctx.cwd);
  const git = createGit(ctx.exec, config.root);
  const sha = flagString(args, 'sha') ?? env.GITHUB_SHA ?? (await git.head());
  const branch = flagString(args, 'branch') ?? env.GITHUB_REF_NAME ?? (await git.branch());

  const message =
    (event?.head_commit?.id === sha || !event?.head_commit?.id ? event?.head_commit?.message : undefined) ??
    (await git.commitMessage(sha).catch(() => ''));
  // Бот комітить QA_STATUS.md з [skip ci] — це не пуш повз PR.
  if (SKIP_CI_RE.test(message)) {
    println(ctx, `Коміт ${sha.slice(0, 7)} з [skip ci] — перевірку пропущено.`);
    return 0;
  }

  const repository = env.GITHUB_REPOSITORY;
  if (!repository) throw new UsageError('push-check працює в GitHub Actions: потрібна змінна GITHUB_REPOSITORY (owner/name).');
  const prNumbers = await findMergedPulls({
    fetch: ctx.fetch,
    apiUrl: env.GITHUB_API_URL,
    repository,
    sha,
    token: env.GITHUB_TOKEN,
    branch,
  });

  const author =
    event?.head_commit?.author?.username ||
    event?.head_commit?.author?.email ||
    event?.pusher?.name ||
    (await git.commitAuthor(sha).then((a) => a.email || a.name).catch(() => '')) ||
    undefined;

  const body: PushCheckBody = {
    ...(config.projectId ? { projectId: config.projectId } : {}),
    sha,
    branch,
    viaPr: prNumbers.length > 0,
    prNumbers,
    ...(author ? { author } : {}),
  };
  const response = await hubFor(ctx, config).postJson<{ ok: boolean; flagged: boolean }>('/ingest/push-check', body);
  if (body.viaPr) println(ctx, `Коміт ${sha.slice(0, 7)} прийшов через PR #${prNumbers.join(', #')}.`);
  else eprintln(ctx, `Коміт ${sha.slice(0, 7)} у ${branch} без PR${author ? ` (${author})` : ''}${response.flagged ? ' — позначено в Jules' : ''}.`);
  return 0;
};

export type PrState = 'opened' | 'merged' | 'closed';

export const prEventCommand: CommandHandler = async (ctx: CliContext, args) => {
  const event = readGithubEvent(ctx.env, ctx.cwd);
  const pr = event?.pull_request;
  const stateFlag = flagString(args, 'state');
  if (stateFlag && !['opened', 'merged', 'closed'].includes(stateFlag)) {
    throw new UsageError('--state має бути одним із: opened, merged, closed');
  }
  const state: PrState | undefined =
    (stateFlag as PrState | undefined) ??
    (event?.action === 'closed' ? (pr?.merged ? 'merged' : 'closed') : event?.action && ['opened', 'reopened'].includes(event.action) ? 'opened' : undefined);
  if (!state) throw new UsageError('Вкажіть --state merged|closed|opened (або запускайте на події pull_request).');
  const prNumber = flagInt(args, 'pr') ?? pr?.number ?? event?.number;
  if (!prNumber) throw new UsageError('Немає номера PR: запускайте на події pull_request або вкажіть --pr <N>.');

  const config = loadConfig({ cwd: ctx.cwd, env: ctx.env });
  const body = {
    ...(config.projectId ? { projectId: config.projectId } : {}),
    prNumber,
    state,
    ...(pr?.head?.sha ? { sha: pr.head.sha } : {}),
    ...(pr?.head?.ref ? { headBranch: pr.head.ref } : {}),
    ...(pr?.title ? { title: pr.title } : {}),
    ...(pr?.html_url ? { url: pr.html_url } : {}),
  };
  try {
    const response = await hubFor(ctx, config).postJson<{ ok: boolean; tasksUpdated: number }>('/ingest/pr-event', body);
    println(ctx, `Jules: PR #${prNumber} ${state}, оновлено задач: ${response.tasksUpdated ?? 0}.`);
  } catch (error) {
    if (error instanceof HubUnavailable) {
      eprintln(ctx, error.message);
      return 1;
    }
    throw error;
  }
  return 0;
};
