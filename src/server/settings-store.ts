import fs from 'node:fs/promises';
import path from 'node:path';
import { getSettingsPath } from './data-paths.js';
import { defaultSettings, uiSettingsSchema, type UiSettings } from './types.js';

export { getSettingsPath };

export async function loadSettings(): Promise<UiSettings> {
  const fromEnv: UiSettings = {
    ...defaultSettings,
    qaTargetUrl: process.env.QA_TARGET_URL ?? defaultSettings.qaTargetUrl,
    qaMode: (process.env.QA_MODE as UiSettings['qaMode']) ?? defaultSettings.qaMode,
    qaScenarioPath: process.env.QA_SCENARIO_PATH ?? defaultSettings.qaScenarioPath,
    llmBaseUrl: process.env.MIDSCENE_MODEL_BASE_URL,
    llmModelName: process.env.MIDSCENE_MODEL_NAME,
  };

  try {
    const raw = await fs.readFile(getSettingsPath(), 'utf-8');
    return uiSettingsSchema.parse({ ...fromEnv, ...JSON.parse(raw) });
  } catch {
    return fromEnv;
  }
}

export async function saveSettings(settings: UiSettings): Promise<UiSettings> {
  const parsed = uiSettingsSchema.parse(settings);
  await fs.mkdir(path.dirname(getSettingsPath()), { recursive: true });
  await fs.writeFile(getSettingsPath(), JSON.stringify(parsed, null, 2), 'utf-8');
  return parsed;
}

export function applySettingsToProcessEnv(settings: UiSettings): void {
  process.env.QA_TARGET_URL = settings.qaTargetUrl;
  process.env.QA_MODE = settings.qaMode;
  process.env.QA_SCENARIO_PATH = settings.qaScenarioPath;
  process.env.DEBUG = settings.debugCache ? 'midscene:cache:*' : '';
}
