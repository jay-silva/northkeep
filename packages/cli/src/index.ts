#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import {
  MEMORY_TYPES,
  Vault,
  VaultAuthError,
  defaultVaultPath,
  deriveMasterKey,
  deviceSecretPath,
  ensureDeviceSecret,
  loadDeviceSecret,
  withFileLock,
  type MemoryEntry,
  type MemoryType,
} from '@northkeep/core';
import {
  keychainAvailable,
  keychainDeleteMasterKey,
  keychainSetMasterKey,
  readCallLog,
  resolveMasterKey,
  startServer,
} from '@northkeep/mcp-server';
import { getPassphrase } from './prompt.js';
import { PASTE_PROMPT, prepareImport, writeApproved, type ImportCmdOptions } from './importCmd.js';

const program = new Command();

program
  .name('northkeep')
  .description('Northkeep — your AI memory, in a vault you own.')
  .version('0.2.0')
  .option('--vault <path>', 'vault file path', defaultVaultPath());

program
  .command('init')
  .description('Create a new encrypted vault')
  .action(async () => {
    const vaultPath = vaultPathOpt();
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
  .command('unlock')
  .description('Grant background access (Claude Desktop / MCP) by parking the vault key in the macOS Keychain')
  .action(async () => {
    if (!keychainAvailable()) {
      fail('Keychain unlock requires macOS. Use the NORTHKEEP_PASSPHRASE environment variable instead.');
    }
    const vaultPath = vaultPathOpt();
    const passphrase = await getPassphrase('Passphrase: ');
    const header = Vault.readHeader(vaultPath);
    const key = deriveMasterKey(passphrase, loadDeviceSecret(), header.salt, header.kdf);
    try {
      // Verify against the real vault before storing anything (openWithKey
      // consumes the buffer it is given, so hand it a copy). Under the file
      // lock: opening can trigger a schema migration, which writes.
      await withFileLock(vaultPath, () => {
        Vault.openWithKey(vaultPath, Buffer.from(key)).close();
      });
      keychainSetMasterKey(key.toString('hex'));
    } finally {
      key.fill(0);
    }
    console.log('✓ Vault unlocked for background access via your macOS Keychain.');
    console.log('  Claude Desktop (and this CLI) can now open the vault without a passphrase.');
    console.log('  Anyone using your logged-in Mac session has the same access — the same');
    console.log('  trust level as your saved browser passwords.');
    console.log('  Revoke anytime: northkeep lock');
  });

program
  .command('lock')
  .description('Revoke background access (remove the vault key from the Keychain)')
  .action(() => {
    if (!keychainAvailable()) {
      fail('Keychain is only used on macOS; nothing to lock.');
    }
    const outcome = keychainDeleteMasterKey();
    console.log(
      outcome === 'removed' ? '✓ Vault locked. Background access revoked.' : 'Vault was not unlocked.',
    );
    if (process.env.NORTHKEEP_MASTER_KEY || process.env.NORTHKEEP_PASSPHRASE) {
      console.log(
        '⚠  NORTHKEEP_MASTER_KEY / NORTHKEEP_PASSPHRASE is set in this environment — ' +
          'anything launched with those variables can still open the vault.',
      );
    }
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
  .command('forget')
  .description('Permanently remove the content of a memory (full id or unique prefix)')
  .argument('<id>', 'memory id from "northkeep list"')
  .action(async (id: string) => {
    await withVault(async (vault) => {
      const tombstone = vault.forget(id);
      vault.save();
      console.log(`✓ Forgot ${tombstone.id} (content removed; deletion recorded ${tombstone.forgotten_at})`);
      console.log('  Note: the previous vault state remains in vault.nkv.bak until the next write.');
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

program
  .command('import')
  .description('Import memories from ChatGPT/Claude exports or a paste-prompt file')
  .argument('<source>', 'chatgpt | claude | paste | prompt')
  .argument('[file]', 'export ZIP / JSON / text file')
  .option('--scope <scope>', 'scope for imported memories', 'personal')
  .option('--yes', 'skip the review step and import everything', false)
  .option('--dry-run', 'extract and show candidates without writing anything', false)
  .option('--limit <n>', 'process at most N conversations', (v: string) => Number(v) || 0)
  .action(async (source: string, file: string | undefined, options: ImportCmdOptions) => {
    if (source === 'prompt') {
      console.log(PASTE_PROMPT);
      return;
    }
    // Phase 1: brief locked read to snapshot existing entries for dedupe.
    let existing: MemoryEntry[] = [];
    await withVault((vault) => {
      existing = vault.list({ includeForgotten: true });
    });
    // Phases 2–3: parse, extract (minutes), review (human time) — UNLOCKED.
    const outcome = await prepareImport(source, file, existing, options);
    if (outcome === null) return;
    // Phase 4: short locked write.
    await withVault((vault) => {
      const written = writeApproved(vault, outcome, options.scope);
      console.log(`✓ Imported ${written} memories into scope "${options.scope}".`);
      const chain = vault.verifyChain();
      console.log(chain.ok ? '✓ Provenance chain verified.' : `✗ CHAIN BROKEN: ${chain.error}`);
    });
    console.log('Inspect with: northkeep list   (remove any with: northkeep forget <id>)');
  });

program
  .command('log')
  .description('Show the MCP call log (what AI apps asked of your vault — never content)')
  .option('-n, --count <n>', 'show the last N calls', '20')
  .action((options: { count: string }) => {
    const entries = readCallLog(Number(options.count) || 20);
    if (entries.length === 0) {
      console.log('No MCP calls logged yet.');
      return;
    }
    for (const entry of entries) {
      const status = entry.ok ? '✓' : '✗';
      const params = Object.entries(entry.params)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(' ');
      const outcome = entry.ok
        ? entry.result_count !== undefined
          ? `${entry.result_count} result${entry.result_count === 1 ? '' : 's'}`
          : (entry.result_id ?? 'ok')
        : `error: ${entry.error}`;
      console.log(`${status} ${entry.ts}  ${entry.tool}  ${params}  → ${outcome}`);
    }
  });

program
  .command('serve')
  .description('Run the MCP server on stdio (what Claude Desktop launches)')
  .action(async () => {
    await startServer(vaultPathOpt());
  });

interface RememberOptions {
  type: string;
  scope: string;
  source: string;
  sourceModel?: string;
  confidence: number;
}

function vaultPathOpt(): string {
  return program.opts<{ vault: string }>().vault;
}

function parseConfidence(raw: string): number {
  const value = Number(raw);
  if (Number.isNaN(value)) fail('Confidence must be a number between 0.0 and 1.0.');
  return value;
}

/**
 * Opens the vault under the file lock, preferring an already-derived key
 * (env or Keychain after `northkeep unlock`) and falling back to a
 * passphrase prompt.
 */
async function withVault(fn: (vault: Vault) => Promise<void> | void): Promise<void> {
  const vaultPath = vaultPathOpt();
  const resolved = resolveMasterKey(vaultPath);
  // Prompt BEFORE taking the file lock — a human typing must never hold the
  // lock (a concurrent MCP call would time out waiting on it).
  const passphrase = resolved === null ? await getPassphrase('Passphrase: ') : null;
  await withFileLock(vaultPath, async () => {
    let vault: Vault;
    if (resolved !== null) {
      try {
        vault = Vault.openWithKey(vaultPath, resolved.key);
      } catch (err) {
        if (err instanceof VaultAuthError && resolved.source === 'keychain') {
          throw new VaultAuthError(
            'The stored background-access key no longer matches this vault. ' +
              'Run "northkeep unlock" again (or "northkeep lock" to clear it).',
          );
        }
        throw err;
      }
    } else {
      vault = Vault.open({ path: vaultPath, passphrase: passphrase!, deviceSecret: loadDeviceSecret() });
    }
    try {
      await fn(vault);
    } finally {
      vault.close();
    }
  });
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
