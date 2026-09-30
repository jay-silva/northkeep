import { loadDeviceSecret as coreLoadDeviceSecret, memzero, Vault, withFileLock } from '@northkeep/core';
import { PAUSE_RETRY_MS, type AutoSyncClock, type AutoSyncStatus } from './auto.js';
import { isAutoSyncVault, syncState } from './client.js';
import { loadSyncConfig } from './config.js';
import { ConnectorStalePushError, ConnectorTombstoneError, fetchEntitlement, getConnectorManifest } from './connector-client.js';
import { deriveSyncCreds } from './creds.js';
import { connectorAutoPushEnabled, connectorLastPushedAt, connectorPushFingerprint, loadConnectorConfig } from './connector-config.js';
import { connectorHoldsSnapshot, pushSnapshot, snapshotSharedScopes, vaultServerHash, type SharedSnapshot } from './connector-push.js';

/**
 * ConnectorAutoPush (ADR 0063 D5). Keeps Cloud Connect's copy of the shared
 * scopes current without a button, but only from a device that holds the
 * newest vault: it runs after AutoSync pushes the vault, or on a wake that
 * finds this device exactly in sync, and sends that sync-server version so
 * the connector can refuse an older copy (HTTP 428). It pushes only, never
 * down-syncs, never marks a scope, sends only scopes already Shared, and
 * pushes only when the shared entries differ from the last accepted push or
 * from what the connector holds (its content-free manifest).
 * A device with no vault sync is the only copy of its vault, so it pushes on
 * a debounced save and sends no version.
 */

export type ConnectorAutoPushReason =
  | 'switched_off'
  | 'not_configured'
  | 'other_vault'
  | 'nothing_shared'
  | 'locked'
  | 'auto_sync_off'
  | 'auto_sync_error'
  | 'behind'
  | 'diverged'
  | 'ahead'
  | 'pull_refused'
  | 'tombstone_off'
  | 'subscription'
  | 'reencrypt'
  | 'tombstone'
  | 'stale_push'
  | 'error';

export type ConnectorAutoPushPhase = 'off' | 'idle' | 'pending' | 'pushing' | 'paused' | 'error';

export interface ConnectorAutoPushStatus {
  enabled: boolean;
  phase: ConnectorAutoPushPhase;
  /** Why the engine is not pushing right now, when it is not. */
  reason: ConnectorAutoPushReason | null;
  message: string | null;
  last_pushed_at: string | null;
}

export type ConnectorAutoPushEvent =
  | { type: 'pushed'; scopes: string[]; vault_version: number | null }
  | { type: 'paused'; reason: ConnectorAutoPushReason; message: string }
  | { type: 'error'; message: string };

/** What the Cloud screen and the CLI say for each reason. */
export const CONNECTOR_AUTO_PUSH_MESSAGES: Record<ConnectorAutoPushReason, string> = {
  switched_off: 'Automatic updates are off, so Cloud Connect updates only when you push.',
  not_configured: 'No connector server is set up on this device.',
  other_vault: 'Cloud Connect is updated automatically from your main vault only.',
  nothing_shared: 'Nothing is shared, so there is nothing to send to Cloud Connect.',
  locked: 'The vault is locked. Cloud Connect updates after you unlock it.',
  auto_sync_off: 'Automatic sync is off, so Cloud Connect updates only when you push.',
  auto_sync_error: 'Automatic sync hit a problem, so Cloud Connect waits until sync works again.',
  behind: 'This Mac is behind your other devices. Cloud Connect will update after it catches up.',
  diverged: 'This Mac and your other devices both have changes. Cloud Connect will update after you sync this Mac.',
  ahead: 'Cloud Connect will update after this Mac finishes syncing.',
  pull_refused: 'A pull from your other devices is waiting for your review, so Cloud Connect waits too.',
  tombstone_off: 'Cloud Connect is not refusing pushes to unshared scopes, so automatic push is off. You can still push by hand.',
  subscription: 'Cloud Connect needs an active subscription, so automatic updates are paused.',
  reencrypt: 'Cloud Connect cannot read this account\'s shared data. Run "northkeep share push" to re-encrypt it.',
  tombstone: 'Cloud Connect refused a scope you unshared elsewhere. Re-share it deliberately if you want it back.',
  stale_push:
    'Another device pushed a newer copy to Cloud Connect, so automatic updates are paused. Sync this Mac, then push by hand. ' +
    'If this Mac is already in sync (for example after your sync server was reset), run: northkeep share push --reset-order',
  error: 'Cloud Connect could not be updated. It will try again after the next change.',
};

/** Reasons that hold until the user acts (a manual push, the switch, a server change). */
const STICKY: ReadonlySet<ConnectorAutoPushReason> = new Set(['subscription', 'reencrypt', 'tombstone', 'stale_push']);

export interface ConnectorAutoPushOptions {
  vaultPath: string;
  /** A COPY of the master key while unlocked, else null. The engine zeroes it. */
  getMasterKey: () => Buffer | null;
  loadDeviceSecret?: () => Buffer;
  /** The host's AutoSync status; null when the host runs no engine (the CLI). */
  autoSyncStatus?: () => AutoSyncStatus | null;
  /** Entitlement for the connector's billing gate. Default: the same best-effort attestation the manual pushes forward. */
  entitlement?: (deviceSecret: Buffer) => Promise<string | undefined>;
  onEvent?: (event: ConnectorAutoPushEvent) => void;
  /** Default 5 s, like AutoSync. */
  debounceMs?: number;
  clock?: AutoSyncClock;
  /** Tests only. */
  allowAnyVault?: boolean;
  pauseRetryMs?: number;
}

/**
 * The anonymous "active subscriber" attestation from the sync server, which
 * the hosted connector's billing gate requires on every /client call. Absent
 * with no vault sync or no bridge; never fails the push by itself.
 */
async function bestEffortEntitlement(deviceSecret: Buffer): Promise<string | undefined> {
  const sync = loadSyncConfig();
  if (sync === null) return undefined;
  try {
    return (await fetchEntitlement({ syncServer: sync.serverUrl, syncToken: deriveSyncCreds(deviceSecret).token })) ?? undefined;
  } catch {
    return undefined;
  }
}

const SYSTEM_CLOCK: AutoSyncClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class ConnectorAutoPush {
  private readonly opts: ConnectorAutoPushOptions;
  private readonly clock: AutoSyncClock;
  private readonly eligible: boolean;
  private phase: ConnectorAutoPushPhase = 'idle';
  private reason: ConnectorAutoPushReason | null = null;
  private message: string | null = null;
  private sticky: { reason: ConnectorAutoPushReason; at: number } | null = null;
  private debounceTimer: unknown = null;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(options: ConnectorAutoPushOptions) {
    this.opts = options;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.eligible = options.allowAnyVault === true || isAutoSyncVault(options.vaultPath);
  }

  /** Feed from core's onVaultSave. Acts only on a device with no vault sync; otherwise AutoSync's push is the trigger. */
  notifyWrite(savedPath?: string): void {
    if (savedPath !== undefined && savedPath !== this.opts.vaultPath) return;
    if (loadSyncConfig() !== null) return;
    this.arm();
  }

  /** AutoSync pushed, pulled or found this device in sync: the vault is current, so check for a change to send. */
  onVaultCurrent(): void {
    this.arm();
  }

  /** Launch or unlock: run once now. */
  wake(): Promise<void> {
    return this.enqueue(() => this.run());
  }

  /** The CLI: one run, awaited. */
  runOnce(): Promise<ConnectorAutoPushStatus> {
    return this.enqueue(() => this.run()).then(() => this.status());
  }

  /** Lift a sticky pause: the user pushed by hand, flipped the switch, or changed server. */
  resume(): void {
    this.sticky = null;
    if (this.phase === 'paused') this.set('idle', null);
  }

  stop(): void {
    this.stopped = true;
    if (this.debounceTimer !== null) this.clock.clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  async whenIdle(): Promise<void> {
    let seen: Promise<void>;
    do {
      seen = this.chain;
      await seen;
    } while (seen !== this.chain);
  }

  status(): ConnectorAutoPushStatus {
    const enabled = connectorAutoPushEnabled();
    const configured = loadConnectorConfig() !== null;
    const off: ConnectorAutoPushReason | null = !configured ? 'not_configured' : !enabled ? 'switched_off' : !this.eligible ? 'other_vault' : null;
    return {
      enabled,
      phase: off ? 'off' : this.phase,
      reason: off ?? this.reason,
      message: off ? CONNECTOR_AUTO_PUSH_MESSAGES[off] : this.message,
      last_pushed_at: connectorLastPushedAt(),
    };
  }

  private arm(): void {
    if (this.stopped) return;
    if (this.debounceTimer !== null) this.clock.clearTimeout(this.debounceTimer);
    if (this.phase !== 'pushing' && this.phase !== 'paused') this.phase = 'pending';
    this.debounceTimer = this.clock.setTimeout(() => {
      this.debounceTimer = null;
      void this.enqueue(() => this.run());
    }, this.opts.debounceMs ?? 5_000);
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    const next = this.chain.then(op, op);
    this.chain = next.catch(() => {});
    return next;
  }

  private set(phase: ConnectorAutoPushPhase, reason: ConnectorAutoPushReason | null, message?: string): void {
    this.phase = phase;
    this.reason = reason;
    this.message = reason === null ? null : (message ?? CONNECTOR_AUTO_PUSH_MESSAGES[reason]);
  }

  private pause(reason: ConnectorAutoPushReason, message?: string): void {
    const changed = this.reason !== reason || this.phase !== 'paused';
    this.set('paused', reason, message);
    if (STICKY.has(reason)) this.sticky = { reason, at: this.clock.now() };
    if (changed) this.opts.onEvent?.({ type: 'paused', reason, message: this.message! });
  }

  private async run(): Promise<void> {
    if (this.stopped) return;
    const connector = loadConnectorConfig();
    if (connector === null || !connectorAutoPushEnabled() || !this.eligible) {
      this.set('off', null);
      return;
    }
    if (this.sticky !== null) {
      const expired = this.sticky.reason === 'subscription' && this.clock.now() - this.sticky.at >= (this.opts.pauseRetryMs ?? PAUSE_RETRY_MS);
      if (!expired) return;
      this.sticky = null;
    }
    const key = this.opts.getMasterKey();
    if (key === null) {
      this.set('pending', 'locked');
      return;
    }
    try {
      // Local checks first: a device with nothing shared makes no network call
      // at all (asking the connector anything would create an account there,
      // or answer 402). An unchanged fingerprint means a push was accepted, so
      // the account exists.
      const gate = await this.snapshot(key);
      if (gate.scopes.length === 0) {
        this.set('idle', 'nothing_shared');
        return;
      }
      const sync = loadSyncConfig();
      // With no vault sync no other device changes this vault, so the last
      // accepted push is still what Cloud Connect should hold.
      if (sync === null && gate.fingerprint === connectorPushFingerprint()) {
        this.set('idle', null);
        return;
      }
      const deviceSecret = (this.opts.loadDeviceSecret ?? coreLoadDeviceSecret)();
      let vaultStamp: { server: string; version: number } | undefined;
      if (sync !== null) {
        const auto = this.opts.autoSyncStatus?.() ?? null;
        if (auto !== null) {
          if (auto.pullRefusal !== null) return this.pause('pull_refused');
          if (auto.state === 'diverged') return this.pause('diverged');
          if (auto.phase === 'off' || auto.phase === 'paused') return this.pause('auto_sync_off');
          if (auto.phase === 'error') return this.pause('auto_sync_error');
        }
        // Exactly in sync: "ahead" is not enough, two devices can each be ahead of one version.
        const s = await syncState({ vaultPath: this.opts.vaultPath, deviceSecret });
        if (s.state === 'behind') return this.pause('behind');
        if (s.state === 'diverged') return this.pause('diverged');
        if (s.state !== 'in-sync' || s.remoteVersion === null) {
          this.set('pending', 'ahead');
          return;
        }
        vaultStamp = { server: vaultServerHash(sync.serverUrl), version: s.remoteVersion };
      }
      const entitlement = await (this.opts.entitlement ?? bestEffortEntitlement)(deviceSecret);
      const manifest = await getConnectorManifest({ server: connector.server, deviceSecret, ...(entitlement ? { entitlement } : {}) });
      if (!manifest.tombstone_enforce) return this.pause('tombstone_off');

      // Taken again after syncState: the gate's copy may predate a pull that
      // syncState then reports, and older entries must never carry a newer version.
      const snapshot = await this.snapshot(key);
      if (snapshot.scopes.length === 0) {
        this.set('idle', 'nothing_shared');
        return;
      }
      // Compared with what the connector holds, not only with this device's
      // last push: another device's ack or a pulled vault version can change
      // either side without this device writing anything.
      if (snapshot.fingerprint === connectorPushFingerprint() && connectorHoldsSnapshot(snapshot, manifest.entries)) {
        this.set('idle', null);
        return;
      }
      this.set('pushing', null);
      try {
        await pushSnapshot({ server: connector.server, deviceSecret, snapshot, ...(entitlement ? { entitlement } : {}), ...(vaultStamp ? { vaultStamp } : {}) });
      } catch (err) {
        if (err instanceof ConnectorTombstoneError && !(await this.stillShared(key, err.scopes))) {
          // A deliberate unshare here raced this push: the next run's snapshot no longer holds it.
          this.set('idle', null);
          this.arm();
          return;
        }
        throw err;
      }
      this.set('idle', null);
      this.opts.onEvent?.({ type: 'pushed', scopes: snapshot.scopes, vault_version: vaultStamp?.version ?? null });
    } catch (err) {
      if (err instanceof ConnectorStalePushError) return this.pause('stale_push');
      if (err instanceof ConnectorTombstoneError) return this.pause('tombstone', err.message);
      const message = err instanceof Error ? err.message : String(err);
      if (/HTTP 402/.test(message)) return this.pause('subscription');
      if (/\(409\)/.test(message)) return this.pause('reencrypt');
      this.set('error', 'error', message);
      this.opts.onEvent?.({ type: 'error', message });
    } finally {
      memzero(key);
    }
  }

  private snapshot(key: Buffer): Promise<SharedSnapshot> {
    return withFileLock(this.opts.vaultPath, () => {
      const vault = Vault.openWithKey(this.opts.vaultPath, Buffer.from(key));
      try {
        return snapshotSharedScopes(vault);
      } finally {
        vault.close();
      }
    });
  }

  private async stillShared(key: Buffer, scopes: string[]): Promise<boolean> {
    return withFileLock(this.opts.vaultPath, () => {
      const vault = Vault.openWithKey(this.opts.vaultPath, Buffer.from(key));
      try {
        const shared = new Set(vault.sharedScopes());
        return scopes.length === 0 || scopes.some((s) => shared.has(s));
      } finally {
        vault.close();
      }
    });
  }
}
