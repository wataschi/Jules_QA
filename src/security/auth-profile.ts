import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { getAuthProfilesDir, getStorageStatesDir } from '../server/data-paths.js';

export const SECRET_REF_PATTERN = /\{\{secret:([^.}]+)\.([^}]+)\}\}/g;

export const authProfileSchema = z.object({
  id: z.string().min(1),
  loginUrl: z.string().url(),
  steps: z.array(z.string()).min(1),
  storageStatePath: z.string().optional(),
  sessionTtlMinutes: z.number().int().positive().default(60),
  validityCheck: z
    .object({
      url: z.string().url().optional(),
      assertion: z.string().optional(),
    })
    .optional(),
});

export type AuthProfile = z.infer<typeof authProfileSchema>;

export interface ResolvedSecretRef {
  profileId: string;
  field: string;
}

export interface ParsedAuthStep {
  raw: string;
  instruction: string;
  secretRefs: ResolvedSecretRef[];
  isHuman: boolean;
}

export function parseAuthStep(step: string): ParsedAuthStep {
  const isHuman = step.trimStart().startsWith('human:');
  const raw = isHuman ? step.trimStart().slice('human:'.length).trim() : step;
  const secretRefs: ResolvedSecretRef[] = [];

  const instruction = raw.replace(SECRET_REF_PATTERN, (_match, profileId: string, field: string) => {
    secretRefs.push({ profileId, field });
    return '[SECRET]';
  });

  return { raw: step, instruction: instruction.trim(), secretRefs, isHuman };
}

export function getProfileStorageStatePath(profile: AuthProfile): string {
  if (profile.storageStatePath) {
    return path.isAbsolute(profile.storageStatePath)
      ? profile.storageStatePath
      : path.join(process.cwd(), profile.storageStatePath);
  }
  return path.join(getStorageStatesDir(), `${profile.id}.json`);
}

export async function loadAuthProfile(profileId: string): Promise<AuthProfile> {
  const profilePath = path.join(getAuthProfilesDir(), `${profileId}.json`);
  let raw: string;
  try {
    raw = await fs.readFile(profilePath, 'utf-8');
  } catch {
    throw new Error(`Auth profile not found: ${profileId} (${profilePath})`);
  }

  const parsed = authProfileSchema.parse(JSON.parse(raw));
  if (parsed.id !== profileId) {
    throw new Error(`Auth profile id mismatch: expected ${profileId}, got ${parsed.id}`);
  }
  return parsed;
}

export async function saveAuthProfile(profile: AuthProfile): Promise<string> {
  const dir = getAuthProfilesDir();
  await fs.mkdir(dir, { recursive: true });
  const profilePath = path.join(dir, `${profile.id}.json`);
  await fs.writeFile(profilePath, JSON.stringify(profile, null, 2), 'utf-8');
  return profilePath;
}

export async function listAuthProfiles(): Promise<string[]> {
  const dir = getAuthProfilesDir();
  try {
    const files = await fs.readdir(dir);
    return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}
