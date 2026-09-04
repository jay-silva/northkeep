import { onVaultSave } from '@northkeep/core';
import { AutoSync, isAutoSyncVault, type AutoSyncEvent, type AutoSyncPhase } from '@northkeep/sync';
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

/** Said once at startup when this server was pointed at something other than the account's default vault. */
export const OTHER_VAULT_NOTICE =
  'northkeep MCP server: automatic sync applies to the default vault only; this vault syncs by hand';

export function createStandaloneAutoSync(
  vaultPath: string,
  log: (line: string) => void = (line) => console.error(line),
): StandaloneAutoSync {
  // The engine refuses a non-default vault on its own, but silently: a session
  // launched with --vault then never syncs and says nothing about it (sixth
  // review, hosts). One line, at startup, so the reason is in the log.
  if (!isAutoSyncVault(vaultPath)) log(OTHER_VAULT_NOTICE);
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

/** Why a paused engine is paused, in the wording the event line already uses. */
function pauseReasonText(reason: 'subscription' | 'private'): string {
  return reason === 'subscription' ? 'subscription required' : 'private server';
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
      return "northkeep MCP server sync: this vault differs from the server's newer copy; pull, then push, from the app or CLI";
    case 'error':
      return `northkeep MCP server sync failed: ${event.message}`;
    case 'paused':
      return `northkeep MCP server sync paused: ${pauseReasonText(event.reason)}`;
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
export interface FlushableEngine {
  flush(): Promise<void>;
  stop(): void;
  status(): { phase: AutoSyncPhase; pushPending: boolean; pausedReason: 'subscription' | 'private' | null };
}

export async function flushBounded(
  auto: FlushableEngine,
  budgetMs: number,
  log: (line: string) => void = (line) => console.error(line),
): Promise<FlushOutcome> {
  // Whether there was anything to push at all, captured before the flush
  // changes it. A timeout with nothing pending means a wake (a status call or
  // a pull) was still running, and saying "a push still pending" there told
  // the user a write of theirs was stranded when none was (ADR 0044 fourth
  // review).
  // A debounced push that has already started uploading reads 'syncing', not
  // 'pending', so ask the engine whether a write is still unpushed rather
  // than reading the phase (fifth review, M2).
  const before = auto.status();
  const pushWasPending = before.pushPending;
  // A paused engine's flush returns at once without uploading anything, so
  // without this the session ends with an unpushed write and no line at all
  // (sixth review, MCP kill shot: the exit notice was suppressed on exactly
  // the path that stranded the write).
  const pausedReason = before.pausedReason;
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
    const outcome = await Promise.race([flush, timeout]);
    if (pausedReason !== null && pushWasPending) {
      log(
        `northkeep MCP server exiting with a push still pending (sync paused: ${pauseReasonText(pausedReason)})`,
      );
    } else if (outcome === 'timeout') {
      log(
        pushWasPending
          ? 'northkeep MCP server exiting with a push still pending (the next wake sends it)'
          : 'northkeep MCP server exiting while a sync was still running',
      );
    }
    return outcome;
  } finally {
    if (timer !== null) clearTimeout(timer);
    auto.stop();
  }
}
