import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { Vault, memzero } from '@northkeep/core';
import { classifyEndpoint, getDefaultEndpoint, listEndpoints } from '@northkeep/converse';
import { createOllamaClient } from '@northkeep/librarian';
import { claudeCodeStatus, claudeDesktopStatus, resolveMasterKey } from '@northkeep/mcp-server';
import { loadSyncConfig } from '@northkeep/sync';
import { c, logo, statusRow, tierDot } from './ui.js';

/**
 * `northkeep` with no arguments (M9a) — the branded home: the keep logo, a live
 * status block, and the commands laid out. From the prompt you type a command
 * (which runs as a subprocess) or press Enter to drop into chat. Reading status
 * never prompts for a passphrase: if no ambient key is available the vault line
 * just says "locked".
 */

interface HomeStatus {
  vaultExists: boolean;
  unlocked: boolean;
  memoryCount: number | null;
  defaultLabel: string | null;
  defaultTier: 'private' | 'bounded' | null;
  endpointCount: number;
  syncConfigured: boolean;
  claudeDesktop: boolean;
  claudeCode: boolean;
  ollamaReady: boolean;
}

async function gatherStatus(vaultPath: string): Promise<HomeStatus> {
  const vaultExists = fs.existsSync(vaultPath);
  let unlocked = false;
  let memoryCount: number | null = null;
  if (vaultExists) {
    const resolved = resolveMasterKey(vaultPath); // ambient key only — never prompts
    if (resolved) {
      unlocked = true;
      try {
        const vault = Vault.openWithKey(vaultPath, Buffer.from(resolved.key));
        memoryCount = vault.list().length;
        vault.close();
      } catch {
        memoryCount = null;
      } finally {
        memzero(resolved.key);
      }
    }
  }

  const endpoints = listEndpoints();
  const def = getDefaultEndpoint();
  const ollamaReady = await createOllamaClient().available().catch(() => false);

  return {
    vaultExists,
    unlocked,
    memoryCount,
    defaultLabel: def?.label ?? null,
    defaultTier: def ? classifyEndpoint(def.baseUrl).tier : null,
    endpointCount: endpoints.length,
    syncConfigured: loadSyncConfig() !== null,
    claudeDesktop: claudeDesktopStatus().connected,
    claudeCode: claudeCodeStatus().connected,
    ollamaReady,
  };
}

function renderHome(s: HomeStatus): string {
  const lines = ['', logo(), ''];

  const vault = !s.vaultExists
    ? c.yellow('no vault yet') + c.muted('  — run "init"')
    : s.unlocked
      ? c.green('unlocked') + c.muted(`  ${s.memoryCount ?? '?'} memories`)
      : c.yellow('locked') + c.muted('  — run "unlock" or open the app');
  lines.push(statusRow('Vault', vault));

  const models =
    s.endpointCount === 0
      ? c.yellow('none') + c.muted('  — run "models add" to connect one')
      : `${s.defaultLabel ?? '(no default)'} ${s.defaultTier ? tierDot(s.defaultTier) : ''}` +
        c.muted(`  ${s.endpointCount} configured`);
  lines.push(statusRow('Models', models));

  lines.push(
    statusRow(
      'Local AI',
      s.ollamaReady ? c.green('Ollama ready') : c.muted('off — "models install" to set up'),
    ),
  );
  lines.push(statusRow('Sync', s.syncConfigured ? c.green('configured') : c.muted('off')));

  const connected = [s.claudeDesktop && 'Claude Desktop', s.claudeCode && 'Claude Code'].filter(
    Boolean,
  ) as string[];
  lines.push(
    statusRow('Connected', connected.length ? c.green(connected.join(', ')) : c.muted('nothing yet')),
  );

  lines.push('');
  lines.push(c.muted('  Commands'));
  const cmd = (name: string, desc: string): string =>
    `    ${c.bold(name.padEnd(18))}${c.muted(desc)}`;
  lines.push(cmd('converse', 'chat, with memory + concierge routing'));
  lines.push(cmd('models', 'add / install / list AI models'));
  lines.push(cmd('remember', 'save a memory'));
  lines.push(cmd('list', 'browse your memory'));
  lines.push(cmd('connect', 'put your memory into Claude apps'));
  lines.push(cmd('ui', 'open the app in your browser'));
  lines.push(cmd('sync', 'sync your vault across machines'));
  lines.push('');
  lines.push(
    c.muted('  Type a command, press ') + c.bold('Enter') + c.muted(' to chat, or "quit" to exit.'),
  );
  lines.push('');
  return lines.join('\n');
}

/** Run a NorthKeep subcommand as a child process, inheriting the terminal. */
function runSubcommand(scriptPath: string, vaultPath: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, '--vault', vaultPath, ...args], {
      stdio: 'inherit',
    });
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
}

export async function runLauncher(vaultPath: string): Promise<void> {
  const status = await gatherStatus(vaultPath);
  process.stdout.write(renderHome(status) + '\n');

  const scriptPath = process.argv[1] ?? '';
  for (;;) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let line: string;
    try {
      line = (await rl.question(c.pine('northkeep ▸ '))).trim();
    } catch {
      rl.close();
      break; // Ctrl-D
    }
    rl.close();

    if (line === 'quit' || line === 'exit' || line === 'q' || line === ':q') break;
    if (line === 'help' || line === '?') {
      process.stdout.write(renderHome(await gatherStatus(vaultPath)) + '\n');
      continue;
    }
    // Enter alone → chat; anything else → run it as a subcommand.
    const args = line.length === 0 ? ['converse'] : line.split(/\s+/);
    await runSubcommand(scriptPath, vaultPath, args);
  }
  process.stdout.write(c.muted('Bye.\n'));
}
