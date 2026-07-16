import { fetch } from 'expo/fetch';
import * as Crypto from 'expo-crypto';
import { Vault, VaultAuthError, getPlatform } from '@northkeep/core';
import { MAX_BLOB_BYTES, SubscriptionRequiredError, deriveSyncCreds } from '@northkeep/sync';
import { deleteIfExists, pulledTmpPath } from './paths';

/**
 * The phone's sync PULL (M6-1 is read-only; push is M6-2).
 *
 * PROTOCOL REUSE NOTE: credentials (deriveSyncCreds), the size cap
 * (MAX_BLOB_BYTES), and the 402 error type are imported from @northkeep/sync
 * so no derivation label or protocol constant is duplicated. The pullVault()
 * FUNCTION in packages/sync/src/client.ts cannot run here because it is
 * coupled to node:fs and the advisory file lock, so this module reimplements
 * only its TRANSPORT and safety sequence, mirroring client.ts line for line:
 * GET /api/blob with Bearer token, 404 = no remote, 402 = subscription,
 * X-Version / X-Sha256 headers, NKV1 structural check, sha256 transport
 * check, and verify-the-blob-opens-with-our-key BEFORE replacing a local
 * vault. M6-2 should hoist client.ts's transport behind the platform seam so
 * this file collapses to one import; do not let the two diverge before then.
 *
 * Uses expo/fetch (WinterCG fetch) rather than RN's global fetch, per the
 * plan, so redirect handling and future streaming behave to spec.
 *
 * NEEDS ON-DEVICE VALIDATION: expo/fetch redirect:'error' behavior, timeout
 * wiring, and expo-crypto digest output on a real pull against the sync
 * server.
 */

const BLOB_TIMEOUT_MS = 120_000; // matches packages/sync/src/client.ts
const NKV_MAGIC = 'NKV1';
const NKV_HEADER_LENGTH = 52;

export type MobilePullResult =
  | { ok: true; version: number; wroteVault: boolean }
  | { ok: false; reason: 'no-remote' };

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
 * Pull the remote vault and install it at `vaultPath`. Safety contract is
 * identical to desktop pullVault (ADR 0009): a pull must never destroy a good
 * local vault, so when one exists the downloaded blob must OPEN with the
 * caller's master key before it is swapped in (writeAtomic keeps the previous
 * file as .bak). On a fresh phone there is nothing to protect and the
 * verified blob is written directly.
 */
export async function pullVaultMobile(options: {
  serverUrl: string;
  deviceSecretHex: string;
  vaultPath: string;
  /** Required when a local vault exists. A COPY is made before open-verify (openWithKey zeroes its input). */
  masterKey?: Buffer;
}): Promise<MobilePullResult> {
  const platform = getPlatform();
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
  if (res.status === 404) return { ok: false, reason: 'no-remote' };
  if (res.status === 402) throw new SubscriptionRequiredError();
  if (!res.ok) throw new Error(`Sync server returned HTTP ${res.status} on pull.`);

  const blob = Buffer.from(await res.arrayBuffer());
  if (blob.length > MAX_BLOB_BYTES) {
    throw new Error('Downloaded vault exceeds the sync size limit. Nothing was changed.');
  }
  if (!isVaultBlob(blob)) {
    throw new Error('Downloaded data is not a NorthKeep vault (corrupt download or wrong server).');
  }
  // Transport integrity only, exactly as on desktop: catches honest
  // corruption; a hostile server is defeated by the open-verify below.
  const claimedSha = res.headers.get('x-sha256') ?? '';
  if (claimedSha && (await sha256Hex(blob)) !== claimedSha) {
    throw new Error('Downloaded vault failed its integrity check. Nothing was changed.');
  }
  const version = Number(res.headers.get('x-version') ?? '0');

  const localExists = platform.storage.exists(options.vaultPath);
  if (localExists) {
    if (!options.masterKey) {
      throw new Error('Unlock the vault before pulling, so the download can be verified against your key.');
    }
    const tmp = pulledTmpPath();
    try {
      platform.storage.writeAtomic(tmp, blob);
      // Prove the pulled blob opens with our key BEFORE replacing the good vault.
      try {
        Vault.openWithKey(tmp, Buffer.from(options.masterKey), platform).close();
      } catch (err) {
        if (err instanceof VaultAuthError) {
          throw new Error(
            'The pulled vault does not open with your key, so your local vault was not replaced. ' +
              '(Wrong device secret or passphrase, a different account, or a bad download.)',
          );
        }
        throw err;
      }
    } finally {
      deleteIfExists(tmp);
      deleteIfExists(`${tmp}.bak`); // writeAtomic on the tmp path may leave its own .bak
    }
  }
  // writeAtomic keeps the previous vault as `${path}.bak` (the storage seam contract).
  platform.storage.writeAtomic(options.vaultPath, blob);
  return { ok: true, version, wroteVault: true };
}
