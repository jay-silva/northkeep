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
  setPlatform,
  withFileLock,
  type MemoryEntry,
  type MemoryType,
} from '@northkeep/core';
import { nodePlatform } from '@northkeep/platform-node';
import {
  auditAsCsv,
  auditAsJson,
  keychainAvailable,
  keychainDeleteMasterKey,
  keychainSetMasterKey,
  readCallLog,
  resolveMasterKey,
  startServer,
} from '@northkeep/mcp-server';
import { redact, restore, type Replacement } from '@northkeep/redact';
import { createOllamaEmbedder } from '@northkeep/librarian';
import {
  addEndpoint,
  classifyEndpoint,
  createOpenAICompatibleProvider,
  listEndpoints,
  removeEndpoint,
  setDefaultEndpoint,
  getDefaultEndpoint,
} from '@northkeep/converse';
import { getPassphrase } from './prompt.js';
import { PASTE_PROMPT, prepareImport, writeApproved, type ImportCmdOptions } from './importCmd.js';
import { runConverse, type ConverseCmdOptions } from './converseCmd.js';
import { modelsAdd, modelsInstall, modelsList } from './modelsCmd.js';
import {
  syncBilling,
  syncConfig,
  syncId,
  syncPull,
  syncPush,
  syncStatusCmd,
  syncSubscribe,
} from './syncCmd.js';
import {
  shareAddCmd,
  shareCodeCmd,
  shareIdCmd,
  sharePushCmd,
  shareRemoveCmd,
  shareServerCmd,
  shareStatusCmd,
  shareSyncCmd,
} from './shareCmd.js';
import { routingClear, routingList, routingSet } from './routingCmd.js';
import { collectScopes, connectCmd, connectStatusCmd, disconnectCmd } from './connectCmd.js';
import { runLauncher } from './launcher.js';

// Register the Node platform adapters (crypto/sqlite/storage) exactly once,
// before any vault or crypto operation runs (ADR 0018 platform seam).
setPlatform(nodePlatform());

const program = new Command();

program
  .name('northkeep')
  .description('NorthKeep — your AI memory, in a vault you own.')
  .version('0.2.0')
  .option('--vault <path>', 'vault file path', defaultVaultPath())
  // Bare `northkeep` (no subcommand) opens the branded launcher (M9a).
  .action(async () => {
    await runLauncher(vaultPathOpt());
  });

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
  .command('rescope')
  .description('Move a memory to a different scope (full id or unique prefix)')
  .argument('<id>', 'memory id from "northkeep list"')
  .argument('<scope>', 'new scope tag (personal, work, client:x, ...)')
  .action(async (id: string, scope: string) => {
    await withVault(async (vault) => {
      const moved = vault.rescope(id, scope);
      vault.save();
      console.log(`✓ [${moved.type}] memory is now in scope "${moved.scope}" — ${moved.id}`);
      console.log('  The previous version is kept as history (superseded), so the chain stays intact.');
    });
  });

program
  .command('edit')
  .description('Edit a memory\'s content, scope, and/or type (full id or unique prefix)')
  .argument('<id>', 'memory id from "northkeep list"')
  .option('--content <text>', 'new content')
  .option('--scope <scope>', 'new scope tag')
  .option('--type <type>', `new type: ${MEMORY_TYPES.join(' | ')}`)
  .action(async (id: string, options: { content?: string; scope?: string; type?: string }) => {
    await withVault(async (vault) => {
      const patch: { content?: string; scope?: string; type?: MemoryType } = {};
      if (options.content !== undefined) patch.content = options.content;
      if (options.scope !== undefined) patch.scope = options.scope;
      if (options.type !== undefined) patch.type = options.type as MemoryType; // validated in editMemory
      const edited = vault.editMemory(id, patch);
      vault.save();
      console.log(`✓ Edited → [${edited.type} / ${edited.scope}] ${edited.id}`);
      console.log('  The previous version is kept as history (superseded), so the chain stays intact.');
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
  .command('search')
  .description('Search memories by meaning (local embeddings), with keyword fallback')
  .argument('<query>', 'what to look for')
  .option('--type <type>', 'filter by memory type')
  .option('--scope <scope>', 'filter by scope')
  .option('--limit <n>', 'max results', (v) => parseInt(v, 10), 8)
  .action(async (queryStr: string, options: { type?: string; scope?: string; limit: number }) => {
    await withVault(async (vault) => {
      const r = await vault.retrieveSemantic(queryStr, createOllamaEmbedder(), {
        type: options.type as MemoryType | undefined,
        scope: options.scope,
        limit: options.limit,
      });
      // Degrade loudly (invariant #6): say plainly when semantic wasn't available.
      console.log(
        r.mode === 'semantic'
          ? '✦ semantic search (ranked by meaning)'
          : `⚠ semantic unavailable — using keyword search (${r.reason}). Start Ollama + pull nomic-embed-text for meaning-based search.`,
      );
      if (r.results.length === 0) {
        console.log('No memories found.');
        return;
      }
      for (const s of r.results) printEntry(s.entry);
      console.log(`${r.results.length} result${r.results.length === 1 ? '' : 's'}.`);
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
  .command('redact')
  .description('Mask secrets (and optionally pseudonymize names) in text before you paste it into any AI')
  .argument('[text]', 'text to redact; omit to read stdin')
  .option('--tier <n>', '1 = secrets only; 2 = also pseudonymize names/orgs (needs Ollama)', '1')
  .option('--map <file>', 'write the restore map here (needed by "northkeep restore")')
  .action(async (text: string | undefined, options: { tier: string; map?: string }) => {
    const input = text ?? (await readStdin());
    if (!input.trim()) fail('Nothing to redact. Pass text or pipe it in.');
    const tier = options.tier === '2' ? 2 : 1;
    const result = await redact(input, { tier });
    if (result.tier2Degraded) {
      console.error('⚠  Tier 2 unavailable (no Ollama) — names were NOT pseudonymized, only secrets masked.');
      console.error('   Start Ollama for name pseudonymization: brew services start ollama');
    }
    process.stdout.write(result.redacted + (result.redacted.endsWith('\n') ? '' : '\n'));
    if (options.map) {
      fs.writeFileSync(path.resolve(options.map), JSON.stringify(result.replacements, null, 2), { mode: 0o600 });
      console.error(`✓ Restore map written to ${options.map} (tier ${result.tierApplied}).`);
    } else if (result.replacements.some((r) => r.restorable)) {
      console.error('Tip: pass --map <file> to save the mapping so "northkeep restore" can put names back.');
    }
  });

program
  .command('restore')
  .description('Restore an AI response by putting real names back (reverses "northkeep redact --tier 2")')
  .argument('[text]', 'the AI response; omit to read stdin')
  .requiredOption('--map <file>', 'the restore map from "northkeep redact --map"')
  .action(async (text: string | undefined, options: { map: string }) => {
    const input = text ?? (await readStdin());
    let replacements: Replacement[];
    try {
      replacements = JSON.parse(fs.readFileSync(path.resolve(options.map), 'utf8')) as Replacement[];
    } catch {
      fail(`Could not read the restore map at ${options.map}.`);
    }
    process.stdout.write(restore(input, replacements!).replace(/\n?$/, '\n'));
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
          : (entry.result_id?.slice(0, 8) ?? 'ok')
        : `error: ${entry.error}`;
      console.log(`${status} ${entry.ts}  ${entry.tool}  ${params}  → ${outcome}`);
      if (entry.result_ids && entry.result_ids.length > 0) {
        console.log(`    disclosed: ${entry.result_ids.map((id) => id.slice(0, 8)).join(' ')}`);
      }
    }
  });

program
  .command('audit')
  .description('Export the audit trail: who asked what of your vault, under which scope grant')
  .option('--format <fmt>', 'csv | json', 'csv')
  .option('--out <file>', 'write to a file instead of stdout')
  .option('-n, --count <n>', 'only the last N calls', (v: string) => Number(v) || undefined)
  .action((options: { format: string; out?: string; count?: number }) => {
    const output =
      options.format === 'json'
        ? JSON.stringify(auditAsJson(options.count), null, 2) + '\n'
        : auditAsCsv(options.count);
    if (options.out) {
      fs.writeFileSync(path.resolve(options.out), output, { mode: 0o600 });
      console.error(`✓ Audit exported to ${options.out} (${options.format}).`);
    } else {
      process.stdout.write(output);
    }
  });

program
  .command('scopes')
  .description('List the scopes in your vault, and what this session is granted')
  .action(async () => {
    await withVault((vault) => {
      const scopes = vault.scopes();
      console.log(scopes.length ? `Scopes in vault: ${scopes.join(', ')}` : 'No scopes yet.');
      const granted = process.env.NORTHKEEP_SCOPES;
      console.log(
        granted
          ? `This session is GRANTED: ${granted}`
          : 'This session has FULL access (you are the vault owner).',
      );
    });
  });

const providers = program
  .command('providers')
  .description('Manage model endpoints for "northkeep converse" (base URL + model + optional Keychain key)');

providers
  .command('list', { isDefault: true })
  .description('List configured endpoints with their privacy badges')
  .action(() => {
    const endpoints = listEndpoints();
    if (endpoints.length === 0) {
      console.log('No endpoints configured yet. Add one:');
      console.log('  northkeep providers add --label "Local" --base-url http://127.0.0.1:11434 --model llama3.2:3b');
      return;
    }
    const defaultId = getDefaultEndpoint()?.id;
    for (const ep of endpoints) {
      const { tier } = classifyEndpoint(ep.baseUrl);
      const badge = tier === 'private' ? '\x1b[32mprivate\x1b[0m' : '\x1b[33mbounded\x1b[0m';
      console.log(
        `${ep.id === defaultId ? '*' : ' '} ${ep.id}  ${ep.label}  ${ep.baseUrl}  ${ep.model}  [${badge}]${ep.hasKey ? '  key: stored' : ''}`,
      );
    }
    console.log('\n(* = default. Set with: northkeep providers default <id>)');
  });

providers
  .command('add')
  .description('Add an endpoint. Any OpenAI-compatible runtime or API works; keys go to the macOS Keychain.')
  .requiredOption('--label <label>', 'a name you will recognize')
  .requiredOption('--base-url <url>', 'e.g. http://127.0.0.1:11434 or https://api.deepseek.com')
  .option('--model <model>', 'model id; omit to list what the endpoint offers')
  .option('--kind <kind>', 'openai-compatible | anthropic', 'openai-compatible')
  .option('--api-key-stdin', 'read an API key from stdin (never from an argument — shell history)', false)
  .action(async (options: { label: string; baseUrl: string; model?: string; kind: string; apiKeyStdin: boolean }) => {
    if (options.kind !== 'openai-compatible' && options.kind !== 'anthropic') {
      fail('kind must be openai-compatible or anthropic.');
    }
    if (!options.model) {
      const probe = createOpenAICompatibleProvider({ baseUrl: options.baseUrl });
      try {
        const models = await probe.listModels();
        console.log('Models offered by that endpoint:');
        for (const id of models) console.log(`  ${id}`);
        console.log('\nRe-run with --model <id> to add it.');
      } catch {
        fail('Could not list models from that endpoint — is it running? Pass --model explicitly if you know it.');
      }
      return;
    }
    let apiKey: string | undefined;
    if (options.apiKeyStdin) {
      apiKey = (await readStdin()).trim();
      if (!apiKey) fail('No API key on stdin. Pipe it in: echo "$KEY" | northkeep providers add --api-key-stdin ...');
    }
    const endpoint = addEndpoint({
      label: options.label,
      baseUrl: options.baseUrl,
      model: options.model,
      kind: options.kind as 'openai-compatible' | 'anthropic',
      ...(apiKey ? { apiKey } : {}),
    });
    const { tier, reason } = classifyEndpoint(endpoint.baseUrl);
    console.log(`✓ Added ${endpoint.id} — ${endpoint.label} (${endpoint.model})`);
    console.log(`  Privacy: ${tier} (${reason})${endpoint.hasKey ? ' · key stored in Keychain' : ''}`);
  });

providers
  .command('remove')
  .description('Remove an endpoint (and its Keychain key, if any)')
  .argument('<id>', 'endpoint id from "northkeep providers list"')
  .action((id: string) => {
    if (!removeEndpoint(id)) fail(`No endpoint "${id}".`);
    console.log(`✓ Removed ${id}.`);
  });

providers
  .command('default')
  .description('Set the default endpoint for "northkeep converse"')
  .argument('<id>', 'endpoint id')
  .action((id: string) => {
    setDefaultEndpoint(id);
    console.log(`✓ Default endpoint: ${id}`);
  });

program
  .command('converse')
  .alias('chat')
  .description('Converse with a model through NorthKeep: memory injected, secrets masked, every turn audited')
  .option('--endpoint <id>', 'endpoint id (default: the configured default)')
  .option('--tier <n>', 'redaction tier: 0 (private endpoints only) | 1 | 2', '1')
  .option('--scope <scope>', 'scope for memories distilled from this conversation', 'personal')
  .option('--auto', 'let the concierge route each message by task (M7b)')
  .action(async (options: ConverseCmdOptions) => {
    await runConverse(options, withVault);
  });

const models = program
  .command('models')
  .description('Connect and install AI models — guided hosted setup and 1-click local install');

models
  .command('list', { isDefault: true })
  .description('List your connected models, their cost, and local-AI status')
  .action(async () => {
    await modelsList();
  });

models
  .command('add')
  .description('Guided setup: pick a provider, paste a key (stored in your Keychain), pick a model')
  .action(async () => {
    await modelsAdd();
  });

models
  .command('install')
  .description('Install a local model on this Mac (hardware-matched by default), via Ollama')
  .argument('[tag]', 'Ollama model tag, e.g. llama3.2:3b (omit to use the recommended one)')
  .action(async (tag: string | undefined) => {
    await modelsInstall(tag);
  });

const routing = program
  .command('routing')
  .description('The concierge rule book: which endpoint answers which kind of task (Auto mode)');

routing
  .command('list', { isDefault: true })
  .description('Show the routing rules')
  .action(() => {
    routingList();
  });

routing
  .command('set')
  .description('Route a task kind to an endpoint (code, reasoning, creative, long-context, quick, general, or * for everything)')
  .argument('<task>', 'task kind')
  .argument('<endpoint>', 'endpoint id or label')
  .option('--model <model>', 'use a specific model on that endpoint')
  .action((task: string, endpoint: string, options: { model?: string }) => {
    routingSet(task, endpoint, options, fail);
  });

routing
  .command('clear')
  .description('Remove a rule (or all rules when no task is given)')
  .argument('[task]', 'task kind to clear')
  .action((task: string | undefined) => {
    routingClear(task, fail);
  });

const sync = program
  .command('sync')
  .description('Sync your encrypted vault across machines (the server only ever sees ciphertext)');

sync
  .command('config')
  .description('Point at a sync server (https, or loopback for testing)')
  .requiredOption('--server <url>', 'sync server base URL, e.g. https://your-sync.vercel.app')
  .action(async (options: { server: string }) => {
    await syncConfig(options.server, fail);
  });

sync
  .command('push')
  .description('Upload your vault to the sync server (encrypted; conflict-safe)')
  .action(async () => {
    await syncPush(vaultPathOpt(), fail);
  });

sync
  .command('pull')
  .description('Download the vault from the sync server (verified before it replaces your local copy)')
  .action(async () => {
    await syncPull(vaultPathOpt(), fail);
  });

sync
  .command('status', { isDefault: true })
  .description('Show whether your vault is in sync, ahead, or behind')
  .action(async () => {
    await syncStatusCmd(vaultPathOpt(), fail);
  });

sync
  .command('subscribe')
  .description('Start a $10/month subscription to sync on a hosted server (Stripe checkout)')
  .action(async () => {
    await syncSubscribe(fail);
  });

sync
  .command('billing')
  .description('Manage your subscription — update card or cancel (Stripe billing portal)')
  .action(async () => {
    await syncBilling(fail);
  });

sync
  .command('id')
  .description('Show your sync id (a second machine needs the same device.secret)')
  .action(() => {
    syncId(fail);
  });

const share = program
  .command('share')
  .description('Share specific scopes with the hosted connector so your cloud AI apps (Claude, ChatGPT) can read them');

share
  .command('server <url>')
  .description('Set the connector server URL (https, or loopback for testing)')
  .action((url: string) => shareServerCmd(url, fail));

share
  .command('add <scope>')
  .description('Mark a scope Shared (stored encrypted on the connector, no key in its database to read it), then push it; private scopes are never shared')
  .option('--yes', 'skip the confirmation prompt (scripting)')
  .action(async (scope: string, options: { yes?: boolean }) => {
    await shareAddCmd(scope, options, withVault, fail);
  });

share
  .command('remove <scope>')
  .description('Unshare a scope: delete all its memories from the connector server')
  .action(async (scope: string) => {
    await shareRemoveCmd(scope, fail);
  });

share
  .command('status', { isDefault: true })
  .description('Show the connector server, which scopes are shared, and their counts')
  .action(async () => {
    await shareStatusCmd(withVault);
  });

share
  .command('id')
  .description('Print your connector account id (the hash a connector operator adds to a free/comp allowlist)')
  .action(() => {
    shareIdCmd(fail);
  });

share
  .command('push')
  .description('Re-push your shared scopes to the connector server (after adding memories)')
  .action(async () => {
    await sharePushCmd(withVault, fail);
  });

share
  .command('code')
  .description('Get a pairing code to connect an AI app to your shared memories')
  .action(async () => {
    await shareCodeCmd(fail);
  });

share
  .command('sync')
  .description('Pull memories your AI apps created (and forgot) back into your vault, then re-push')
  .action(async () => {
    await shareSyncCmd(withVault, fail);
  });

const connectGroup = program
  .command('connect')
  .description('Connect an AI app to your NorthKeep memory over MCP (Claude Desktop, Claude Code)');

connectGroup
  .command('claude-desktop')
  .description('Register NorthKeep as an MCP server in Claude Desktop')
  .option('--scope <scope>', 'limit disclosure to these scopes (repeatable or comma-separated; omit for full access)', collectScopes, [])
  .action((options: { scope: string[] }) => connectCmd('claude-desktop', options, fail));

connectGroup
  .command('claude-code')
  .description('Register NorthKeep as an MCP server in Claude Code (via the claude CLI)')
  .option('--scope <scope>', 'limit disclosure to these scopes (repeatable or comma-separated; omit for full access)', collectScopes, [])
  .action((options: { scope: string[] }) => connectCmd('claude-code', options, fail));

connectGroup
  .command('status', { isDefault: true })
  .description('Show which AI apps are connected to your vault')
  .action(() => connectStatusCmd());

const disconnectGroup = program
  .command('disconnect')
  .description('Remove NorthKeep from an AI app (leaves every other setting untouched)');

disconnectGroup
  .command('claude-desktop')
  .description('Remove NorthKeep from Claude Desktop')
  .action(() => disconnectCmd('claude-desktop', fail));

disconnectGroup
  .command('claude-code')
  .description('Remove NorthKeep from Claude Code')
  .action(() => disconnectCmd('claude-code', fail));

program
  .command('serve')
  .description('Run the MCP server on stdio (what Claude Desktop launches)')
  .action(async () => {
    await startServer(vaultPathOpt());
  });

program
  .command('ui')
  .description('Open the NorthKeep app in your browser (local only)')
  .option('--no-open', 'print the URL without opening a browser')
  .action(async (options: { open: boolean }) => {
    const { startUiServer } = await import('@northkeep/web');
    const server = await startUiServer({ vaultPath: vaultPathOpt() });
    console.log(`NorthKeep is running (this Mac only): ${server.url}`);
    console.log('Press Ctrl-C to quit.');
    if (options.open) {
      const { execFile } = await import('node:child_process');
      execFile('open', [server.url], () => {});
    }
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
async function withVault<T>(fn: (vault: Vault) => Promise<T> | T): Promise<T> {
  const vaultPath = vaultPathOpt();
  const resolved = resolveMasterKey(vaultPath);
  // Prompt BEFORE taking the file lock — a human typing must never hold the
  // lock (a concurrent MCP call would time out waiting on it).
  const passphrase = resolved === null ? await getPassphrase('Passphrase: ') : null;
  return withFileLock(vaultPath, async () => {
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
      return await fn(vault);
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

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
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
