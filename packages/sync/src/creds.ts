import { createHash } from 'node:crypto';
import sodium from 'sodium-native';

/**
 * Sync credentials, derived entirely from the device secret (ADR 0009).
 *
 * The vault's two-secret model already treats `device.secret` as a 256-bit
 * root secret the user guards like a recovery key. Sync reuses it as the
 * account root so there is NO signup, NO email/password, NO PII: the server
 * only ever sees an opaque account id and a bearer token, both derived here,
 * and it can decrypt nothing (the master key needs the passphrase too).
 *
 *   accountId = keyed-BLAKE2b(key = device_secret, msg = "nk-sync-account-v1")
 *   token     = keyed-BLAKE2b(key = device_secret, msg = "nk-sync-token-v1")
 *
 * Distinct domain-separation labels mean the public account id can never be
 * replayed as the token. Both are one-way: the server (or a DB thief) cannot
 * recover the device secret from either. A second machine with the same
 * `device.secret` derives the identical pair — that is how it finds the vault.
 */

const ACCOUNT_LABEL = Buffer.from('nk-sync-account-v1', 'utf8');
const TOKEN_LABEL = Buffer.from('nk-sync-token-v1', 'utf8');
const OUT_BYTES = 32;

export interface SyncCreds {
  /** Public lookup id the server keys storage on. */
  accountId: string;
  /** Bearer secret sent in Authorization; the server stores only its hash. */
  token: string;
}

export function deriveSyncCreds(deviceSecret: Buffer): SyncCreds {
  if (deviceSecret.length !== 32) {
    throw new Error('device secret must be 32 bytes');
  }
  return {
    accountId: keyedHash(ACCOUNT_LABEL, deviceSecret),
    token: keyedHash(TOKEN_LABEL, deviceSecret),
  };
}

/**
 * What the server stores and compares against — a plain SHA-256 of the token
 * (node:crypto, so the server needs no libsodium). A DB leak therefore reveals
 * only the hash, and even the token itself decrypts nothing.
 */
export function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function keyedHash(message: Buffer, key: Buffer): string {
  const out = Buffer.alloc(OUT_BYTES);
  sodium.crypto_generichash(out, message, key);
  return out.toString('hex');
}
