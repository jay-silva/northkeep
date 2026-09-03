import { onVaultSave } from '@northkeep/core';
import { AutoSync, loadSyncConfig } from '@northkeep/sync';

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
}

export type AutoPushOutcome = 'pushed' | 'in-sync' | 'skipped' | 'not-configured' | 'locked' | 'failed';

export const NOT_UNLOCKED_HINT = 'sync: not pushed (unlock with "northkeep unlock" to sync automatically).';

export async function autoPushAfterWrite(options: AutoPushOptions): Promise<AutoPushOutcome> {
  const log = options.log ?? ((line: string) => console.error(line));
  if (!options.saved) return 'skipped';
  if (loadSyncConfig() === null) return 'not-configured';
  if (options.masterKey === null) {
    log(NOT_UNLOCKED_HINT);
    return 'locked';
  }
  const key = options.masterKey;
  let outcome: AutoPushOutcome = 'in-sync';
  const auto = new AutoSync({
    vaultPath: options.vaultPath,
    // A fresh copy per call: the engine zeroes what it is given.
    getMasterKey: () => Buffer.from(key),
    debounceMs: 0,
    onEvent: (event) => {
      if (event.type === 'pushed') {
        outcome = 'pushed';
        log(`↑ synced (version ${event.version})`);
      } else if (event.type === 'error') {
        outcome = 'failed';
        log(`sync: ${event.message}. Run "northkeep sync push" later.`);
      } else if (event.type === 'paused') {
        outcome = 'failed';
        log(
          event.reason === 'subscription'
            ? 'sync: this server requires a subscription. Run "northkeep sync subscribe".'
            : 'sync: this server is private and does not list this account.',
        );
      } else if (event.type === 'diverged') {
        outcome = 'failed';
        log('sync: this machine and the server both changed. Run "northkeep sync pull", then "northkeep sync push".');
      }
    },
  });
  try {
    auto.notifyWrite(options.vaultPath);
    await auto.flush();
  } catch (err) {
    outcome = 'failed';
    log(`sync: ${err instanceof Error ? err.message : String(err)}. Run "northkeep sync push" later.`);
  } finally {
    auto.stop();
  }
  return outcome;
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
