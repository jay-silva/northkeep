import { loadDeviceSecret, onVaultSave } from '@northkeep/core';
import { isAutoSyncVault, loadSyncConfig, pushVault, SubscriptionRequiredError, SyncBusyError } from '@northkeep/sync';

/**
 * Push-on-exit for the CLI (ADR 0044). A CLI command is a short-lived
 * process, so the desktop's debounced push collapses to: if this command
 * saved the vault, sync is configured, and a key is at hand without asking,
 * push once before returning. Runs through the same engine as the long-lived
 * hosts so the rules match (fast-forward only, 402 pauses, no content logged).
 *
 * The outcome is advisory: a failed push never changes the command's exit
 * code, because the write itself succeeded and is on disk.
 */

export interface AutoPushOptions {
  vaultPath: string;
  /** The key the command already resolved without prompting, or null when it came from a passphrase prompt. */
  masterKey: Buffer | null;
  /** True when the command saved the vault (see trackSaves). */
  saved: boolean;
  log?: (line: string) => void;
  /** Tests inject the device secret; the CLI reads ~/.northkeep/device.secret. */
  loadDeviceSecret?: () => Buffer;
}

export type AutoPushOutcome = 'pushed' | 'in-sync' | 'skipped' | 'not-configured' | 'locked' | 'busy' | 'other-vault' | 'failed';

export const NOT_UNLOCKED_HINT = 'sync: not pushed (unlock with "northkeep unlock" to sync automatically).';
export const BUSY_HINT = 'sync: another NorthKeep process is syncing; your write is saved and goes with the next sync.';
export const OTHER_VAULT_HINT = 'sync: automatic sync applies to the default vault only; use "northkeep sync push --vault" for this one.';
/** A short-lived command must not wait behind another process's transfer (review 2026-09-03, C2). */
export const SYNC_LOCK_WAIT_MS = 2_000;

export async function autoPushAfterWrite(options: AutoPushOptions): Promise<AutoPushOutcome> {
  const log = options.log ?? ((line: string) => console.error(line));
  if (!options.saved) return 'skipped';
  if (loadSyncConfig() === null) return 'not-configured';
  if (!isAutoSyncVault(options.vaultPath)) {
    log(OTHER_VAULT_HINT);
    return 'other-vault';
  }
  if (options.masterKey === null) {
    log(NOT_UNLOCKED_HINT);
    return 'locked';
  }
  // One direct push, no engine: a command is short-lived, so there is no
  // debounce and no retry, and it must not wait behind another process's
  // transfer. A failure is one line; the write is on disk regardless, and the
  // GUI or MCP engine (or the next command) picks it up.
  try {
    const result = await pushVault({
      vaultPath: options.vaultPath,
      deviceSecret: (options.loadDeviceSecret ?? loadDeviceSecret)(),
      masterKey: Buffer.from(options.masterKey),
      syncLockWaitMs: SYNC_LOCK_WAIT_MS,
    });
    if (result.ok) {
      log(`↑ synced (version ${result.version})`);
      return 'pushed';
    }
    log('sync: this machine and the server both changed. Run "northkeep sync pull", then "northkeep sync push".');
    return 'failed';
  } catch (err) {
    if (err instanceof SyncBusyError) {
      log(BUSY_HINT);
      return 'busy';
    }
    if (err instanceof SubscriptionRequiredError) {
      log('sync: this server requires a subscription. Run "northkeep sync subscribe".');
      return 'failed';
    }
    const message = err instanceof Error ? err.message : String(err);
    log(
      /HTTP 403/.test(message)
        ? 'sync: this server is private and does not list this account.'
        : `sync: ${message}. Run "northkeep sync push" later.`,
    );
    return 'failed';
  }
}

/**
 * Observe whether the vault at `vaultPath` is saved while `fn` runs. Used by
 * the CLI's withVault so read-only commands (list, search) never push.
 */
export async function trackSaves<T>(vaultPath: string, fn: () => Promise<T>): Promise<{ result: T; saved: boolean }> {
  let saved = false;
  const off = onVaultSave((p) => {
    if (p === vaultPath) saved = true;
  });
  try {
    const result = await fn();
    return { result, saved };
  } finally {
    off();
  }
}
