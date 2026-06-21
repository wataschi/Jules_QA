import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getSecretsVaultPath } from '../server/data-paths.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const VAULT_VERSION = 1;

interface EncryptedField {
  iv: string;
  tag: string;
  data: string;
}

interface VaultFile {
  version: number;
  profiles: Record<string, Record<string, EncryptedField>>;
}

let cachedKey: Buffer | null = null;

function deriveKey(keyMaterial: string): Buffer {
  try {
    const fromBase64 = Buffer.from(keyMaterial, 'base64');
    if (fromBase64.length === 32) return fromBase64;
  } catch {
    /* fall through */
  }

  try {
    const fromHex = Buffer.from(keyMaterial, 'hex');
    if (fromHex.length === 32) return fromHex;
  } catch {
    /* fall through */
  }

  return crypto.scryptSync(keyMaterial, 'jules-vault-salt-v1', 32);
}

export function getVaultKey(): Buffer {
  if (cachedKey) return cachedKey;

  const material = process.env.JULES_VAULT_KEY;
  if (!material) {
    throw new Error('JULES_VAULT_KEY is not set — required for secret vault access');
  }

  cachedKey = deriveKey(material);
  return cachedKey;
}

export function resetVaultKeyCache(): void {
  cachedKey = null;
}

function encryptValue(plaintext: string, key: Buffer): EncryptedField {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decryptValue(field: EncryptedField, key: Buffer): string {
  const iv = Buffer.from(field.iv, 'base64');
  const tag = Buffer.from(field.tag, 'base64');
  const data = Buffer.from(field.data, 'base64');

  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new Error('Invalid encrypted field format');
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

async function readVaultFile(): Promise<VaultFile> {
  const vaultPath = getSecretsVaultPath();
  try {
    const raw = await fs.readFile(vaultPath, 'utf-8');
    const parsed = JSON.parse(raw) as VaultFile;
    if (parsed.version !== VAULT_VERSION || !parsed.profiles) {
      throw new Error('Unsupported vault format');
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: VAULT_VERSION, profiles: {} };
    }
    throw error;
  }
}

async function writeVaultFile(vault: VaultFile): Promise<void> {
  const vaultPath = getSecretsVaultPath();
  await fs.mkdir(path.dirname(vaultPath), { recursive: true });
  const tmp = `${vaultPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(vault, null, 2), 'utf-8');
  await fs.rename(tmp, vaultPath);
}

export async function getSecret(profileId: string, field: string): Promise<string> {
  const vault = await readVaultFile();
  const encrypted = vault.profiles[profileId]?.[field];
  if (!encrypted) {
    throw new Error(`Secret not found: ${profileId}.${field}`);
  }
  return decryptValue(encrypted, getVaultKey());
}

export async function setSecret(profileId: string, field: string, value: string): Promise<void> {
  const vault = await readVaultFile();
  if (!vault.profiles[profileId]) {
    vault.profiles[profileId] = {};
  }
  vault.profiles[profileId][field] = encryptValue(value, getVaultKey());
  await writeVaultFile(vault);
}

export async function deleteSecret(profileId: string, field: string): Promise<boolean> {
  const vault = await readVaultFile();
  if (!vault.profiles[profileId]?.[field]) return false;
  delete vault.profiles[profileId][field];
  if (Object.keys(vault.profiles[profileId]).length === 0) {
    delete vault.profiles[profileId];
  }
  await writeVaultFile(vault);
  return true;
}

export async function listProfiles(): Promise<Array<{ id: string; fields: string[] }>> {
  const vault = await readVaultFile();
  return Object.entries(vault.profiles).map(([id, fields]) => ({
    id,
    fields: Object.keys(fields),
  }));
}

/** Loads all decrypted values for redaction (never log these). */
export async function loadAllSecretValues(): Promise<string[]> {
  const vault = await readVaultFile();
  const key = getVaultKey();
  const values: string[] = [];

  for (const fields of Object.values(vault.profiles)) {
    for (const encrypted of Object.values(fields)) {
      try {
        const value = decryptValue(encrypted, key);
        if (value.length >= 4) values.push(value);
      } catch {
        /* skip corrupt entries */
      }
    }
  }

  return values;
}
