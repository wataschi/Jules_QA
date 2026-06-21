import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface TempWorkspace {
  root: string;
  dataDir: string;
  scenariosDir: string;
  midsceneDir: string;
  cleanup: () => Promise<void>;
}

export async function createTempWorkspace(): Promise<TempWorkspace> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jules-qa-'));
  const dataDir = path.join(root, 'data');
  const scenariosDir = path.join(root, 'scenarios');
  const midsceneDir = path.join(root, 'midscene_run');

  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(path.join(dataDir, 'runs'), { recursive: true });
  await fs.mkdir(path.join(dataDir, 'suites'), { recursive: true });
  await fs.mkdir(scenariosDir, { recursive: true });
  await fs.mkdir(path.join(midsceneDir, 'plans'), { recursive: true });
  await fs.mkdir(path.join(midsceneDir, 'aggregate'), { recursive: true });

  return {
    root,
    dataDir,
    scenariosDir,
    midsceneDir,
    cleanup: async () => {
      try {
        await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        /* ignore EBUSY on Windows */
      }
    },
  };
}

export function applyWorkspaceEnv(ws: TempWorkspace): void {
  process.env.DATA_ROOT = ws.dataDir;
  process.env.SCENARIOS_ROOT = ws.scenariosDir;
  process.env.MIDSCENE_RUN_ROOT = ws.midsceneDir;
  process.env.QA_TEST_MOCK_RUNNER = '1';
  process.env.QA_TEST_MOCK_EXIT_CODE = '0';
}

export function clearWorkspaceEnv(): void {
  delete process.env.DATA_ROOT;
  delete process.env.SCENARIOS_ROOT;
  delete process.env.MIDSCENE_RUN_ROOT;
  delete process.env.QA_TEST_MOCK_RUNNER;
  delete process.env.QA_TEST_MOCK_EXIT_CODE;
}

export async function writeScenario(
  ws: TempWorkspace,
  filename: string,
  content: Record<string, unknown>,
): Promise<string> {
  const { stringify } = await import('yaml');
  const filePath = path.join(ws.scenariosDir, filename);
  await fs.writeFile(filePath, stringify(content, { lineWidth: 0 }), 'utf-8');
  return `scenarios/${filename}`;
}
