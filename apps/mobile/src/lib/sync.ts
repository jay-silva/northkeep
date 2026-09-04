import { fetch } from 'expo/fetch';
import * as Crypto from 'expo-crypto';
import { Vault, VaultAuthError, VaultSyncGenerationError, getPlatform } from '@northkeep/core';
import { MAX_BLOB_BYTES, SubscriptionRequiredError, deriveSyncCreds } from '@northkeep/sync';
import { createDeadline, type DeadlineScope } from './deadline';
import { autoPullBakPath, deleteIfExists, pulledTmpPath } from './paths';
import { loadSyncBaseline, saveLocalDirty, savePendingStampSha, saveSyncBaseline } from './secure-store';
import { localBytesMoved, nextPushGenerationWithPending, pulledBlobIsReplay } from './sync-flow';
import { vaultGate } from './vault-gate';

/**
 * The phone's sync transport: PULL (M6-1) and PUSH + conflict recovery (M6-2).
 *
 * PROTOCOL REUSE NOTE: credentials (deriveSyncCreds), the size cap
 * (MAX_BLOB_BYTES), and the 402 error type are imported from @northkeep/sync
 * so no derivation label or protocol constant is duplicated. The pullVault() /
 * pushVault() FUNCTIONS in packages/sync/src/client.ts cannot run here because
 * they are coupled to node:fs and the advisory file lock, so this module
 * reimplements only their TRANSPORT and safety sequence, mirroring client.ts
 * line for line: Bearer token, GET/PUT /api/blob, 404 = no remote, 402 =
 * subscription, X-Version / X-Sha256 headers, X-Base-Version optimistic
 * concurrency on PUT (409 = conflict), NKV1 structural check, sha256 transport
 * check, and verify-the-blob-opens-with-our-key before we TRUST a remote blob.
 * M6-2 should hoist client.ts's transport behind the platform seam so this file
 * collapses to one import; do not let the two diverge before then.
 *
 * Uses expo/fetch (WinterCG fetch) rather than RN's global fetch, per the plan,
 * so redirect handling and future streaming behave to spec.
 *
 * VALIDATED ON DEVICE 2026-07-28, and it cost three bugs, all of which passed
 * every Node test and the typechecker first: `subarray().equals()` (Hermes
 * returns a plain Uint8Array), an ArrayBuffer handed to expo-crypto's digest
 * (native wants a TypedArray), and a timeout that could not fire because
 * expo/fetch's arrayBuffer() never settles on a body error. See isVaultBlob,
 * sha256Hex and src/lib/deadline.ts for the specifics.
 *
 * STILL UNVALIDATED: redirect:'error' behavior, and the 409 conflict branch
 * (fetch + verify + stash + re-push) has not run against a real conflict.
 */

const BLOB_TIMEOUT_MS = 120_000; // matches packages/sync/src/client.ts

/** Shown when a transfer stalls. Deliberately NOT phrased like the offline copy
 *  (see sync-errors.ts isTransportFailure), so a stall stays distinguishable. */
const STALLED_MESSAGE = 'The sync server stopped responding partway through. Nothing was changed.';

/** See src/lib/deadline.ts for why a timeout here must be RACED, not just armed. */
const deadlineScope = (): DeadlineScope => createDeadline(BLOB_TIMEOUT_MS, STALLED_MESSAGE);

const NKV_MAGIC = 'NKV1';
const NKV_HEADER_LENGTH = 52;

export type MobilePullResult =
  /** sha256: hex hash of the bytes now installed at vaultPath (the post-sync baseline, ADR 0044). */
  | { ok: true; version: number; wroteVault: boolean; sha256: string }
  | { ok: false; reason: 'no-remote' };

/** Mirrors PushResult from packages/sync/src/client.ts (the pure shape the flow decisions use). */
export interface MobilePushResult {
  ok: boolean;
  /** On success, the new server version; on conflict (409), the server's current version. */
  version: number;
  conflict: boolean;
  /**
   * On success, the hex sha256 of the exact bytes the server accepted: the
   * file as it sits on disk after the generation stamp. Stored as the phone's
   * post-sync baseline so a wake can tell "untouched since sync" from bytes,
   * the way the desktop's syncState does (ADR 0044, second review).
   */
  sha256?: string;
  /**
   * On success, the sync generation sealed in the bytes the server accepted
   * (whether this push stamped it or an earlier attempt did). The caller
   * records it as the phone's new lastSyncGeneration. Absent when the bump
   * was skipped (the conflict re-push, which already knows its own value).
   */
  generation?: number;
}

/** Thrown by pullVaultMobile when the vault file moved between the wake's decision and the install. Nothing was written. */
export class LocalChangedError extends Error {
  constructor() {
    super('The vault changed while the download ran, so it was not replaced.');
    this.name = 'LocalChangedError';
  }
}

/** A remote blob that already passed the structural + transport-hash checks. */
export interface VerifiedRemoteBlob {
  blob: Buffer;
  version: number;
}

function isVaultBlob(blob: Buffer): boolean {
  // Buffer.compare (static) instead of subarray().equals(): on Hermes the Buffer
  // polyfill's subarray returns a plain Uint8Array (no Symbol.species), which has
  // no .equals — calling it threw a TypeError that the error classifier then
  // reported as "could not reach the sync server". Same fix as vault.ts:158.
  // Buffer.compare accepts Uint8Array; identical on Node.
  return (
    blob.length >= NKV_HEADER_LENGTH &&
    Buffer.compare(blob.subarray(0, 4), Buffer.from(NKV_MAGIC, 'ascii')) === 0
  );
}

/**
 * Hex sha256 of the vault file as it sits on disk, or null when there is no
 * file. Compared against the stored post-sync hash before any automatic pull:
 * a mismatch (or no stored hash at all) means this phone holds bytes the
 * server never accepted, and the wake pushes instead of pulling.
 */
export async function hashVaultFile(vaultPath: string): Promise<string | null> {
  const platform = getPlatform();
  if (!platform.storage.exists(vaultPath)) return null;
  return sha256Hex(platform.storage.readBytes(vaultPath));
}

/** Hex sha256 of arbitrary bytes. Exported so callers can hash a fetched blob (the conflict wording check). */
export async function hashBytes(bytes: Buffer): Promise<string> {
  return sha256Hex(bytes);
}

async function sha256Hex(bytes: Buffer): Promise<string> {
  // MUST be a plain Uint8Array, not an ArrayBuffer and not a Metro Buffer.
  //
  // expo-crypto's `digest()` shim falls back to the native
  // `ExpoCrypto.digest(algorithm, output, data)` when `digestAsync` is absent,
  // and that 3rd argument is resolved by ExpoModulesCore's DynamicTypedArrayType
  // — which accepts a TYPED ARRAY and rejects a bare ArrayBuffer:
  //   NotTypedArrayException: Given argument is not an instance of TypedArray
  // The declared TS type is `BufferSource` (ArrayBuffer included), so this
  // compiles cleanly and only fails on device. A Metro Buffer is no good either
  // (its subclass breaks JSI arg conversion), hence a fresh plain array.
  //
  // `new Uint8Array(bytes)` COPIES rather than viewing `bytes.buffer`, and that
  // is deliberate: a view inherits `ArrayBufferLike` (possibly SharedArrayBuffer),
  // which does not satisfy `BufferSource` and is what pushed the original author
  // into the `.slice() as ArrayBuffer` cast that caused this bug. The copy is a
  // few hundred KB once per transfer, against a network round trip.
  const view = new Uint8Array(bytes);
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, view);
  return Buffer.from(new Uint8Array(digest)).toString('hex');
}

/** What GET /api/status reports: the server's version and the sha256 of the blob it holds. */
export interface RemoteStatusMobile {
  version: number;
  sha256: string;
}

/**
 * GET /api/status: a few hundred bytes, no blob. The wake pull (ADR 0044)
 * asks this first and downloads only when the server is ahead. Same bearer,
 * redirect refusal, 404/402 handling and deadline race as fetchRemoteBlob.
 * Returns null when the account has no vault on the server yet.
 */
export async function fetchRemoteStatus(options: {
  serverUrl: string;
  deviceSecretHex: string;
}): Promise<RemoteStatusMobile | null> {
  const { token } = deriveSyncCreds(Buffer.from(options.deviceSecretHex, 'hex'));
  const serverUrl = options.serverUrl.replace(/\/+$/, '');
  const deadline = deadlineScope();
  try {
    const res = await deadline.race(
      fetch(`${serverUrl}/api/status`, {
        headers: { authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: deadline.signal,
      }),
    );
    if (res.status === 404) return null;
    if (res.status === 402) throw new SubscriptionRequiredError();
    if (!res.ok) throw new Error(`Sync server returned HTTP ${res.status} on status.`);
    const body = (await deadline.race(res.json())) as { version?: unknown; sha256?: unknown };
    const version = typeof body.version === 'number' && Number.isInteger(body.version) ? body.version : 0;
    const sha256 = typeof body.sha256 === 'string' ? body.sha256 : '';
    return { version, sha256 };
  } finally {
    deadline.done();
  }
}

/**
 * GET /api/blob, returning the remote vault after the structural + size +
 * transport-hash checks (exactly the checks packages/sync/src/client.ts runs).
 * Returns null when the account has no vault yet (404). Transport integrity
 * only: the sha catches honest corruption; a hostile server is defeated by the
 * verify-opens-with-key step (verifyBlobOpensWithKey), not here.
 *
 * Factored out so both pullVaultMobile (which INSTALLS the remote) and the
 * conflict-recovery path in vault-session (which only STASHES the remote to
 * .bak and keeps the local vault live) share one verified fetch.
 */
export async function fetchRemoteBlob(options: {
  serverUrl: string;
  deviceSecretHex: string;
}): Promise<VerifiedRemoteBlob | null> {
  const { token } = deriveSyncCreds(Buffer.from(options.deviceSecretHex, 'hex'));
  const serverUrl = options.serverUrl.replace(/\/+$/, '');

  const deadline = deadlineScope();
  try {
    const res = await deadline.race(
      fetch(`${serverUrl}/api/blob`, {
        headers: { authorization: `Bearer ${token}` },
        // A redirect could re-send the bearer token to an attacker's Location
        // (same stance as packages/sync/src/client.ts).
        redirect: 'error',
        signal: deadline.signal,
      }),
    );
    if (res.status === 404) return null;
    if (res.status === 402) throw new SubscriptionRequiredError();
    if (!res.ok) throw new Error(`Sync server returned HTTP ${res.status} on pull.`);

    // Raced, not just armed: this is the download itself, and it is the await
    // that would otherwise hang forever on a dropped connection.
    const blob = Buffer.from(await deadline.race(res.arrayBuffer()));
    if (blob.length > MAX_BLOB_BYTES) {
      throw new Error('Downloaded vault exceeds the sync size limit. Nothing was changed.');
    }
    if (!isVaultBlob(blob)) {
      throw new Error('Downloaded data is not a NorthKeep vault (corrupt download or wrong server).');
    }
    // Lowercased: hex casing is not integrity, and an uppercase header from a
    // third-party server failed every download (third review).
    const claimedSha = (res.headers.get('x-sha256') ?? '').toLowerCase();
    if (claimedSha && (await sha256Hex(blob)) !== claimedSha) {
      throw new Error('Downloaded vault failed its integrity check. Nothing was changed.');
    }
    const version = Number(res.headers.get('x-version') ?? '0');
    return { blob, version };
  } finally {
    deadline.done();
  }
}

export type BlobOpenVerify =
  | { ok: true; syncGeneration: number }
  | { ok: false };

/**
 * Proves a remote blob OPENS with our master key before we trust it (the same
 * defense the desktop pull runs, ADR 0009). Writes the blob to a scratch file,
 * attempts openWithKey with a COPY of the key (openWithKey zeroes its input),
 * reads sync_generation from the opened (possibly migrated) vault so the compare
 * matches desktop, then deletes the tmp and returns. A 0.3 blob migrates in tmp
 * to generation 0; that 0 is the compare value even though the caller still
 * installs the original unmigrated bytes.
 */
export function verifyBlobOpensWithKey(blob: Buffer, masterKey: Buffer): BlobOpenVerify {
  const platform = getPlatform();
  const tmp = pulledTmpPath();
  try {
    platform.storage.writeAtomic(tmp, blob);
    try {
      const vault = Vault.openWithKey(tmp, Buffer.from(masterKey), platform);
      try {
        return { ok: true, syncGeneration: vault.getSyncGeneration() };
      } finally {
        vault.close();
      }
    } catch (err) {
      if (err instanceof VaultAuthError) return { ok: false };
      throw err;
    }
  } finally {
    deleteIfExists(tmp);
    deleteIfExists(`${tmp}.bak`); // writeAtomic on the tmp path may leave its own .bak
  }
}

/**
 * Pull the remote vault and install it at `vaultPath`. Safety contract is
 * identical to desktop pullVault (ADR 0009): a pull must never destroy a good
 * local vault, so when one exists the downloaded blob must OPEN with the
 * caller's master key before it is swapped in (writeAtomic keeps the previous
 * file as .bak). On a fresh phone there is nothing to protect and the verified
 * blob is written directly.
 */
export async function pullVaultMobile(options: {
  serverUrl: string;
  deviceSecretHex: string;
  vaultPath: string;
  /** Required when a local vault exists. A COPY is made before open-verify (openWithKey zeroes its input). */
  masterKey?: Buffer;
  /**
   * An automatic pull's guard: the hash of the file the wake decided on. If
   * the file no longer hashes to it right before the install, nothing is
   * written and LocalChangedError is thrown (a save landed during the wake).
   * Manual pulls omit it and replace regardless.
   */
  expectLocalSha?: string;
  /**
   * Run INSIDE the vault gate, immediately after the bytes are installed and
   * before any queued save can run: the session's close-and-reopen and the
   * SecureStore version/sha/dirty writes. Without it the old Vault instance
   * could save pre-pull content over the file we just installed (fourth
   * adversarial review). It must not call anything that takes the gate again.
   */
  afterInstall?: (installed: { version: number; sha256: string }) => Promise<void> | void;
  /**
   * AUTOMATIC pulls only (the wake's pull and its repair fast-forward): keep
   * the displaced vault at `${vaultPath}.auto-pull.bak`, a copy no later save
   * rewrites. Manual pull-to-refresh leaves it unset and keeps today's
   * behaviour (ADR 0044, seventh review flesh wound).
   */
  keepDisplacedCopy?: boolean;
}): Promise<MobilePullResult> {
  const platform = getPlatform();
  // The download runs with the gate RELEASED: it is up to 120 s of network and
  // touches no local file. Everything after it is one atomic gated section.
  const remote = await fetchRemoteBlob(options);
  if (remote === null) return { ok: false, reason: 'no-remote' };

  return vaultGate.run(async () => installPulledBlob(options, remote));
}

/**
 * The install half of a pull. ALWAYS called inside the vault gate: the
 * re-hash, the verify, the write and the caller's reopen must not interleave
 * with a save. `hashVaultFile` awaits a native digest, and that await is the
 * exact window the fourth review's kill shot walked through.
 */
async function installPulledBlob(
  options: {
    vaultPath: string;
    masterKey?: Buffer;
    expectLocalSha?: string;
    afterInstall?: (installed: { version: number; sha256: string }) => Promise<void> | void;
    keepDisplacedCopy?: boolean;
  },
  remote: VerifiedRemoteBlob,
): Promise<MobilePullResult> {
  const platform = getPlatform();
  const localExists = platform.storage.exists(options.vaultPath);
  /** The generation sealed in the blob we install: the new lastSyncGeneration. Null when no key could read it. */
  let installedGeneration: number | null = null;
  if (localExists) {
    if (!options.masterKey) {
      throw new Error('Unlock the vault before pulling, so the download can be verified against your key.');
    }
    let opened: BlobOpenVerify;
    try {
      opened = verifyBlobOpensWithKey(remote.blob, options.masterKey);
    } catch (err) {
      if (err instanceof VaultSyncGenerationError) {
        throw new Error('The pulled vault has an invalid sync generation. Local vault was not changed.');
      }
      throw err;
    }
    if (!opened.ok) {
      throw new Error(
        'The pulled vault does not open with your key, so your local vault was not replaced. ' +
          '(Wrong device secret or passphrase, a different account, or a bad download.)',
      );
    }
    installedGeneration = opened.syncGeneration;
    // THE REPLAY CHECK, and the yardstick is the whole fix (ADR 0044, fifth
    // review). It compares the incoming blob against the generation of what
    // this phone LAST SYNCED, never against the local file's own stamp.
    //
    // The local stamp is the wrong yardstick because it inflates with every
    // unpushed edit and every push that never landed, and it establishes
    // nothing about what the server ever held. A phone whose establish push
    // failed four times sits four generations above every honest blob out
    // there, so comparing to it refused the very pull that would have
    // unwedged it: the pill said "pull to catch up" forever while the pull
    // called every real blob a replay.
    //
    // What this gives up: a null baseline reads as 0 and accepts anything.
    // That is a phone that predates the key, or one whose only sync so far
    // was a first pull carrying no key to read the installed generation with.
    // Either way the next push, or this pull, records a real baseline and the
    // check bites from then on.
    if (pulledBlobIsReplay(opened.syncGeneration, (await loadSyncBaseline())?.generation ?? null)) {
      throw new Error(
        'The pulled vault is older than the copy this phone last synced (sync generation). ' +
          'Local vault was not changed.',
      );
    }
  } else if (options.masterKey) {
    // Fresh phone with a key in hand: verify anyway, purely to learn the
    // generation we are about to install. Nothing local to protect, so a
    // failed verify is not fatal here; the baseline simply stays null.
    try {
      const opened = verifyBlobOpensWithKey(remote.blob, options.masterKey);
      if (opened.ok) installedGeneration = opened.syncGeneration;
    } catch {
      installedGeneration = null;
    }
  }
  // The phone's equivalent of the desktop's under-lock re-check: a save that
  // landed while the blob downloaded must not be buried (third review).
  if (localExists && localBytesMoved(options.expectLocalSha, await hashVaultFile(options.vaultPath))) {
    throw new LocalChangedError();
  }
  // THE DURABLE COPY (ADR 0044, seventh review flesh wound). Last thing before
  // the write, after every check has passed, so it is made only on the success
  // path and only for an automatic pull. The rolling `${path}.bak` writeAtomic
  // keeps is not enough on its own: the next save rewrites it, so a wake pull
  // the user wanted to undo an hour later left nothing behind.
  //
  // Best effort on purpose. writeAtomic still leaves the displaced image at
  // `${path}.bak`, so a failure here degrades to today's behaviour rather than
  // to data loss, while throwing would turn a missing backup into a refusal to
  // install a blob that already passed verify. (The second automatic pull
  // leaves a harmless `${path}.auto-pull.bak.bak`, the same artifact
  // stashRecoverableBak documents below.)
  if (options.keepDisplacedCopy && localExists) {
    try {
      platform.storage.writeAtomic(autoPullBakPath(options.vaultPath), platform.storage.readBytes(options.vaultPath));
    } catch {
      // Keep going: the install is still safe and `${path}.bak` still holds it.
    }
  }
  // writeAtomic keeps the previous vault as `${path}.bak` (the storage seam contract).
  // Original bytes (possibly unmigrated 0.3) are installed; compare used the
  // same generation desktop would after open-verify/migrate.
  platform.storage.writeAtomic(options.vaultPath, remote.blob);
  const installed = { version: remote.version, sha256: await sha256Hex(remote.blob) };
  // THE BOOKKEEPING, in this order, inside the gate, and written HERE rather
  // than through afterInstall so no pull path can forget it (ADR 0044, sixth
  // review kill shot). Both callers install; only one does the session reopen.
  //
  // Dirty FIRST, baseline SECOND. The file on disk is now the server's copy,
  // so nothing the user wrote is on it; clearing dirty first means that if the
  // baseline write then fails, the next wake sees "bytes moved, user wrote
  // nothing" and REPAIRS instead of pushing. The reverse order leaves a torn
  // baseline looking dirty-and-changed, which is the push that rolled the
  // other device's write off the server.
  await saveLocalDirty(false);
  // ONE write: version, sha and generation can no longer describe different
  // moments. pendingStampSha is cleared because the file is the server's copy.
  await saveSyncBaseline({
    version: installed.version,
    sha: installed.sha256,
    generation: installedGeneration,
    pendingStampSha: null,
  });
  // Still under the gate: the session reopen and the rest of the bookkeeping.
  await options.afterInstall?.(installed);
  return { ok: true, version: installed.version, wroteVault: true, sha256: installed.sha256 };
}

/**
 * The bytes a push will upload, plus everything read off the local vault to
 * produce them. Produced under the vault gate by preparePushMobile; consumed
 * (over the network, with the gate RELEASED) by uploadPreparedMobile.
 */
export interface PreparedPush {
  /**
   * The exact body to PUT. `Uint8Array<ArrayBuffer>` (not the default
   * `ArrayBufferLike`) because fetch's BodyInit rejects a view that might sit
   * on a SharedArrayBuffer; the copy below is what guarantees it does not.
   */
  body: Uint8Array<ArrayBuffer>;
  /** Hex sha256 of those bytes: the phone's post-sync baseline once the server accepts them. */
  sha256: string;
  /** The sync generation in the bytes below, stamped or already there (absent when the bump was skipped). */
  generation?: number;
  /** The X-Base-Version this push must send. */
  baseVersion: number;
}

/**
 * The LOCAL half of a push: stamp the sync generation, read the bytes, hash
 * them. Runs inside the vault gate, so a save can neither land between the
 * stamp and the read (uploading a half-written image) nor be overwritten by
 * the stamp. The gate is released the moment the bytes are in hand, so a save
 * queued behind a push waits for the READ, not for the PUT.
 */
export async function preparePushMobile(options: {
  vaultPath: string;
  baseVersion: number;
  masterKey: Buffer;
  /** When true, read the current bytes without incrementing (LWW re-push already set generation). */
  skipGenerationBump?: boolean;
}): Promise<PreparedPush> {
  return vaultGate.run(async () => {
    const platform = getPlatform();
    if (!platform.storage.exists(options.vaultPath)) {
      throw new Error('No local vault to push. Unlock or import a vault first.');
    }
    // The generation stamped here is returned so the session's open vault
    // adopts it; otherwise its next save writes the old value back and the
    // phone's generation never rises (third review: server blobs at gen 1, 1, 1).
    //
    // ONE BUMP PER LOGICAL PUSH, however many attempts it takes (ADR 0044,
    // fifth review; mirrors packages/sync/src/client.ts pushVault). The old
    // code bumped unconditionally, so four failed PUTs cost four generations:
    // on the establish path that inflated the stamp past every honest blob
    // while never setting a baseline, and the phone wedged. nextPushGeneration
    // holds the rule (and its null-baseline case); see src/lib/sync-flow.ts.
    let stampedGeneration: number | undefined;
    // Null until we know we may need it: the hash of the file BEFORE the stamp,
    // which is how a re-stamp of bytes an earlier failed attempt already
    // stamped is recognized (ADR 0044, sixth review; see
    // nextPushGenerationWithPending).
    let lastSyncGeneration: number | null = null;
    if (!options.skipGenerationBump) {
      const baseline = await loadSyncBaseline();
      lastSyncGeneration = baseline?.generation ?? null;
      const preStampSha = await hashVaultFile(options.vaultPath);
      const vault = Vault.openWithKey(options.vaultPath, Buffer.from(options.masterKey), platform);
      try {
        const next = nextPushGenerationWithPending({
          currentStamp: vault.getSyncGeneration(),
          lastSyncGeneration,
          currentSha: preStampSha,
          pendingStampSha: baseline?.pendingStampSha ?? null,
        });
        if (next !== null) {
          vault.setSyncGeneration(next);
          vault.save();
        }
        // OUTSIDE the branch on purpose, and this line is the linchpin of the
        // whole fix. Whether or not we stamped, this is the generation in the
        // bytes we are about to upload, and it is what the caller records as
        // the new lastSyncGeneration once the server accepts them. Move it
        // inside the `if` and a retry (which correctly does not bump) reports
        // no generation, the baseline goes stale, the next push stops bumping
        // against it, and the wedge comes back with every Node test still
        // green: nothing off-device can reach this line.
        stampedGeneration = vault.getSyncGeneration();
      } finally {
        vault.close();
      }
    }
    const blob = platform.storage.readBytes(options.vaultPath);
    if (!isVaultBlob(blob)) throw new Error('Local vault file is not a NorthKeep vault.');
    if (blob.length > MAX_BLOB_BYTES) {
      throw new Error(
        `Vault is ${(blob.length / 1024 / 1024).toFixed(1)} MB, over the ${MAX_BLOB_BYTES / 1024 / 1024} MB sync limit.`,
      );
    }
    const sha256 = await sha256Hex(blob);
    // The pending stamp, recorded only while there is no generation baseline
    // to hold the stamp still. These are bytes this phone STAMPED and the
    // server has not accepted; if the next prepare finds the file still
    // hashing to this, it must not bump again. Cleared by the baseline write
    // that follows an accepted push.
    if (!options.skipGenerationBump && lastSyncGeneration === null) await savePendingStampSha(sha256);
    return {
      // A plain Uint8Array, for the same reason sha256Hex uses one: expo/fetch
      // normalizes the body in JS (an ArrayBuffer body is wrapped as a
      // Uint8Array before it reaches native), so this is the form native
      // actually receives. A previous comment claimed expo/fetch REQUIRED an
      // ArrayBuffer; it was wrong, and that cast was the bug that broke pull.
      body: new Uint8Array(blob),
      // Hashed before the upload so the baseline is exactly what went over the wire.
      sha256,
      generation: stampedGeneration,
      baseVersion: options.baseVersion,
    };
  });
}

/**
 * The NETWORK half of a push. Holds no gate: a PUT can park for the full
 * 120 s deadline, and blocking every save on the phone for that long is the
 * lock-scope mistake the desktop already made (second review). A 409 means
 * another device pushed first: ok=false, conflict=true, and version is the
 * server's current version (the base for the conflict re-push). Never echoes
 * response bodies in errors.
 */
export async function uploadPreparedMobile(options: {
  serverUrl: string;
  deviceSecretHex: string;
  prepared: PreparedPush;
}): Promise<MobilePushResult> {
  const { token } = deriveSyncCreds(Buffer.from(options.deviceSecretHex, 'hex'));
  const serverUrl = options.serverUrl.replace(/\/+$/, '');
  const { body, sha256: uploadedSha, generation, baseVersion } = options.prepared;

  const deadline = deadlineScope();
  try {
    const res = await deadline.race(
      fetch(`${serverUrl}/api/blob`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/octet-stream',
          'x-base-version': String(baseVersion),
        },
        body,
        redirect: 'error',
        signal: deadline.signal,
      }),
    );
    // Each body read is raced too: res.json() is text() + JSON.parse, and
    // text() has the same never-settles-on-error behavior as arrayBuffer().
    if (res.status === 409) {
      const conflictBody = (await deadline.race(res.json().catch(() => ({})))) as { version?: number };
      return { ok: false, conflict: true, version: conflictBody.version ?? baseVersion };
    }
    if (res.status === 402) throw new SubscriptionRequiredError();
    if (!res.ok) throw new Error(`Sync server returned HTTP ${res.status} on push.`);
    const okBody = (await deadline.race(res.json())) as { version: number };
    return { ok: true, conflict: false, version: okBody.version, sha256: uploadedSha, generation };
  } finally {
    deadline.done();
  }
}

/**
 * Prepare-then-upload in one call, kept for the callers and tests that do not
 * need the two phases apart. New orchestration should call the two halves
 * directly, so it can see exactly where the gate is released.
 */
export async function pushVaultMobile(options: {
  serverUrl: string;
  deviceSecretHex: string;
  vaultPath: string;
  baseVersion: number;
  masterKey: Buffer;
  skipGenerationBump?: boolean;
}): Promise<MobilePushResult> {
  const prepared = await preparePushMobile({
    vaultPath: options.vaultPath,
    baseVersion: options.baseVersion,
    masterKey: options.masterKey,
    skipGenerationBump: options.skipGenerationBump,
  });
  return uploadPreparedMobile({
    serverUrl: options.serverUrl,
    deviceSecretHex: options.deviceSecretHex,
    prepared,
  });
}

/** The durable recovery slot for a conflict-displaced remote (see below). */
export function conflictBakPath(vaultPath: string): string {
  return `${vaultPath}.conflict.bak`;
}

/**
 * Stash a VERIFIED remote blob at `${vaultPath}.conflict.bak` so the displaced
 * other-device version stays recoverable after the phone wins a two-sided
 * conflict (last-writer-wins).
 *
 * IMPORTANT: this must NOT reuse `${vaultPath}.bak`. That path is the storage
 * seam's rolling per-save backup (writeAtomic copies the prior vault there on
 * every write) AND the crash-recovery slot (recovery-on-open restores from it).
 * Sharing it meant (a) the very next save clobbered the stashed remote, so the
 * "recoverable" promise lasted only until the next edit, and (b) a crash right
 * after a conflict could restore the OTHER device's version as the live vault.
 * A dedicated path fixes both. Uses writeAtomic (the only write the storage
 * seam exposes), which leaves a harmless `${vaultPath}.conflict.bak.bak`.
 */
export function stashRecoverableBak(vaultPath: string, blob: Buffer): void {
  getPlatform().storage.writeAtomic(conflictBakPath(vaultPath), blob);
}
