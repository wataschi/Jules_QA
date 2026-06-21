#!/usr/bin/env tsx
/**
 * CLI for managing encrypted secrets vault (data/secrets.vault).
 *
 * Usage:
 *   npx tsx scripts/vault.ts list
 *   npx tsx scripts/vault.ts set <profileId> <field> [--stdin | value]
 *   npx tsx scripts/vault.ts get <profileId> <field>
 *   npx tsx scripts/vault.ts delete <profileId> <field>
 */
import readline from 'node:readline';
import dotenv from 'dotenv';
import {
  deleteSecret,
  getSecret,
  listProfiles,
  setSecret,
} from '../src/security/vault.js';

dotenv.config();

async function readStdinSecret(): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.once('line', (line) => {
      rl.close();
      resolve(line);
    });
    rl.on('error', reject);
  });
}

async function main(): Promise<void> {
  const [command, profileId, field, ...rest] = process.argv.slice(2);

  if (!command || command === 'help' || command === '--help') {
    console.log(`Usage:
  npx tsx scripts/vault.ts list
  npx tsx scripts/vault.ts set <profileId> <field> [value]
  npx tsx scripts/vault.ts set <profileId> <field> --stdin
  npx tsx scripts/vault.ts get <profileId> <field>
  npx tsx scripts/vault.ts delete <profileId> <field>`);
    process.exit(0);
  }

  if (command === 'list') {
    const profiles = await listProfiles();
    if (profiles.length === 0) {
      console.log('(empty vault)');
      return;
    }
    for (const p of profiles) {
      console.log(`${p.id}: ${p.fields.join(', ')}`);
    }
    return;
  }

  if (!profileId || !field) {
    console.error('Missing profileId or field');
    process.exit(1);
  }

  if (command === 'set') {
    let value: string;
    if (rest[0] === '--stdin' || rest.length === 0) {
      value = await readStdinSecret();
    } else {
      value = rest.join(' ');
    }
    if (!value) {
      console.error('Empty secret value');
      process.exit(1);
    }
    await setSecret(profileId, field, value);
    console.log(`Set ${profileId}.${field}`);
    return;
  }

  if (command === 'get') {
    const value = await getSecret(profileId, field);
    console.log(value);
    return;
  }

  if (command === 'delete') {
    const ok = await deleteSecret(profileId, field);
    console.log(ok ? `Deleted ${profileId}.${field}` : 'Not found');
    return;
  }

  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
