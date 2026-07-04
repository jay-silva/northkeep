#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import {
  MEMORY_TYPES,
  Vault,
  VaultAuthError,
  type MemoryEntry,
  type MemoryType,
} from '@northkeep/core';
import { ensureDeviceSecret, loadDeviceSecret } from './deviceSecret.js';
import { defaultVaultPath, deviceSecretPath } from './paths.js';
import { getPassphrase } from './prompt.js';

const program = new Command();

program
  .name('northkeep')
  .description('Northkeep — your AI memory, in a vault you own.')
  .version('0.1.0')
  .option('--vault <path>', 'vault file path', defaultVaultPath());

program
  .command('init')
  .description('Create a new encrypted vault')
  .action(async () => {
    const vaultPath = program.opts<{ vault: string }>().vault;
    if (fs.existsSync(vaultPath)) {
      fail(`A vault already exists at ${vaultPath}. Refusing to overwrite it.`);
    }
    const passphrase = await getPassphrase('Choose a passphrase (min 8 characters): ');
    if (passphrase.length < 8) {
      fail('Passphrase must be at least 8 characters.');
    }
    if (process.env.NORTHKEEP_PASSPHRASE === undefined) {
      const confirmed = await getPassphrase('Confirm passphrase: ');
      if (confirmed !== passphrase) fail('Passphrases do not match.');
    }
    const { secret, created } = ensureDeviceSecret();
    const vault = Vault.create({ path: vaultPath, passphrase, deviceSecret: secret });
    vault.close();
    console.log(`✓ Vault created at ${vaultPath}`);
    console.log(`✓ Device secret ${created ? 'generated' : 'already present'} at ${deviceSecretPath()}`);
    console.log('');
    console.log('⚠  BACK UP YOUR DEVICE SECRET NOW.');
    console.log(`   Copy ${deviceSecretPath()} somewhere safe (password manager, printed copy).`);
    console.log('   Opening this vault requires BOTH your passphrase AND that file.');
    console.log('   If you lose either one, your vault is unrecoverable — by design.');
  });

program
  .command('remember')
  .description('Store a memory in the vault')
  .argument('<content>', 'the memory, in natural language')
  .requiredOption('--type <type>', `memory type: ${MEMORY_TYPES.join(' | ')}`)
  .option('--scope <scope>', 'scope tag (personal, work, client:x, ...)', 'personal')
  .option('--source <source>', 'origin of this memory', 'cli')
  .option('--source-model <model>', 'model that produced this memory, if any')
  .option('--confidence <n>', 'confidence 0.0–1.0', parseConfidence, 1.0)
  .action(async (content: string, options: RememberOptions) => {
    await withVault(async (vault) => {
      const entry = vault.remember({
        content,
        type: options.type as MemoryType, // validated inside remember()
        scope: options.scope,
        source: options.source,
        sourceModel: options.sourceModel ?? null,
        confidence: options.confidence,
      });
      vault.save();
      console.log(`✓ Remembered [${entry.type} / ${entry.scope}] ${entry.id}`);
    });
  });

program
  .command('list')
  .description('List memories with provenance')
  .option('--type <type>', 'filter by memory type')
  .option('--scope <scope>', 'filter by scope')
  .action(async (options: { type?: string; scope?: string }) => {
    await withVault(async (vault) => {
      const entries = vault.list({
        type: options.type as MemoryType | undefined,
        scope: options.scope,
      });
      if (entries.length === 0) {
        console.log('No memories found.');
        return;
      }
      for (const entry of entries) {
        printEntry(entry);
      }
      console.log(`${entries.length} memor${entries.length === 1 ? 'y' : 'ies'}.`);
      const chain = vault.verifyChain();
      console.log(chain.ok ? '✓ Provenance chain verified.' : `✗ CHAIN BROKEN: ${chain.error}`);
    });
  });

program
  .command('export')
  .description('Export the vault as human-readable JSON per SPEC/memory-schema.md')
  .option('--out <file>', 'write to a file instead of stdout')
  .action(async (options: { out?: string }) => {
    await withVault(async (vault) => {
      const chain = vault.verifyChain();
      if (!chain.ok) fail(`Refusing to export a broken chain: ${chain.error}`);
      const json = JSON.stringify(vault.export(), null, 2);
      if (options.out) {
        fs.writeFileSync(path.resolve(options.out), `${json}\n`, { mode: 0o600 });
        console.error(`✓ Exported to ${options.out}`);
      } else {
        console.log(json);
      }
    });
  });

interface RememberOptions {
  type: string;
  scope: string;
  source: string;
  sourceModel?: string;
  confidence: number;
}

function parseConfidence(raw: string): number {
  const value = Number(raw);
  if (Number.isNaN(value)) fail('Confidence must be a number between 0.0 and 1.0.');
  return value;
}

async function withVault(fn: (vault: Vault) => Promise<void> | void): Promise<void> {
  const vaultPath = program.opts<{ vault: string }>().vault;
  const passphrase = await getPassphrase('Passphrase: ');
  const deviceSecret = loadDeviceSecret();
  const vault = Vault.open({ path: vaultPath, passphrase, deviceSecret });
  try {
    await fn(vault);
  } finally {
    vault.close();
  }
}

function printEntry(entry: MemoryEntry): void {
  const shortId = entry.id.slice(0, 8);
  const superseded = entry.superseded_at ? `  (superseded ${entry.superseded_at})` : '';
  console.log(`[${entry.type}] ${entry.content}`);
  console.log(
    `  id ${shortId}  scope ${entry.scope}  source ${entry.source}` +
      `  confidence ${entry.confidence}  at ${entry.created_at}${superseded}`,
  );
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

program.parseAsync().catch((err: unknown) => {
  if (err instanceof VaultAuthError) {
    fail(err.message);
  }
  const message = err instanceof Error ? err.message : String(err);
  if (process.env.NORTHKEEP_DEBUG === '1' && err instanceof Error) {
    console.error(err.stack);
  }
  fail(message);
});
