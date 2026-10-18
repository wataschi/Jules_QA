/**
 * `jules-qa sync` — результати прогону, покриття, мутації й зміни асертів → `POST /ingest/run`.
 *
 * SHA, гілка й номер PR за замовчуванням беруться з оточення GitHub Actions (на PR — head
 * гілки, а не merge-коміт, який GitHub створює для прогону), поза CI — з git. Результати
 * `local` до статусу не потрапляють; офіційні лише `ci`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { analyzeAssertionChanges, type AssertionChange, type FileCoverage, type Manifest, type MutationFile, buildManifest } from '../../ingest/index.js';
import { CONFIG_PATH, loadConfig, type ResolvedConfig } from '../config.js';
import { eprintln, println, type CliContext } from '../context.js';
import { createGit } from '../git.js';
import { collectCoverage, collectMutation, collectTestResults, toIngestResults, type IngestResult } from '../reports.js';
import { MANIFEST_PATH } from './manifest.js';
import {
  flagInt,
  flagString,
  githubRunUrl,
  hubFor,
  isGithubActions,
  readGithubEvent,
  UsageError,
  type CommandHandler,
} from './common.js';

export type SyncEvent = 'pr' | 'main' | 'local';
export type SyncSource = 'ci' | 'local';

export interface IngestRunBody {
  projectId?: string;
  repo?: string;
  sha: string;
  branch: string;
  prNumber?: number;
  event: SyncEvent;
  source: SyncSource;
  runUrl?: string;
  startedAt?: string;
  finishedAt?: string;
  manifest?: Manifest;
  results: IngestResult[];
  coverage?: FileCoverage[];
  mutation?: MutationFile[];
  assertionChanges?: AssertionChange[];
}

export interface IngestRunResponse {
  runId: string | number;
  tests: number;
  failed: number;
  unknownCases: string[];
}

export interface SyncOptions {
  event?: string;
  source?: string;
  sha?: string;
  branch?: string;
  prNumber?: number;
  runUrl?: string;
  base?: string;
}

function pick<T extends string>(value: string | undefined, allowed: readonly T[], name: string): T | undefined {
  if (value === undefined) return undefined;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new UsageError(`--${name} має бути одним із: ${allowed.join(', ')}; отримано «${value}».`);
}

/** Збирає тіло `POST /ingest/run` без відправки (окремо — для тестів і `--dry-run`). */
export async function buildSyncBody(ctx: CliContext, config: ResolvedConfig, opts: SyncOptions): Promise<{ body: IngestRunBody; warnings: string[] }> {
  const env = ctx.env;
  const ghEvent = readGithubEvent(env, ctx.cwd);
  const pr = ghEvent?.pull_request;
  const inCi = isGithubActions(env);
  const git = createGit(ctx.exec, config.root);

  const event =
    pick(opts.event, ['pr', 'main', 'local'] as const, 'event') ??
    (env.GITHUB_EVENT_NAME?.startsWith('pull_request') ? 'pr' : env.GITHUB_EVENT_NAME === 'push' ? 'main' : 'local');
  const source = pick(opts.source, ['ci', 'local'] as const, 'source') ?? (inCi ? 'ci' : 'local');

  const sha = opts.sha ?? pr?.head?.sha ?? env.GITHUB_SHA ?? (await git.head());
  const branch =
    opts.branch ?? (pr?.head?.ref || env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || (await git.branch()));
  const prNumber = opts.prNumber ?? (event === 'pr' ? (pr?.number ?? ghEvent?.number) : undefined);

  const warnings: string[] = [];
  const tests = collectTestResults(config.root, config.reports.tests);
  warnings.push(...tests.warnings.map((w) => `${w.file}: ${w.message}`));
  if (!tests.files.length) {
    throw new UsageError(
      `Звітів тестів не знайдено за шаблонами ${config.reports.tests.join(', ') || '(порожньо)'} з ${CONFIG_PATH}. ` +
        'Перевірте, що раннер пише звіт (наприклад, JUnit XML) і шлях у reports.tests.',
    );
  }
  const levels = { levels: config.levels };
  const results = toIngestResults(tests.results, levels);

  const coverage = collectCoverage(config.root, config.reports.coverage);
  const mutation = collectMutation(config.root, config.reports.mutation);
  warnings.push(...coverage.warnings.map((w) => `${w.file}: ${w.message}`));
  warnings.push(...mutation.warnings.map((w) => `${w.file}: ${w.message}`));

  // Закомічений маніфест — джерело правди для зв'язків; без нього будуємо зі звітів.
  let manifest: Manifest | undefined;
  const manifestFile = path.join(config.root, MANIFEST_PATH);
  if (fs.existsSync(manifestFile)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8')) as Manifest;
    } catch {
      warnings.push(`${MANIFEST_PATH}: не JSON, відправляємо маніфест, зібраний зі звітів`);
    }
  }
  manifest ??= buildManifest(tests.results, levels);

  let assertionChanges: AssertionChange[] | undefined;
  if (event === 'pr') {
    const base = opts.base ?? 'origin/main';
    try {
      assertionChanges = analyzeAssertionChanges(await git.diff(base), { testFileGlobs: config.testFileGlobs });
    } catch (error) {
      warnings.push(`зміни асертів не пораховано: ${(error as Error).message}`);
    }
  }

  const body: IngestRunBody = {
    projectId: config.projectId,
    repo: env.GITHUB_REPOSITORY || undefined,
    sha,
    branch,
    prNumber,
    event,
    source,
    runUrl: opts.runUrl ?? githubRunUrl(env),
    finishedAt: ctx.now().toISOString(),
    manifest,
    results,
    coverage: coverage.coverage.length ? coverage.coverage : undefined,
    mutation: mutation.mutation.length ? mutation.mutation : undefined,
    assertionChanges,
  };
  for (const key of Object.keys(body) as (keyof IngestRunBody)[]) if (body[key] === undefined) delete body[key];
  return { body, warnings };
}

export const syncCommand: CommandHandler = async (ctx: CliContext, args) => {
  const config = loadConfig({ cwd: ctx.cwd, env: ctx.env });
  const { body, warnings } = await buildSyncBody(ctx, config, {
    event: flagString(args, 'event'),
    source: flagString(args, 'source'),
    sha: flagString(args, 'sha'),
    branch: flagString(args, 'branch'),
    prNumber: flagInt(args, 'pr'),
    runUrl: flagString(args, 'run-url'),
    base: flagString(args, 'base'),
  });
  for (const warning of warnings) eprintln(ctx, `Попередження: ${warning}`);

  const hub = hubFor(ctx, config, { timeoutMs: 60_000 });
  const response = await hub.postJson<IngestRunResponse>('/ingest/run', body);
  println(
    ctx,
    `Jules: прогін ${response.runId} (${body.event}/${body.source}, ${body.branch} @ ${body.sha.slice(0, 7)}): ` +
      `тестів ${response.tests}, впало ${response.failed}.`,
  );
  if (response.unknownCases?.length) {
    println(ctx, `Невідомі ID кейсів у назвах тестів: ${response.unknownCases.join(', ')}`);
  }
  if (body.assertionChanges?.length) {
    println(ctx, `Змінені наявні асерти: ${body.assertionChanges.length} (PR отримає мітку qa:assertion-change).`);
  }
  return 0;
};
