import fs from 'node:fs/promises';
import path from 'node:path';
import { getRunsDir } from './data-paths.js';
import { redactText } from '../security/redact.js';
import { runRecordSchema, type RunRecord, type RunStatus } from './types.js';

function runsDir(): string {
  return getRunsDir();
}
const writeChains = new Map<string, Promise<void>>();

export async function ensureRunsDir(): Promise<void> {
  await fs.mkdir(runsDir(), { recursive: true });
}

function runFilePath(id: string): string {
  return path.join(runsDir(), `${id}.json`);
}

async function withRunWriteLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(id) ?? Promise.resolve();
  let result!: T;
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      result = await fn();
    });
  writeChains.set(id, next.then(() => undefined));
  await next;
  return result;
}

export async function saveRun(run: RunRecord): Promise<void> {
  await withRunWriteLock(run.id, async () => {
    await writeRunFile(run);
  });
}

export async function getRun(id: string): Promise<RunRecord | null> {
  return readRunWithRetry(id);
}

export async function listRuns(limit = 50): Promise<RunRecord[]> {
  await ensureRunsDir();
  const files = await fs.readdir(runsDir());
  const runs: RunRecord[] = [];

  for (const file of files.filter((f) => f.endsWith('.json')).slice(0, limit * 2)) {
    try {
      const raw = await fs.readFile(path.join(runsDir(), file), 'utf-8');
      runs.push(runRecordSchema.parse(JSON.parse(raw)));
    } catch {
      /* skip corrupt */
    }
  }

  return runs
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, limit);
}

export async function appendRunLog(id: string, line: string): Promise<void> {
  await withRunWriteLock(id, async () => {
    const run = await readRunUnsafe(id);
    if (!run) return;
    run.logs.push(redactText(line));
    await writeRunFile(run);
  });
}

export async function updateRunStatus(
  id: string,
  patch: Partial<Pick<RunRecord, 'status' | 'finishedAt' | 'exitCode' | 'errorSummary' | 'reportPaths' | 'scenarioName' | 'hitlReason'>>,
): Promise<RunRecord | null> {
  return withRunWriteLock(id, async () => {
    const run = await readRunUnsafe(id);
    if (!run) return null;
    Object.assign(run, patch);
    await writeRunFile(run);
    return run;
  });
}

export async function patchRun(id: string, mutator: (run: RunRecord) => void): Promise<RunRecord | null> {
  return withRunWriteLock(id, async () => {
    const run = await readRunUnsafe(id);
    if (!run) return null;
    mutator(run);
    await writeRunFile(run);
    return run;
  });
}

async function writeRunFile(run: RunRecord): Promise<void> {
  await ensureRunsDir();
  const target = runFilePath(run.id);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(run, null, 2), 'utf-8');
  await fs.rename(tmp, target);
}

async function readRunUnsafe(id: string): Promise<RunRecord | null> {
  try {
    const raw = await fs.readFile(runFilePath(id), 'utf-8');
    return runRecordSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function readRunWithRetry(id: string, attempts = 3): Promise<RunRecord | null> {
  for (let i = 0; i < attempts; i++) {
    const run = await readRunUnsafe(id);
    if (run) return run;
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, 25 * (i + 1)));
    }
  }
  return null;
}

export { getRunsDir as RUNS_DIR };
