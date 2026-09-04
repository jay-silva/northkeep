import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadDeviceSecret as coreLoadDeviceSecret, memzero } from '@northkeep/core';
import { loadSyncConfig } from './config.js';
import {
  isAutoSyncVault,
  LocalChangedError,
  pullVault,
  pushVault,
  resolveVaultLink,
  SubscriptionRequiredError,
  syncState,
  type SyncState,
} from './client.js';

/**
 * Automatic sync (ADR 0044). One engine per host process (GUI server, MCP
 * server, CLI). It turns two signals into sync traffic without a button press:
 *
 *   notifyWrite()  the vault was saved in this process → a debounced push
 *   wake()         launch / unlock / foreground → one status request, then a
 *                  FAST-FORWARD-ONLY pull, or a push if we are the ones ahead
 *
 * The one rule that keeps this safe: an automatic pull runs only when the
 * local vault is unchanged since its last sync AND the server is ahead
 * (`syncState` says 'behind'). 'diverged' is surfaced, never resolved here;
 * the desktop hands conflicts to the human exactly as the manual buttons do.
 * A vault with no recorded post-sync baseline counts as changed.
 *
 * Failures back off (30 s, 2 min, 10 min, then hourly). A 402 (subscription)
 * or 403 (private server) pauses the engine: retrying a paywall is noise.
 * `resume()` lifts it at once, and the manual push/pull routes and the
 * server-config route call it. A pause ALSO expires after PAUSE_RETRY_MS
 * (10 min): the next wake() or notifyWrite() after that lifts it and makes one
 * more attempt, because a headless host (the standalone MCP server) has no
 * button to press and would otherwise never push again for the life of the
 * session (sixth review, MCP kill shot). A fresh 402 pauses again for another
 * ten minutes. Every timer is cleared on stop() and nothing runs while locked.
 */

export type AutoSyncPhase = 'off' | 'idle' | 'pending' | 'syncing' | 'synced' | 'error' | 'paused';

export interface AutoSyncStatus {
  phase: AutoSyncPhase;
  /** Last successful push or pull on this machine, from sync.json (shared by every process). */
  lastSyncedAt: string | null;
  /** The last syncState() outcome this engine observed, when it has one. */
  state: SyncState | null;
  /** Human-readable detail for 'error', 'paused' and 'diverged'. */
  message: string | null;
  /** Consecutive failures feeding the backoff. */
  failures: number;
  /** Epoch ms of the next automatic retry, when one is scheduled. */
  nextRetryAt: number | null;
  /** Why the engine is paused, when it is. */
  pausedReason: 'subscription' | 'private' | null;
  /** The last automatic pull this engine made, with where the displaced copy went. */
  lastPull: { version: number; backupPath: string; at: string } | null;
  /** A write is waiting to be pushed (pending, or mid-upload with the debounce drained). */
  pushPending: boolean;
}

export type AutoSyncEvent =
  | { type: 'pushed'; version: number }
  /** backupPath: where the displaced local vault was copied before the pull replaced it. */
  | { type: 'pulled'; version: number; backupPath: string }
  | { type: 'in-sync' }
  | { type: 'diverged' }
  | { type: 'error'; message: string }
  | { type: 'paused'; reason: 'subscription' | 'private' };

export interface AutoSyncOptions {
  vaultPath: string;
  /**
   * A COPY of the master key while the vault is unlocked, else null. The
   * engine zeroes the copy after each operation. Returning null is how "only
   * while unlocked" is enforced: nothing runs, the work stays pending.
   */
  getMasterKey: () => Buffer | null;
  loadDeviceSecret?: () => Buffer;
  onEvent?: (event: AutoSyncEvent) => void;
  /** Push debounce after a write. ADR 0044 default: 5 s. */
  debounceMs?: number;
  /**
   * Longest a write may wait behind a stream of newer writes before it is
   * pushed anyway. A pure trailing-edge debounce starves under a session
   * that saves faster than the debounce (adversarial review 2026-09-03, C3c).
   * Default 30 s.
   */
  maxWaitMs?: number;
  /** Retry schedule after a failure; the last value repeats. */
  backoffMs?: readonly number[];
  /** Tests only: run for a vault that is not the account's default one. */
  allowAnyVault?: boolean;
  /**
   * How long a 402/403 pause holds before a wake or a write may try again.
   * ADR 0044 default: 10 minutes. Overridable for tests only.
   */
  pauseRetryMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 5_000;
const DEFAULT_MAX_WAIT_MS = 30_000;
/** How long a 402/403 pause holds before a wake or a write is allowed one more attempt. */
export const PAUSE_RETRY_MS = 600_000;
/** Suffix of the copy an automatic pull keeps beside the vault (never overwritten by an ordinary save). */
export const AUTO_PULL_BACKUP_SUFFIX = '.auto-pull.bak';
const DEFAULT_BACKOFF_MS: readonly number[] = [30_000, 120_000, 600_000, 3_600_000];

/** The engine's wording for the one case automation refuses. The GUI and CLI phrase the same fact their own way; none asserts that this machine changed. */
export const DIVERGED_MESSAGE =
  "This machine's vault differs from the server's newer copy. Pull first (your current vault is kept as a .bak), then Push.";

export class AutoSync {
  private readonly vaultPath: string;
  private readonly getMasterKey: () => Buffer | null;
  private readonly loadDeviceSecret: () => Buffer;
  private readonly onEvent: (event: AutoSyncEvent) => void;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly backoffMs: readonly number[];
  private readonly pauseRetryMs: number;
  /** When the current pause started; null when not paused. */
  private pausedAt: number | null = null;
  /** When the oldest unpushed write happened; bounds the debounce. */
  private firstPendingAt: number | null = null;
  /** The last automatic pull, for status lines ("pulled v7, previous copy kept at ..."). */
  private lastPull: { version: number; backupPath: string; at: string } | null = null;

  private phase: AutoSyncPhase = 'idle';
  private state: SyncState | null = null;
  private message: string | null = null;
  private failures = 0;
  private nextRetryAt: number | null = null;
  private pausedReason: 'subscription' | 'private' | null = null;

  /** A write happened that has not been pushed yet. */
  private pushPending = false;
  /** Set while the engine itself is saving (push bumps the generation): those saves are not writes to push. */
  private inOwnOperation = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Serializes operations: a wake never overlaps a push. */
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;
  /** False for any vault other than the account's default one: the engine then does nothing (review 2026-09-03, C3). */
  private readonly eligible: boolean;

  constructor(options: AutoSyncOptions) {
    this.vaultPath = options.vaultPath;
    this.getMasterKey = options.getMasterKey;
    this.loadDeviceSecret = options.loadDeviceSecret ?? coreLoadDeviceSecret;
    this.onEvent = options.onEvent ?? (() => {});
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.pauseRetryMs = options.pauseRetryMs ?? PAUSE_RETRY_MS;
    this.eligible = options.allowAnyVault === true || isAutoSyncVault(options.vaultPath);
  }

  /** Feed this from core's onVaultSave; paths that are not this vault are ignored. */
  notifyWrite(savedPath?: string): void {
    if (this.stopped || !this.eligible || this.inOwnOperation) return;
    if (savedPath !== undefined && savedPath !== this.vaultPath) return;
    this.pushPending = true;
    if (this.firstPendingAt === null) this.firstPendingAt = Date.now();
    this.expirePause();
    if (this.pausedReason !== null) return; // stays pending until resume() or the pause expires
    if (this.phase !== 'syncing') this.phase = 'pending';
    this.armDebounce();
  }

  /**
   * Launch / unlock / foreground. One status request; then a fast-forward pull
   * if the server is ahead and we are untouched, a push if we are ahead, and
   * nothing but a status line when both sides moved.
   */
  wake(): Promise<void> {
    if (!this.eligible) return Promise.resolve();
    // A pause older than pauseRetryMs is lifted here, so a headless host gets
    // one more attempt per ten minutes instead of nothing for the session.
    this.expirePause();
    return this.enqueue(() => this.runWake());
  }

  /** Run any pending push now (CLI exit, process shutdown). Resolves when done or when nothing was pending. */
  flush(): Promise<void> {
    this.clearDebounce();
    if (!this.pushPending) return this.chain;
    return this.enqueue(() => this.runPush(true));
  }

  /**
   * Run a user-driven push or pull (the GUI buttons, `northkeep sync push`)
   * through the engine so its own saves are not mistaken for new writes and
   * the pending flag reflects the outcome. Also lifts a 402/403 pause, since
   * the user just acted. Errors propagate to the caller unchanged.
   */
  async runManual<T>(op: () => Promise<T>): Promise<T> {
    this.resume();
    let result!: T;
    await this.enqueue(async () => {
      this.inOwnOperation = true;
      this.phase = 'syncing';
      try {
        result = await op();
        if (this.matchesRecordedSha()) {
          this.pushPending = false;
          this.firstPendingAt = null;
          this.settle('in-sync');
        } else {
          // Bytes differ from the server's: a write landed during the manual
          // operation (or it was a pull and a write followed). Push it next.
          this.rearmAfterManual();
        }
      } catch (err) {
        // The same question on the failure path. A write that landed while a
        // manual Push or Pull was failing was swallowed by inOwnOperation and
        // then dropped, because only the success path re-checked the hash
        // (sixth review, desktop flesh wound). The op failing says nothing
        // about whether the bytes on disk still match the server's.
        if (this.matchesRecordedSha()) {
          this.phase = this.pushPending ? 'pending' : 'idle';
        } else {
          this.rearmAfterManual();
        }
        throw err;
      } finally {
        this.inOwnOperation = false;
      }
    });
    return result;
  }

  /** Lift a 402/403 pause. Called on the next explicit user action (manual push/pull, server change). */
  resume(): void {
    if (this.pausedReason === null) return;
    this.pausedReason = null;
    this.pausedAt = null;
    this.failures = 0;
    this.message = null;
    this.phase = this.pushPending ? 'pending' : 'idle';
    if (this.pushPending) this.armDebounce();
  }

  /** Clear every timer. The engine accepts no more work after this. Idempotent: a second stop() is a no-op. */
  stop(): void {
    this.stopped = true;
    this.clearDebounce();
    this.clearRetry();
  }

  status(): AutoSyncStatus {
    const config = loadSyncConfig();
    return {
      phase: config === null || !this.eligible ? 'off' : this.phase,
      lastSyncedAt: config?.lastSyncedAt ?? null,
      state: this.state,
      message: this.message,
      failures: this.failures,
      nextRetryAt: this.nextRetryAt,
      pausedReason: this.pausedReason,
      lastPull: this.lastPull,
      pushPending: this.pushPending,
    };
  }

  // --- internals ---

  /**
   * True when the file on disk still hashes to the sha recorded for the last
   * sync, i.e. there is nothing to push. A missing config or a null lastSha
   * counts as "not matching", so a machine with no baseline pushes.
   */
  private matchesRecordedSha(): boolean {
    const config = loadSyncConfig();
    return config?.lastSha !== null && config?.lastSha === this.localSha();
  }

  /** Mark a write pending after a manual operation and put it on the debounce. */
  private rearmAfterManual(): void {
    this.pushPending = true;
    if (this.firstPendingAt === null) this.firstPendingAt = Date.now();
    this.phase = 'pending';
    this.armDebounce();
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    const next = this.chain.then(op, op);
    this.chain = next.catch(() => {});
    return next;
  }

  private armDebounce(): void {
    if (this.stopped) return;
    this.clearDebounce();
    // Trailing-edge debounce, capped: a write never waits more than maxWaitMs
    // behind newer writes.
    const deadline = (this.firstPendingAt ?? Date.now()) + this.maxWaitMs;
    const delay = Math.max(0, Math.min(this.debounceMs, deadline - Date.now()));
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.enqueue(() => this.runPush());
    }, delay);
    unrefTimer(this.debounceTimer);
  }

  private clearDebounce(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.nextRetryAt = null;
  }

  private scheduleRetry(retry: () => Promise<void>): void {
    if (this.stopped) return;
    this.clearRetry();
    const delay = this.backoffMs[Math.min(this.failures, this.backoffMs.length) - 1] ?? this.backoffMs[0] ?? 30_000;
    this.nextRetryAt = Date.now() + delay;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.nextRetryAt = null;
      void this.enqueue(retry);
    }, delay);
    unrefTimer(this.retryTimer);
  }

  /**
   * @param ignoreBackoff true for the scheduled retry itself and for flush();
   *   a write that lands during a backoff window waits for the retry instead of
   *   hammering a failing server.
   */
  private async runPush(ignoreBackoff = false): Promise<void> {
    if (this.stopped || !this.pushPending || this.pausedReason !== null) return;
    if (!ignoreBackoff && this.nextRetryAt !== null && Date.now() < this.nextRetryAt) return;
    if (loadSyncConfig() === null) {
      this.pushPending = false;
      this.phase = 'idle';
      return;
    }
    const key = this.getMasterKey();
    if (key === null) {
      // Locked: the write stays pending and the next unlock's wake() drains it.
      this.phase = 'pending';
      return;
    }
    this.phase = 'syncing';
    this.inOwnOperation = true;
    try {
      const deviceSecret = this.loadDeviceSecret();
      // A write that left the bytes identical to the last sync (or a stale
      // pending flag) is nothing to upload.
      if (this.matchesRecordedSha()) {
        this.pushPending = false;
        this.firstPendingAt = null;
        this.settle('in-sync');
        return;
      }
      const result = await pushVault({ vaultPath: this.vaultPath, deviceSecret, masterKey: key });
      if (result.ok) {
        this.afterPush(result.version);
        return;
      }
      // 409: the server moved past the base we pushed from. Re-read where we
      // stand. If the server already holds these bytes there is nothing to do;
      // if another process on this machine merely refreshed the base, push
      // once more from it; a real two-sided change is reported, never
      // resolved here. The human resolves it, as before.
      const s = await syncState({ vaultPath: this.vaultPath, deviceSecret });
      if (s.state === 'in-sync') {
        this.pushPending = false;
        this.firstPendingAt = null;
        this.settle('in-sync');
        return;
      }
      if (s.state === 'ahead' || s.state === 'no-remote') {
        const again = await pushVault({ vaultPath: this.vaultPath, deviceSecret, masterKey: Buffer.from(key) });
        if (again.ok) {
          this.afterPush(again.version);
          return;
        }
        // Twice refused from a base the server itself reported: the server
        // was restored from a backup or wiped under us. Say so and back off
        // rather than parking silently (review 2026-09-03, E7).
        this.pushPending = true;
        throw new Error(
          'The sync server refused this base version twice; it may have been restored or reset. Pull, then Push, from the app or CLI.',
        );
      }
      this.pushPending = true;
      this.reportState(s.state);
    } catch (err) {
      this.fail(err, () => this.runPush(true));
    } finally {
      memzero(key);
      this.inOwnOperation = false;
    }
  }

  private async runWake(): Promise<void> {
    if (this.stopped || this.pausedReason !== null) return;
    if (loadSyncConfig() === null) {
      this.phase = 'idle';
      return;
    }
    const key = this.getMasterKey();
    if (key === null) return; // locked: verification needs the key; report the age only
    this.phase = 'syncing';
    this.inOwnOperation = true;
    try {
      const deviceSecret = this.loadDeviceSecret();
      const s = await syncState({ vaultPath: this.vaultPath, deviceSecret });
      switch (s.state) {
        case 'behind': {
          // Fast-forward: the server is ahead and this file is untouched since
          // its last sync. pullVault verifies the download opens with our key
          // before it replaces anything, re-checks under the vault lock that
          // the file still hashes to what we decided on (a write that landed
          // during the download throws LocalChangedError and nothing is
          // replaced), and keeps the displaced copy at a path ordinary saves
          // never touch, written only when the swap happens.
          // Beside the real file, which is where the rolling .bak lands too
          // when the vault is a symlink.
          const backupPath = resolveVaultLink(this.vaultPath) + AUTO_PULL_BACKUP_SUFFIX;
          let pulled;
          try {
            pulled = await pullVault({
              vaultPath: this.vaultPath,
              deviceSecret,
              masterKey: key,
              expectLocalSha: s.localSha ?? undefined,
              keepCopyAt: backupPath,
            });
          } catch (err) {
            if (!(err instanceof LocalChangedError)) throw err;
            // Someone wrote while we downloaded. Decide again from the new bytes.
            const again = await syncState({ vaultPath: this.vaultPath, deviceSecret });
            if (again.state === 'ahead') {
              this.pushPending = true;
              this.inOwnOperation = false;
              memzero(key);
              await this.runPush(true);
            } else {
              this.reportState(again.state);
            }
            return;
          }
          if (pulled.ok) {
            this.lastPull = { version: pulled.version, backupPath, at: new Date().toISOString() };
            this.settle('in-sync');
            this.onEvent({ type: 'pulled', version: pulled.version, backupPath });
          } else {
            this.settle('no-remote');
          }
          return;
        }
        case 'ahead':
        case 'no-remote':
          // We hold edits the server lacks (or the server is empty): push.
          this.pushPending = true;
          this.inOwnOperation = false;
          memzero(key);
          await this.runPush(true);
          return;
        case 'in-sync':
          this.settle('in-sync');
          return;
        default:
          // diverged, no-local, no-config: report, never act.
          this.reportState(s.state);
          return;
      }
    } catch (err) {
      this.fail(err, () => this.runWake());
    } finally {
      memzero(key); // harmless when the 'ahead' branch already zeroed it
      this.inOwnOperation = false;
    }
  }

  /**
   * A push landed. The upload held no vault lock, so a write may have landed
   * meanwhile (and the save hook was ignored while our operation ran): if the
   * file no longer hashes to what the server holds, it is pending again and
   * goes on the next debounce (review 2026-09-03, D8).
   */
  private afterPush(version: number): void {
    const recorded = loadSyncConfig()?.lastSha ?? null;
    const now = this.localSha();
    const stillPending = recorded !== null && now !== null && now !== recorded;
    this.pushPending = stillPending;
    this.firstPendingAt = stillPending ? Date.now() : null;
    this.settle('in-sync');
    this.onEvent({ type: 'pushed', version });
    if (stillPending) this.armDebounce();
  }

  private settle(state: SyncState): void {
    this.state = state;
    this.message = null;
    this.failures = 0;
    this.clearRetry();
    this.phase = this.pushPending ? 'pending' : 'synced';
    if (state === 'in-sync') this.onEvent({ type: 'in-sync' });
  }

  private reportState(state: SyncState): void {
    this.state = state;
    this.failures = 0;
    this.clearRetry();
    if (state === 'diverged') {
      this.phase = 'error';
      this.message = DIVERGED_MESSAGE;
      this.onEvent({ type: 'diverged' });
    } else {
      this.phase = this.pushPending ? 'pending' : 'idle';
      this.message = null;
    }
  }

  private fail(err: unknown, retry: () => Promise<void>): void {
    if (err instanceof SubscriptionRequiredError) {
      this.pause('subscription', err.message);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/HTTP 403/.test(message)) {
      this.pause('private', 'This sync server is private and does not list this account.');
      return;
    }
    this.failures += 1;
    this.phase = 'error';
    this.message = message;
    this.onEvent({ type: 'error', message });
    this.scheduleRetry(retry);
  }

  /**
   * Lift a pause that has held longer than pauseRetryMs, so the next wake or
   * write makes one more attempt. A fresh 402/403 pauses again, emitting the
   * same 'paused' event, so a host that logs events still says why. Called
   * only from wake() and notifyWrite(): flush() at exit must NOT lift a pause,
   * because reporting the still-pending write is what the exit line is for.
   */
  private expirePause(): void {
    if (this.pausedReason === null || this.pausedAt === null) return;
    if (Date.now() - this.pausedAt < this.pauseRetryMs) return;
    this.resume();
  }

  private pause(reason: 'subscription' | 'private', message: string): void {
    this.pausedReason = reason;
    this.pausedAt = Date.now();
    this.phase = 'paused';
    this.message = message;
    this.clearDebounce();
    this.clearRetry();
    this.onEvent({ type: 'paused', reason });
  }

  private localSha(): string | null {
    try {
      return createHash('sha256').update(fs.readFileSync(this.vaultPath)).digest('hex');
    } catch {
      return null;
    }
  }
}

/** Timers must never keep a CLI or a shutting-down server alive. */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const t = timer as unknown as { unref?: () => void };
  if (typeof t.unref === 'function') t.unref();
}

/**
 * Human wording for "last synced N ago", shared by the GUI, the CLI and the
 * status line so the three never drift. Null when never synced.
 */
export function syncAge(lastSyncedAt: string | null, now: number = Date.now()): string | null {
  if (!lastSyncedAt) return null;
  const then = Date.parse(lastSyncedAt);
  if (Number.isNaN(then)) return null;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
