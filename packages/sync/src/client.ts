import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  Vault,
  VaultAuthError,
  VaultSyncGenerationError,
  defaultVaultPath,
  FileLockTimeoutError,
  withFileLock,
} from '@northkeep/core';
import { deriveSyncCreds } from './creds.js';
import { assertSyncUrl, loadSyncConfig, saveSyncConfig, type SyncConfig } from './config.js';

/**
 * The sync client (ADR 0009). Pushes/pulls the opaque `.nkv` ciphertext blob
 * to the ciphertext-only server. Transport conventions match converse's raw
 * fetch: `redirect:'error'` (a redirect could re-send the token/blob to an
 * attacker's Location), `AbortSignal.timeout`, and status-only error messages
 * (never echo response bodies).
 */

const NKV_MAGIC = Buffer.from('NKV1', 'ascii');
const NKV_HEADER_LENGTH = 52;
const STATUS_TIMEOUT_MS = 15_000;
const BLOB_TIMEOUT_MS = 120_000;
export const MAX_BLOB_BYTES = 4 * 1024 * 1024;

/** Thrown when the server requires a subscription (HTTP 402) — surfaces a subscribe prompt. */
export class SubscriptionRequiredError extends Error {
  constructor() {
    super('This sync server requires a $10/month subscription. Run "northkeep sync subscribe".');
    this.name = 'SubscriptionRequiredError';
  }
}

export interface SubscriptionStatus {
  /** Does this server require (and offer) a subscription at all? A 200 from the
   * subscription endpoint means billing is on; a 404 means it isn't. This is the
   * only signal that distinguishes "new user who must subscribe" (status null,
   * billing true) from "self-hosted server that doesn't bill" (status null,
   * billing false). */
  billing: boolean;
  active: boolean;
  status: string | null;
  currentPeriodEnd: number | null;
}

export interface RemoteStatus {
  version: number;
  sha256: string;
  size: number;
  updatedAt: string;
}

export interface PushResult {
  ok: boolean;
  /** On success, the new server version; on conflict, the server's current version. */
  version: number;
  conflict: boolean;
}

export type PullResult =
  | { ok: true; version: number; wroteVault: boolean }
  | { ok: false; reason: 'no-remote' };

export type SyncState =
  | 'no-config'
  | 'no-remote'
  | 'no-local'
  | 'in-sync'
  | 'ahead'
  | 'behind'
  | 'diverged';

// --- raw transport ---

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function remoteStatus(serverUrl: string, token: string): Promise<RemoteStatus | null> {
  const res = await fetch(`${serverUrl}/api/status`, {
    headers: authHeaders(token),
    redirect: 'error',
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (res.status === 402) throw new SubscriptionRequiredError();
  if (!res.ok) throw new Error(`Sync server returned HTTP ${res.status} on status.`);
  const body = (await res.json()) as RemoteStatus;
  return body;
}

async function pullBlob(
  serverUrl: string,
  token: string,
): Promise<{ blob: Buffer; version: number; sha256: string } | null> {
  const res = await fetch(`${serverUrl}/api/blob`, {
    headers: authHeaders(token),
    redirect: 'error',
    signal: AbortSignal.timeout(BLOB_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (res.status === 402) throw new SubscriptionRequiredError();
  if (!res.ok) throw new Error(`Sync server returned HTTP ${res.status} on pull.`);
  const blob = Buffer.from(await res.arrayBuffer());
  const version = Number(res.headers.get('x-version') ?? '0');
  const sha256 = res.headers.get('x-sha256') ?? '';
  return { blob, version, sha256 };
}

async function pushBlob(
  serverUrl: string,
  token: string,
  blob: Buffer,
  baseVersion: number,
): Promise<PushResult> {
  const res = await fetch(`${serverUrl}/api/blob`, {
    method: 'PUT',
    headers: {
      ...authHeaders(token),
      'content-type': 'application/octet-stream',
      'x-base-version': String(baseVersion),
    },
    body: blob,
    redirect: 'error',
    signal: AbortSignal.timeout(BLOB_TIMEOUT_MS),
  });
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { version?: number };
    return { ok: false, conflict: true, version: body.version ?? baseVersion };
  }
  if (res.status === 402) throw new SubscriptionRequiredError();
  if (!res.ok) throw new Error(`Sync server returned HTTP ${res.status} on push.`);
  const body = (await res.json()) as { version: number };
  return { ok: true, conflict: false, version: body.version };
}

// --- helpers ---

function requireConfig(): SyncConfig {
  const config = loadSyncConfig();
  if (!config) {
    throw new Error('Sync is not configured. Run: northkeep sync config --server <url>');
  }
  assertSyncUrl(config.serverUrl);
  return config;
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** A well-formed vault blob starts with the NKV1 magic and carries a full header. */
function isVaultBlob(blob: Buffer): boolean {
  // Buffer.compare, not subarray().equals() — see vault.ts:158. This module is
  // node:fs-coupled so it does not run on Hermes today, but keeping the two
  // copies of this check identical is what stops the bug coming back.
  return blob.length >= NKV_HEADER_LENGTH && Buffer.compare(blob.subarray(0, 4), NKV_MAGIC) === 0;
}

// --- high-level operations ---

/**
 * The sync lock (ADR 0044 review): serializes PUSHERS and PULLERS on this
 * machine across their whole operation, so two host processes never push
 * from the same base, while the vault's own file lock is held only for the
 * local snapshot and the final swap. Readers and writers of the vault are
 * therefore never blocked by a slow or hung server.
 *
 * The wait MUST be longer than the stale window. A foreign process that is
 * alive but has held the lock past the stale window is only stolen from
 * inside the wait loop, so a wait shorter than the window meant such a lock
 * was never stolen and every sync failed busy until that process exited
 * (ADR 0044 fourth review). Stale stays above a full blob transfer so a
 * genuinely slow upload is not stolen out from under itself.
 */
export const SYNC_LOCK_STALE_MS = BLOB_TIMEOUT_MS + 60_000;
export const SYNC_LOCK_TIMEOUT_MS = SYNC_LOCK_STALE_MS + 30_000;

/** Another process on this machine is pushing or pulling and the caller chose not to wait for it. */
export class SyncBusyError extends Error {
  constructor() {
    super('Another NorthKeep process is syncing this vault right now.');
    this.name = 'SyncBusyError';
  }
}

async function withSyncLock<T>(vaultPath: string, fn: () => Promise<T>, waitMs = SYNC_LOCK_TIMEOUT_MS): Promise<T> {
  let acquired = false;
  try {
    return await withFileLock(
      `${vaultPath}.sync`,
      () => {
        acquired = true;
        return fn();
      },
      { timeoutMs: waitMs, staleMs: SYNC_LOCK_STALE_MS },
    );
  } catch (err) {
    if (!acquired && err instanceof FileLockTimeoutError) throw new SyncBusyError();
    throw err;
  }
}

/**
 * Automatic sync applies to the account's vault only (ADR 0044 review): the
 * sync config is per account and holds one server copy, so a write to some
 * other `--vault` must not push that file over it. Manual push/pull keep
 * working for any path, as before.
 */
export function isAutoSyncVault(vaultPath: string): boolean {
  return canonicalPath(vaultPath) === canonicalPath(defaultVaultPath());
}

/**
 * The real path when the file exists, the resolved path otherwise. A symlink
 * to the default vault, or (on a case-insensitive filesystem) a differently
 * cased spelling of it, IS the default vault, and comparing the spellings
 * would have called it "another vault" and silently stopped syncing it
 * (ADR 0044 fourth review). `realpathSync.native` is what normalises case;
 * it throws for a path that does not exist yet, and can throw EACCES on a
 * directory we may not traverse, so both fall back to `path.resolve`.
 */
function canonicalPath(p: string): string {
  const resolved = path.resolve(p);
  try {
    const real = fs.realpathSync.native ?? fs.realpathSync;
    return real(resolved);
  } catch {
    return resolved;
  }
}

/**
 * The file a vault path really names: a symlink's target, resolved even when
 * the target does not exist yet. A vault that is a symlink (into iCloud, onto
 * an external disk) must survive a pull the way it survives a save: renaming
 * the downloaded copy over the LINK replaces it with a regular file, and
 * `isAutoSyncVault` would then call it another vault and switch automatic sync
 * off in silence (ADR 0044 sixth review). platform-node's writeAtomic resolves
 * the same way, so both directions land on the same file.
 */
export function resolveVaultLink(vaultPath: string): string {
  try {
    if (!fs.lstatSync(vaultPath).isSymbolicLink()) return vaultPath;
  } catch {
    return vaultPath;
  }
  try {
    return fs.realpathSync(vaultPath);
  } catch {
    try {
      return path.resolve(path.dirname(vaultPath), fs.readlinkSync(vaultPath));
    } catch {
      return vaultPath;
    }
  }
}

/** Thrown by pullVault when the local vault changed between the caller's decision and the swap. Nothing was replaced. */
export class LocalChangedError extends Error {
  constructor() {
    super('The local vault changed while the download ran, so it was not replaced.');
    this.name = 'LocalChangedError';
  }
}

/**
 * Push the local vault to the server, in three phases. Under the vault lock:
 * read the base version, stamp the sync generation, snapshot the bytes. With
 * no vault lock: upload. Under the vault lock again: record the result. The
 * generation increment is kept even if the server returns 409 (ADR 0038
 * addendum). Unlock-to-push: `masterKey` is required. The whole thing runs
 * under the sync lock so another pusher on this machine waits for our record
 * and pushes from the version we leave behind.
 */
export async function pushVault(options: {
  vaultPath: string;
  deviceSecret: Buffer;
  /** Copy is passed to openWithKey (which zeroes its input). */
  masterKey: Buffer;
  /** How long to wait for another syncer on this machine; throws SyncBusyError after. Default: longer than a transfer. */
  syncLockWaitMs?: number;
}): Promise<PushResult> {
  const { token } = deriveSyncCreds(options.deviceSecret);
  return withSyncLock(options.vaultPath, async () => {
    const snapshot = await withFileLock(options.vaultPath, () => {
      const config = requireConfig();
      if (!fs.existsSync(options.vaultPath)) {
        throw new Error('No local vault to push. Run "northkeep init" first.');
      }
      // One bump per LOGICAL push, however many attempts it takes. Bumping on
      // every attempt let an offline machine with one pending write gain a
      // generation per backoff tick; once any other device pushed, that
      // machine was diverged with its pull refused as a replay and its push
      // 409ing, with no way out (ADR 0044 fourth review). The file is already
      // ahead of `lastGeneration` exactly when a previous attempt stamped it
      // and never landed, so that is the case that must not bump again. A
      // null `lastGeneration` (a config written before the field, or a fresh
      // server) counts as "bump": with no baseline we cannot tell a fresh
      // stamp from an unlanded one, and stamping low would be the worse
      // error. A stamp inflated that way costs nothing any more, because the
      // pull's replay check reads `lastGeneration` and not the local stamp.
      let stampedGeneration: number;
      const vault = Vault.openWithKey(options.vaultPath, Buffer.from(options.masterKey));
      try {
        const current = vault.getSyncGeneration();
        const last = config.lastGeneration;
        if (last === null) {
          vault.bumpSyncGeneration();
          vault.save();
        } else if (current <= last) {
          // last + 1, not current + 1: a vault restored from an older copy
          // would otherwise be stamped BELOW the copy the server already
          // holds, and the next pull would read as a replay.
          vault.setSyncGeneration(last + 1);
          vault.save();
        }
        stampedGeneration = vault.getSyncGeneration();
      } finally {
        vault.close();
      }
      const blob = fs.readFileSync(options.vaultPath);
      if (!isVaultBlob(blob)) throw new Error('Local vault file is not a NorthKeep vault.');
      if (blob.length > MAX_BLOB_BYTES) {
        throw new Error(
          `Vault is ${(blob.length / 1024 / 1024).toFixed(1)} MB, over the ${MAX_BLOB_BYTES / 1024 / 1024} MB sync limit.`,
        );
      }
      return { config, blob, stampedGeneration };
    });
    // The upload holds no vault lock: a hung server must not take the vault
    // away from every other process on this machine (review 2026-09-03).
    const result = await pushBlob(snapshot.config.serverUrl, token, snapshot.blob, snapshot.config.lastVersion);
    if (result.ok) {
      await withFileLock(options.vaultPath, () => {
        const latest = loadSyncConfig() ?? snapshot.config;
        saveSyncConfig({
          ...latest,
          lastVersion: result.version,
          lastSyncedAt: new Date().toISOString(),
          // The bytes we uploaded ARE the server's copy now. A local write that
          // landed during the upload simply differs from this hash, reads as
          // "ahead" on the next syncState, and is pushed next.
          lastSha: sha256Hex(snapshot.blob),
          // The generation sealed inside the bytes the server now holds. The
          // next push compares against it to decide whether to bump, and the
          // next pull compares an incoming blob against it to spot a replay.
          lastGeneration: snapshot.stampedGeneration,
        });
      });
    }
    return result;
  }, options.syncLockWaitMs);
}

/**
 * Pull the server's vault and install it locally. CRITICAL SAFETY (ADR 0009):
 * a pull must never destroy a good local vault. The downloaded blob is
 * verified structurally + by transport hash, written to a temp file, and, if
 * a local vault already exists, proven to OPEN with the caller's master key
 * before it is swapped in (the old vault is kept as `.nkv.bak`). A corrupt
 * download or a malicious server serving garbage is thus rejected without
 * touching the existing vault. On a fresh machine (no local vault) there is
 * nothing to protect, so the verified blob is written directly.
 *
 * The download runs with no vault lock; verification and the swap run under
 * it. `expectLocalSha` lets an automatic pull insist the local file still
 * hashes to what it decided on: if a write landed meanwhile the pull throws
 * LocalChangedError and replaces nothing. `keepCopyAt` writes a copy of the
 * displaced vault, under the lock, only on the success path, so a rejected
 * download can never clobber it.
 */
export async function pullVault(options: {
  vaultPath: string;
  deviceSecret: Buffer;
  /** Master key for open-verify when a local vault exists (pass a copy; openWithKey zeroes it). */
  masterKey?: Buffer;
  /** Refuse to replace the local vault unless it still hashes to this (automatic pulls). */
  expectLocalSha?: string;
  /** Where to keep the displaced local vault, written only when the swap happens. */
  keepCopyAt?: string;
}): Promise<PullResult> {
  const config = requireConfig();
  const { token } = deriveSyncCreds(options.deviceSecret);
  return withSyncLock(options.vaultPath, async () => {
    const pulled = await pullBlob(config.serverUrl, token);
    if (pulled === null) return { ok: false, reason: 'no-remote' };

    if (!isVaultBlob(pulled.blob)) {
      throw new Error('Downloaded blob is not a NorthKeep vault (corrupt download or wrong server).');
    }
    // Transport integrity only: the server supplies this sha, so it catches a
    // truncated/corrupted download, NOT a malicious server (which can serve a
    // blob + matching sha). The real defense against a hostile blob is the
    // open-verify below; the sha is a cheap early-out for honest corruption.
    if (pulled.sha256 && sha256Hex(pulled.blob) !== pulled.sha256.toLowerCase()) {
      throw new Error('Downloaded vault failed its integrity check (corrupt download). Nothing was changed.');
    }

    return withFileLock(options.vaultPath, () => {
      // Everything the swap writes goes beside the REAL file, so a symlinked
      // vault keeps its link (see resolveVaultLink).
      const targetPath = resolveVaultLink(options.vaultPath);
      const tmpPath = `${targetPath}.pulled.tmp`;
      fs.writeFileSync(tmpPath, pulled.blob, { mode: 0o600 });
      const localExists = fs.existsSync(options.vaultPath);
      // The generation sealed in the bytes that end up on disk, recorded in
      // sync.json below. On the localExists path it is read from the temp
      // file AFTER the open-verify (which may migrate it), and that same file
      // is renamed into place, so it is the installed generation exactly.
      let installedGeneration: number | null = null;
      try {
        if (localExists) {
          if (options.expectLocalSha !== undefined) {
            const nowSha = sha256Hex(fs.readFileSync(options.vaultPath));
            if (nowSha !== options.expectLocalSha) throw new LocalChangedError();
          }
          if (!options.masterKey) {
            throw new Error(
              'A local vault exists but no key was provided to verify the pulled vault before replacing it.',
            );
          }
          // Prove the pulled blob opens with our key BEFORE replacing the good vault.
          // Opening a 0.3 pull migrates the temp file and seeds generation 0; that
          // 0 is the compare value. Opening local to read generation does not increment.
          let pulledGen: number;
          try {
            const pulledVault = Vault.openWithKey(tmpPath, Buffer.from(options.masterKey));
            try {
              pulledGen = pulledVault.getSyncGeneration();
            } finally {
              pulledVault.close();
            }
          } catch (err) {
            if (err instanceof VaultAuthError) {
              throw new Error(
                'The pulled vault does not open with your key, so your local vault was not replaced. ' +
                  '(Wrong device secret or passphrase, a different account, or a bad download.)',
              );
            }
            if (err instanceof VaultSyncGenerationError) {
              throw new Error('The pulled vault has an invalid sync generation. Local vault was not changed.');
            }
            throw err;
          }
          installedGeneration = pulledGen;
          // The replay check compares the incoming blob against the
          // generation of what THIS MACHINE LAST SYNCED, not against the
          // local file's own stamp. That is the question the check exists to
          // answer ("is the server handing me back something older than the
          // copy I already had from it?"), and the local stamp is the wrong
          // yardstick: a machine that stamped a push which never landed sits
          // above every honest blob out there, so comparing to it refused
          // the very pull that would have unwedged it (ADR 0044 fourth
          // review). What this gives up: a `lastGeneration` of null reads as
          // 0 and accepts anything. That is a config written before the
          // field existed, or a machine whose only sync so far was the very
          // first pull on an empty home, which carries no key to read the
          // installed generation with. Either way the next push, or the next
          // pull once a local vault exists to verify against, records a real
          // baseline and the check bites from then on.
          const lastSyncedGeneration = (loadSyncConfig() ?? config).lastGeneration ?? 0;
          if (pulledGen < lastSyncedGeneration) {
            throw new Error(
              'The pulled vault is older than the copy this machine last synced (sync generation). Local vault was not changed.',
            );
          }
          if (options.keepCopyAt) fs.copyFileSync(options.vaultPath, options.keepCopyAt);
          fs.copyFileSync(options.vaultPath, `${targetPath}.bak`);
        }
        fs.renameSync(tmpPath, targetPath);
        if (installedGeneration === null && options.masterKey) {
          // Fresh machine: nothing was verified above, so read the generation
          // back off the installed file. Without a key we cannot, and the
          // baseline stays null (see the replay check).
          try {
            const installed = Vault.openWithKey(options.vaultPath, Buffer.from(options.masterKey));
            try {
              installedGeneration = installed.getSyncGeneration();
            } finally {
              installed.close();
            }
          } catch {
            // The vault is already installed and this read is only a baseline;
            // a key that does not open it leaves the baseline unknown rather
            // than failing a pull that has already succeeded.
            installedGeneration = null;
          }
        }
      } finally {
        if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true });
        // openWithKey above may migrate, and migrate() calls save(), whose
        // writeAtomic leaves a rolling backup beside the TEMP file. Nothing else
        // ever cleans that path up.
        if (fs.existsSync(`${tmpPath}.bak`)) fs.rmSync(`${tmpPath}.bak`, { force: true });
      }

      saveSyncConfig({
        ...(loadSyncConfig() ?? config),
        lastVersion: pulled.version,
        lastSyncedAt: new Date().toISOString(),
        // Hash the file AS IT NOW SITS ON DISK, not `pulled.blob` and not
        // `pulled.sha256`. Two things make the downloaded bytes the wrong answer:
        // the sha comes from the x-sha256 HEADER and is '' when a server omits it,
        // and the open-verify above can MIGRATE the vault (migrate() → save()
        // re-encrypts with a fresh nonce), so the renamed file may legitimately
        // differ from what came over the wire. Either way a stale baseline makes
        // the next syncState() read "edited since sync" and report diverged where
        // behind is correct. Reading it back is authoritative and costs one read.
        lastSha: sha256Hex(fs.readFileSync(options.vaultPath)),
        lastGeneration: installedGeneration,
      });
      return { ok: true, version: pulled.version, wroteVault: true };
    });
  });
}

/** Compare local state to the server without changing anything. */
/**
 * Where this machine stands against the server.
 *
 * "In sync" means the BYTES MATCH — the local vault file hashes to what the
 * server is holding. It used to mean `config.lastVersion === remote.version`,
 * i.e. "the last version I pushed is still the newest one there", which stayed
 * true forever while the local vault was edited and never pushed. That reported
 * "✓ In sync" over a vault that was weeks ahead of its only backup, which is the
 * one thing this command exists to tell you.
 *
 * Version numbers still decide the DIRECTION once the content differs:
 *   - server advanced past our last push, and we have local edits → diverged
 *   - server advanced past our last push                          → behind
 *   - otherwise                                                    → ahead
 * A byte difference is enough to be "not in sync": the push is cheap, and
 * claiming a match we have not verified is the failure mode we just removed.
 */
export async function syncState(options: {
  vaultPath: string;
  deviceSecret: Buffer;
}): Promise<{
  state: SyncState;
  localVersion: number;
  remoteVersion: number | null;
  /** True when the local file differs from the blob the server holds. */
  localChanged: boolean;
  /**
   * False when this machine has no recorded post-sync hash, so "did WE edit?"
   * could not be answered and was assumed yes. Callers should hedge their
   * wording rather than assert both sides changed.
   */
  baselineKnown: boolean;
  /** sha256 of the local file as read for this answer (null when there is none). An automatic pull passes it back as expectLocalSha. */
  localSha: string | null;
  /** The server's sha256 as reported by /api/status (lowercased), null when absent. */
  remoteSha: string | null;
}> {
  const config = loadSyncConfig();
  if (!config) {
    return { state: 'no-config', localVersion: 0, remoteVersion: null, localChanged: false, baselineKnown: true, localSha: null, remoteSha: null };
  }
  const { token } = deriveSyncCreds(options.deviceSecret);
  const remote = await remoteStatus(config.serverUrl, token);
  const localExists = fs.existsSync(options.vaultPath);
  if (remote === null) {
    return {
      state: localExists ? 'no-remote' : 'no-config',
      localVersion: config.lastVersion,
      remoteVersion: null,
      localChanged: localExists,
      baselineKnown: config.lastSha !== null,
      localSha: localExists ? createHash('sha256').update(fs.readFileSync(options.vaultPath)).digest('hex') : null,
      remoteSha: null,
    };
  }
  if (!localExists) {
    return {
      state: 'no-local',
      localVersion: config.lastVersion,
      remoteVersion: remote.version,
      localChanged: false,
      baselineKnown: true,
      localSha: null,
      remoteSha: typeof remote.sha256 === 'string' ? remote.sha256.toLowerCase() : null,
    };
  }

  // A server that does not report sha256 (an older or third-party one — ours
  // has always sent it, apps/sync-server/src/handler.ts) leaves us unable to
  // compare bytes at all. Fall back to the version comparison instead of
  // treating "no hash" as "different", which would pin such a server to
  // ahead/diverged forever and never say in-sync again.
  const remoteShaRaw = typeof remote.sha256 === 'string' ? remote.sha256.toLowerCase() : '';
  const remoteSha = /^[0-9a-f]{64}$/.test(remoteShaRaw) ? remoteShaRaw : null;
  const localSha = createHash('sha256').update(fs.readFileSync(options.vaultPath)).digest('hex');
  const serverAdvanced = remote.version > config.lastVersion;
  // Did WE edit since our own last sync? A config written before lastSha
  // existed cannot prove the file is untouched, so it counts as edited: the
  // safe error is offering a merge that turns out to be unnecessary, not a
  // plain pull that buries local work.
  const editedSinceSync = config.lastSha === null || localSha !== config.lastSha;

  if (remoteSha === null) {
    // No remote hash to compare bytes against, so decide from OUR baseline
    // alone. The old fallback compared versions only and reported "behind,
    // unchanged" for an edited vault, which let an automatic pull bury the
    // edit (adversarial review 2026-09-03, C1b/C6e). Edited means never
    // behind: ahead, or diverged once the server has moved too.
    const state: SyncState = editedSinceSync
      ? serverAdvanced
        ? 'diverged'
        : 'ahead'
      : serverAdvanced
        ? 'behind'
        : 'in-sync';
    return {
      state,
      localVersion: config.lastVersion,
      remoteVersion: remote.version,
      localChanged: editedSinceSync || serverAdvanced,
      baselineKnown: config.lastSha !== null,
      localSha,
      remoteSha: null,
    };
  }

  const localChanged = localSha !== remoteSha;

  const state: SyncState = !localChanged
    ? 'in-sync'
    : serverAdvanced
      ? editedSinceSync
        ? 'diverged'
        : 'behind'
      : 'ahead';
  return {
    state,
    localVersion: config.lastVersion,
    remoteVersion: remote.version,
    localChanged,
    baselineKnown: config.lastSha !== null,
    localSha,
    remoteSha,
  };
}

// --- billing (M5b) ---

/** This account's subscription status on the configured server. */
export async function subscriptionStatus(options: { deviceSecret: Buffer }): Promise<SubscriptionStatus> {
  const config = requireConfig();
  const { token } = deriveSyncCreds(options.deviceSecret);
  const res = await fetch(`${config.serverUrl}/api/subscription`, {
    headers: authHeaders(token),
    redirect: 'error',
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
  });
  // 404 = this server has no billing route (self-host / open); billing is off.
  if (res.status === 404) return { billing: false, active: false, status: null, currentPeriodEnd: null };
  if (!res.ok) throw new Error(`Sync server returned HTTP ${res.status} on subscription.`);
  const b = (await res.json()) as { active: boolean; status: string | null; current_period_end: number | null };
  return { billing: true, active: b.active, status: b.status, currentPeriodEnd: b.current_period_end };
}

/** A Stripe-hosted Checkout URL for this account to subscribe. Open it in a browser. */
export async function checkoutUrl(options: { deviceSecret: Buffer }): Promise<string> {
  const config = requireConfig();
  const { token } = deriveSyncCreds(options.deviceSecret);
  const res = await fetch(`${config.serverUrl}/api/checkout`, {
    method: 'POST',
    headers: authHeaders(token),
    redirect: 'error',
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
  });
  if (res.status === 404) throw new Error('This sync server does not offer subscriptions (billing is off).');
  if (!res.ok) throw new Error(`Sync server returned HTTP ${res.status} on checkout.`);
  const b = (await res.json()) as { url?: string };
  if (!b.url) throw new Error('Sync server did not return a checkout URL.');
  return b.url;
}

/** A Stripe billing-portal URL to manage/cancel, or null if there's no subscription. */
export async function portalUrl(options: { deviceSecret: Buffer }): Promise<string | null> {
  const config = requireConfig();
  const { token } = deriveSyncCreds(options.deviceSecret);
  const res = await fetch(`${config.serverUrl}/api/portal`, {
    method: 'POST',
    headers: authHeaders(token),
    redirect: 'error',
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
  });
  if (res.status === 404) return null; // no subscription to manage, or billing off
  if (!res.ok) throw new Error(`Sync server returned HTTP ${res.status} on portal.`);
  const b = (await res.json()) as { url?: string };
  return b.url ?? null;
}
