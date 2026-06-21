import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getSuitesDir } from './data-paths.js';
import { suiteDefinitionSchema, type SuiteDefinition } from './types.js';

function suitesDir(): string {
  return getSuitesDir();
}

function suiteFilePath(id: string): string {
  const safe = id.replace(/[^a-z0-9-]/gi, '').slice(0, 80);
  if (!safe) throw new Error('Invalid suite id');
  return path.join(suitesDir(), `${safe}.json`);
}

export async function ensureSuitesDir(): Promise<void> {
  await fs.mkdir(suitesDir(), { recursive: true });
}

export async function listSuites(): Promise<SuiteDefinition[]> {
  await ensureSuitesDir();
  const files = await fs.readdir(suitesDir());
  const suites: SuiteDefinition[] = [];

  for (const file of files.filter((f) => f.endsWith('.json'))) {
    try {
      const raw = await fs.readFile(path.join(suitesDir(), file), 'utf-8');
      suites.push(suiteDefinitionSchema.parse(JSON.parse(raw)));
    } catch {
      /* skip invalid */
    }
  }

  return suites.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getSuite(id: string): Promise<SuiteDefinition | null> {
  try {
    const raw = await fs.readFile(suiteFilePath(id), 'utf-8');
    return suiteDefinitionSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function saveSuite(data: Omit<SuiteDefinition, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<SuiteDefinition> {
  await ensureSuitesDir();
  const now = new Date().toISOString();
  const existing = data.id ? await getSuite(data.id) : null;

  const suite: SuiteDefinition = suiteDefinitionSchema.parse({
    id: data.id ?? existing?.id ?? randomUUID().slice(0, 8),
    name: data.name,
    description: data.description ?? '',
    scenarioPaths: data.scenarioPaths,
    stopOnFailure: data.stopOnFailure ?? true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });

  await fs.writeFile(suiteFilePath(suite.id), JSON.stringify(suite, null, 2), 'utf-8');
  return suite;
}

export async function deleteSuite(id: string): Promise<void> {
  await fs.unlink(suiteFilePath(id));
}

export function emptySuiteTemplate(): Omit<SuiteDefinition, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: 'new-suite',
    description: 'Опишіть призначення набору сценаріїв',
    scenarioPaths: [],
    stopOnFailure: true,
  };
}
