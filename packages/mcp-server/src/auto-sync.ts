import { onVaultSave } from '@northkeep/core';
import { AutoSync, type AutoSyncEvent } from '@northkeep/sync';
import { resolveMasterKey } from './key.js';

/**
 * Automatic sync for the STANDALONE stdio server (ADR 0044). A Claude Code or
 * Claude Desktop session that writes a memory through this process is a
 * desktop write like any other, so it pushes after the write, and the session
 * starting is a wake (fast-forward pull only; the engine never pulls over
 * local edits). The web GUI runs its own engine, so the embedded case (web or
 * CLI importing createServer) must not create one here.
 *
 * Every line goes to stderr: stdout is the MCP protocol. Nothing here ever
 * logs content; events carry versions and error strings only.
 */

export interface StandaloneAutoSync {
  auto: AutoSync;
  /** Detach the save hook. Idempotent. */
  dispose(): void;
}

export function createStandaloneAutoSync(
  vaultPath: string,
  log: (line: string) => void = (line) => console.error(line),
): StandaloneAutoSync {
  const auto = new AutoSync({
    vaultPath,
    // resolveMasterKey returns a fresh Buffer per call (documented in key.ts),
    // so the engine may zero it after each operation.
    getMasterKey: () => resolveMasterKey(vaultPath)?.key ?? null,
    onEvent: (event) => log(describeEvent(event)),
  });
  const off = onVaultSave((savedPath) => {
    // The engine guards this too; stated here so this file reads on its own.
    if (savedPath !== vaultPath) return;
    auto.notifyWrite(savedPath);
  });
  let disposed = false;
  return {
    auto,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      off();
      auto.stop();
    },
  };
}

/** One stderr line per engine event, in the server's existing voice. */
export function describeEvent(event: AutoSyncEvent): string {
  switch (event.type) {
    case 'pushed':
      return `northkeep MCP server synced: pushed version ${event.version}`;
    case 'pulled':
      return `northkeep MCP server synced: pulled version ${event.version} (previous copy kept at ${event.backupPath})`;
    case 'in-sync':
      return 'northkeep MCP server synced: in sync';
    case 'diverged':
      return 'northkeep MCP server sync: this machine and the server both changed; pull, then push, from the app or CLI';
    case 'error':
      return `northkeep MCP server sync failed: ${event.message}`;
    case 'paused':
      return `northkeep MCP server sync paused: ${event.reason === 'subscription' ? 'subscription required' : 'private server'}`;
  }
}

/** How a bounded shutdown flush ended. */
export type FlushOutcome = 'flushed' | 'failed' | 'timeout';

/**
 * Push whatever is pending, but never let a slow or hung server hold up
 * shutdown: the orphan-prevention exit in server.ts must stay reliable.
 * 'flushed' when the flush finished inside the budget, 'failed' when it threw
 * (logged on stderr; the write stays on disk and the next wake pushes it),
 * 'timeout' when the budget ran out. The engine is stopped in every case.
 */
export async function flushBounded(
  auto: Pick<AutoSync, 'flush' | 'stop'>,
  budgetMs: number,
  log: (line: string) => void = (line) => console.error(line),
): Promise<FlushOutcome> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<FlushOutcome>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), budgetMs);
  });
  const flush = auto.flush().then(
    (): FlushOutcome => 'flushed',
    (err: unknown): FlushOutcome => {
      log(`northkeep MCP server sync failed at exit: ${err instanceof Error ? err.message : String(err)}`);
      return 'failed';
    },
  );
  try {
    return await Promise.race([flush, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    auto.stop();
  }
}
