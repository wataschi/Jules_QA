import fs from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { scenarioYamlSchema, type ScenarioYaml } from '../planning/types.js';
import { getScenariosDir } from './data-paths.js';

function scenariosDir(): string {
  return getScenariosDir();
}

export function resolveScenarioPath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  const base = scenariosDir();
  if (normalized.startsWith('scenarios/')) {
    return path.join(base, path.basename(normalized));
  }
  const resolved = path.resolve(process.cwd(), relativePath);
  assertUnderScenariosDir(resolved);
  return resolved;
}

function assertUnderScenariosDir(fullPath: string): void {
  const rel = path.relative(scenariosDir(), path.resolve(fullPath));
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Invalid scenario path');
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function filePathForName(name: string): string {
  const safe = slugify(name);
  if (!safe) throw new Error('Invalid scenario name');
  return path.join(scenariosDir(), `${safe}.yaml`);
}

export interface ScenarioMeta {
  path: string;
  name: string;
  goal: string;
  targetUrl?: string;
  tags?: string[];
  group?: string;
  updatedAt?: string;
}

export async function listScenarioDetails(): Promise<ScenarioMeta[]> {
  await fs.mkdir(scenariosDir(), { recursive: true });
  const files = await fs.readdir(scenariosDir());
  const result: ScenarioMeta[] = [];

  for (const file of files.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))) {
    try {
      const full = path.join(scenariosDir(), file);
      const stat = await fs.stat(full);
      const raw = await fs.readFile(full, 'utf-8');
      const parsed = scenarioYamlSchema.parse(parse(raw));
      result.push({
        path: `scenarios/${file}`,
        name: parsed.name,
        goal: parsed.goal,
        targetUrl: parsed.target_url,
        tags: parsed.tags,
        group: parsed.group,
        updatedAt: stat.mtime.toISOString(),
      });
    } catch {
      /* skip invalid */
    }
  }

  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getScenarioByPath(relativePath: string): Promise<ScenarioYaml & { path: string; raw: string }> {
  const full = resolveScenarioPath(relativePath);
  const raw = await fs.readFile(full, 'utf-8');
  const parsed = scenarioYamlSchema.parse(parse(raw));
  return { ...parsed, path: relativePath.replace(/\\/g, '/'), raw };
}

export async function getScenarioBySlug(slug: string): Promise<ScenarioYaml & { path: string; raw: string }> {
  const file = `${slugify(slug)}.yaml`;
  return getScenarioByPath(`scenarios/${file}`);
}

export async function saveScenario(data: ScenarioYaml, existingPath?: string): Promise<{ path: string; name: string }> {
  const parsed = scenarioYamlSchema.parse(data);
  await fs.mkdir(scenariosDir(), { recursive: true });

  let targetPath: string;
  if (existingPath) {
    targetPath = resolveScenarioPath(existingPath);
  } else {
    targetPath = filePathForName(parsed.name);
  }

  const yamlBody = stringify(parsed, { lineWidth: 0 });
  await fs.writeFile(targetPath, yamlBody, 'utf-8');

  const relative = `scenarios/${path.basename(targetPath)}`.replace(/\\/g, '/');
  return { path: relative, name: parsed.name };
}

export async function deleteScenario(relativePath: string): Promise<void> {
  const full = resolveScenarioPath(relativePath);
  await fs.unlink(full);
}

export function emptyScenarioTemplate(): ScenarioYaml {
  return {
    name: 'new-scenario',
    goal: 'Опишіть мету тесту природною мовою',
    tags: [],
    hints: [],
    steps: [],
    checkpoints: [],
    success_criteria: [],
    navigation: { type: 'deterministic' },
  };
}
