import path from 'node:path';

export function getDataRoot(): string {
  return process.env.DATA_ROOT ?? path.join(process.cwd(), 'data');
}

export function getRunsDir(): string {
  return path.join(getDataRoot(), 'runs');
}

export function getSettingsPath(): string {
  return path.join(getDataRoot(), 'settings.json');
}

export function getSuitesDir(): string {
  return path.join(getDataRoot(), 'suites');
}

export function getScenariosDir(): string {
  return process.env.SCENARIOS_ROOT ?? path.join(process.cwd(), 'scenarios');
}

export function getMidsceneRunRoot(): string {
  return process.env.MIDSCENE_RUN_ROOT ?? path.join(process.cwd(), 'midscene_run');
}

export function getPlansDir(): string {
  return path.join(getMidsceneRunRoot(), 'plans');
}

/** Structured per-step/per-assertion run results (evidence packs). */
export function getResultsDir(): string {
  return path.join(getMidsceneRunRoot(), 'results');
}

/** Structured bug reports produced when an assertion reveals an app defect. */
export function getBugReportsDir(): string {
  return path.join(getMidsceneRunRoot(), 'bug-reports');
}

/** Deterministic Playwright specs transpiled from warm-up cache. */
export function getGeneratedDir(): string {
  return process.env.GENERATED_DIR ?? path.join(process.cwd(), 'generated');
}

export function getMidsceneCacheDir(): string {
  return path.join(getMidsceneRunRoot(), 'cache');
}

export function getSecretsVaultPath(): string {
  return path.join(getDataRoot(), 'secrets.vault');
}

export function getAuthProfilesDir(): string {
  return path.join(getDataRoot(), 'auth-profiles');
}

export function getStorageStatesDir(): string {
  return path.join(getDataRoot(), 'storage-states');
}

export function getHitlControlDir(): string {
  return path.join(getMidsceneRunRoot(), 'control');
}
