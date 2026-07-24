import { fetch } from 'expo/fetch';
import * as Crypto from 'expo-crypto';
import { Vault, VaultAuthError, getPlatform } from '@northkeep/core';
import { MAX_BLOB_BYTES, SubscriptionRequiredError, deriveSyncCreds } from '@northkeep/sync';
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
 * NEEDS ON-DEVICE VALIDATION: expo/fetch redirect:'error' behavior, timeout
 * wiring, expo-crypto digest output, and the PUT body (Buffer) upload against a
 * real sync server. None of the network paths in this file have executed off a
 * device; only the pure decision logic (src/lib/sync-flow.ts) is unit-tested.
 */

const BLOB_TIMEOUT_MS = 120_000; // matches packages/sync/src/client.ts
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
  return (
    blob.length >= NKV_HEADER_LENGTH && blob.subarray(0, 4).equals(Buffer.from(NKV_MAGIC, 'ascii'))
  );
}

async function sha256Hex(bytes: Buffer): Promise<string> {
  const digest = await Crypto.digest(
    Crypto.CryptoDigestAlgorithm.SHA256,
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  return Buffer.from(digest).toString('hex');
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BLOB_TIMEOUT_MS);
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(`${serverUrl}/api/blob`, {
      headers: { authorization: `Bearer ${token}` },
      // A redirect could re-send the bearer token to an attacker's Location
      // (same stance as packages/sync/src/client.ts).
      redirect: 'error',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404) return null;
  if (res.status === 402) throw new SubscriptionRequiredError();
  if (!res.ok) throw new Error(`Sync server returned HTTP ${res.status} on pull.`);

  const blob = Buffer.from(await res.arrayBuffer());
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

  // expo/fetch's BodyInit wants an ArrayBuffer/BufferSource, not a Node Buffer
  // (whose ArrayBufferLike backing does not match BufferSource<ArrayBuffer>);
  // hand it the exact byte range as a standalone ArrayBuffer, mirroring the
  // cast sha256Hex already uses for expo-crypto.
  const requestBody = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) as ArrayBuffer;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BLOB_TIMEOUT_MS);
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(`${serverUrl}/api/blob`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
        'x-base-version': String(options.baseVersion),
      },
      body: requestBody,
      redirect: 'error',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { version?: number };
    return { ok: false, conflict: true, version: body.version ?? options.baseVersion };
  }
  if (res.status === 402) throw new SubscriptionRequiredError();
  if (!res.ok) throw new Error(`Sync server returned HTTP ${res.status} on push.`);
  const body = (await res.json()) as { version: number };
  return { ok: true, conflict: false, version: body.version };
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
