import { fetch } from 'expo/fetch';
import * as Crypto from 'expo-crypto';
import { Vault, VaultAuthError, getPlatform } from '@northkeep/core';
import { MAX_BLOB_BYTES, SubscriptionRequiredError, deriveSyncCreds } from '@northkeep/sync';
import { createDeadline, type DeadlineScope } from './deadline';
import { deleteIfExists, pulledTmpPath } from './paths';

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
  | { ok: true; version: number; wroteVault: boolean }
  | { ok: false; reason: 'no-remote' };

/** Mirrors PushResult from packages/sync/src/client.ts (the pure shape the flow decisions use). */
export interface MobilePushResult {
  ok: boolean;
  /** On success, the new server version; on conflict (409), the server's current version. */
  version: number;
  conflict: boolean;
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
    const claimedSha = res.headers.get('x-sha256') ?? '';
    if (claimedSha && (await sha256Hex(blob)) !== claimedSha) {
      throw new Error('Downloaded vault failed its integrity check. Nothing was changed.');
    }
    const version = Number(res.headers.get('x-version') ?? '0');
    return { blob, version };
  } finally {
    deadline.done();
  }
}

/**
 * Proves a remote blob OPENS with our master key before we trust it (the same
 * defense the desktop pull runs, ADR 0009). Writes the blob to a scratch file,
 * attempts openWithKey with a COPY of the key (openWithKey zeroes its input),
 * and cleans up. Returns true on success, false on VaultAuthError (wrong
 * key/account/corrupt). Any other error propagates.
 */
export function verifyBlobOpensWithKey(blob: Buffer, masterKey: Buffer): boolean {
  const platform = getPlatform();
  const tmp = pulledTmpPath();
  try {
    platform.storage.writeAtomic(tmp, blob);
    try {
      Vault.openWithKey(tmp, Buffer.from(masterKey), platform).close();
      return true;
    } catch (err) {
      if (err instanceof VaultAuthError) return false;
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
}): Promise<MobilePullResult> {
  const platform = getPlatform();
  const remote = await fetchRemoteBlob(options);
  if (remote === null) return { ok: false, reason: 'no-remote' };

  const localExists = platform.storage.exists(options.vaultPath);
  if (localExists) {
    if (!options.masterKey) {
      throw new Error('Unlock the vault before pulling, so the download can be verified against your key.');
    }
    if (!verifyBlobOpensWithKey(remote.blob, options.masterKey)) {
      throw new Error(
        'The pulled vault does not open with your key, so your local vault was not replaced. ' +
          '(Wrong device secret or passphrase, a different account, or a bad download.)',
      );
    }
  }
  // writeAtomic keeps the previous vault as `${path}.bak` (the storage seam contract).
  platform.storage.writeAtomic(options.vaultPath, remote.blob);
  return { ok: true, version: remote.version, wroteVault: true };
}

/**
 * PUT the local vault to the server with X-Base-Version optimistic concurrency,
 * mirroring packages/sync/src/client.ts pushBlob. Reads the CURRENT bytes at
 * `vaultPath` (the just-saved, chain-valid image) through the storage seam.
 * A 409 means another device pushed first: ok=false, conflict=true, and version
 * is the server's current version (the base for the conflict re-push). Never
 * echoes response bodies in errors.
 */
export async function pushVaultMobile(options: {
  serverUrl: string;
  deviceSecretHex: string;
  vaultPath: string;
  baseVersion: number;
}): Promise<MobilePushResult> {
  const platform = getPlatform();
  const { token } = deriveSyncCreds(Buffer.from(options.deviceSecretHex, 'hex'));
  const serverUrl = options.serverUrl.replace(/\/+$/, '');

  if (!platform.storage.exists(options.vaultPath)) {
    throw new Error('No local vault to push. Unlock or import a vault first.');
  }
  const blob = platform.storage.readBytes(options.vaultPath);
  if (!isVaultBlob(blob)) throw new Error('Local vault file is not a NorthKeep vault.');
  if (blob.length > MAX_BLOB_BYTES) {
    throw new Error(
      `Vault is ${(blob.length / 1024 / 1024).toFixed(1)} MB, over the ${MAX_BLOB_BYTES / 1024 / 1024} MB sync limit.`,
    );
  }

  // A plain Uint8Array, for the same reason sha256Hex uses one: expo/fetch
  // normalizes the body in JS (an ArrayBuffer body is wrapped as a Uint8Array
  // before it reaches native), so this is the form native actually receives —
  // stating it directly beats relying on that conversion. The previous comment
  // here claimed expo/fetch REQUIRED an ArrayBuffer and cited sha256Hex's cast
  // as precedent; both were wrong, and that cast was the bug that broke pull.
  const requestBody = new Uint8Array(blob);
  const deadline = deadlineScope();
  try {
    const res = await deadline.race(
      fetch(`${serverUrl}/api/blob`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/octet-stream',
          'x-base-version': String(options.baseVersion),
        },
        body: requestBody,
        redirect: 'error',
        signal: deadline.signal,
      }),
    );
    // Each body read is raced too: res.json() is text() + JSON.parse, and
    // text() has the same never-settles-on-error behavior as arrayBuffer().
    if (res.status === 409) {
      const body = (await deadline.race(res.json().catch(() => ({})))) as { version?: number };
      return { ok: false, conflict: true, version: body.version ?? options.baseVersion };
    }
    if (res.status === 402) throw new SubscriptionRequiredError();
    if (!res.ok) throw new Error(`Sync server returned HTTP ${res.status} on push.`);
    const body = (await deadline.race(res.json())) as { version: number };
    return { ok: true, conflict: false, version: body.version };
  } finally {
    deadline.done();
  }
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
