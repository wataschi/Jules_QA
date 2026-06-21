import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteSecret,
  getSecret,
  listProfiles,
  resetVaultKeyCache,
  setSecret,
} from '../../../src/security/vault.js';
import {
  applyWorkspaceEnv,
  clearWorkspaceEnv,
  createTempWorkspace,
  type TempWorkspace,
} from '../../helpers/temp-workspace.js';

describe('vault', () => {
  let ws: TempWorkspace;

  beforeEach(async () => {
    ws = await createTempWorkspace();
    applyWorkspaceEnv(ws);
    process.env.JULES_VAULT_KEY = 'test-vault-key-for-unit-tests-only';
    resetVaultKeyCache();
  });

  afterEach(async () => {
    clearWorkspaceEnv();
    resetVaultKeyCache();
    delete process.env.JULES_VAULT_KEY;
    await ws.cleanup();
  });

  it('encrypts and decrypts secrets round-trip', async () => {
    await setSecret('demo', 'password', 's3cr3t-value');
    expect(await getSecret('demo', 'password')).toBe('s3cr3t-value');
  });

  it('lists profiles and fields without exposing values', async () => {
    await setSecret('site-a', 'username', 'alice');
    await setSecret('site-a', 'password', 'pw');
    const profiles = await listProfiles();
    expect(profiles).toEqual([{ id: 'site-a', fields: expect.arrayContaining(['username', 'password']) }]);
  });

  it('deletes a secret field', async () => {
    await setSecret('tmp', 'token', 'abc');
    expect(await deleteSecret('tmp', 'token')).toBe(true);
    await expect(getSecret('tmp', 'token')).rejects.toThrow(/not found/i);
  });

  it('stores ciphertext on disk, not plaintext', async () => {
    await setSecret('demo', 'password', 'plaintext-secret');
    const vaultPath = path.join(ws.root, 'data', 'secrets.vault');
    const raw = await fs.readFile(vaultPath, 'utf-8');
    expect(raw).not.toContain('plaintext-secret');
    expect(raw).toContain('demo');
  });
});
