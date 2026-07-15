import type { CryptoProvider } from './crypto-provider.js';
import { getPlatform } from './platform-context.js';

/**
 * All cryptography in NorthKeep goes through this module and uses libsodium
 * primitives only (CLAUDE.md invariant #3). Design rationale: SPEC/decisions/0001.
 *
 * The primitives themselves now live behind CryptoProvider (the platform seam,
 * ADR 0018) so the same code runs on Node (sodium-native) and, later, on a mobile
 * runtime — but the constants, parameters, and byte formats below are FIXED and
 * identical across platforms. The libsodium constants are inlined as literals so
 * core carries no native dependency; @northkeep/platform-node asserts at startup
 * that they still match the linked libsodium.
 */

export const KEY_BYTES = 32;
export const SALT_BYTES = 16; // crypto_pwhash_SALTBYTES
export const NONCE_BYTES = 24; // crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
export const AEAD_OVERHEAD = 16; // crypto_aead_xchacha20poly1305_ietf_ABYTES
export const DEVICE_SECRET_BYTES = 32;

// libsodium crypto_pwhash cost-limit constants, inlined (see module note).
const OPSLIMIT_MIN = 1; // crypto_pwhash_OPSLIMIT_MIN
const OPSLIMIT_MODERATE = 3; // crypto_pwhash_OPSLIMIT_MODERATE
const MEMLIMIT_MIN = 8192; // crypto_pwhash_MEMLIMIT_MIN
const MEMLIMIT_MODERATE = 268_435_456; // crypto_pwhash_MEMLIMIT_MODERATE (256 MiB)
const OPSLIMIT_INTERACTIVE = 2; // crypto_pwhash_OPSLIMIT_INTERACTIVE
const MEMLIMIT_INTERACTIVE = 67_108_864; // crypto_pwhash_MEMLIMIT_INTERACTIVE (64 MiB)

export interface KdfParams {
  opslimit: number;
  memlimit: number;
}

/** Production parameters. Tests may pass INTERACTIVE for speed. */
export const KDF_MODERATE: KdfParams = {
  opslimit: OPSLIMIT_MODERATE,
  memlimit: MEMLIMIT_MODERATE,
};

export const KDF_INTERACTIVE: KdfParams = {
  opslimit: OPSLIMIT_INTERACTIVE,
  memlimit: MEMLIMIT_INTERACTIVE,
};

/**
 * KDF params are read from the (unauthenticated) vault header before the key
 * exists, so they must be bounded: a tampered header could otherwise demand
 * terabytes of Argon2id memory and hang or OOM the process pre-authentication.
 */
export function kdfParamsInBounds(kdf: KdfParams): boolean {
  return (
    Number.isInteger(kdf.opslimit) &&
    Number.isInteger(kdf.memlimit) &&
    kdf.opslimit >= OPSLIMIT_MIN &&
    kdf.opslimit <= OPSLIMIT_MODERATE * 4 &&
    kdf.memlimit >= MEMLIMIT_MIN &&
    kdf.memlimit <= 1024 * 1024 * 1024 // 1 GiB absolute cap
  );
}

/** Thrown when decryption fails: wrong passphrase, wrong device secret, or a tampered/corrupted file. */
export class VaultAuthError extends Error {
  constructor(message = 'Could not unlock vault: wrong passphrase, wrong device secret, or corrupted file.') {
    super(message);
    this.name = 'VaultAuthError';
  }
}

export function randomBytes(length: number, provider: CryptoProvider = getPlatform().crypto): Buffer {
  return provider.randomBytes(length);
}

export function generateDeviceSecret(provider: CryptoProvider = getPlatform().crypto): Buffer {
  return randomBytes(DEVICE_SECRET_BYTES, provider);
}

/**
 * Two-secret key derivation (1Password Secret-Key pattern, ADR 0001):
 *   password_key = Argon2id(passphrase, salt)
 *   master_key   = keyed-BLAKE2b(password_key, key = device_secret)
 * Both secrets are required; neither alone yields anything crackable.
 */
export function deriveMasterKey(
  passphrase: string,
  deviceSecret: Buffer,
  salt: Buffer,
  kdf: KdfParams = KDF_MODERATE,
  provider: CryptoProvider = getPlatform().crypto,
): Buffer {
  if (salt.length !== SALT_BYTES) throw new Error(`salt must be ${SALT_BYTES} bytes`);
  if (deviceSecret.length !== DEVICE_SECRET_BYTES) {
    throw new Error(`device secret must be ${DEVICE_SECRET_BYTES} bytes`);
  }
  const passphraseBuf = Buffer.from(passphrase, 'utf8');
  // The passphrase buffer must be zeroed even if pwhash throws (e.g. OOM during
  // Argon2id), so it is created OUTSIDE the try and the try covers pwhash too.
  let passwordKey: Buffer | null = null;
  try {
    passwordKey = provider.pwhash(passphraseBuf, salt, kdf.opslimit, kdf.memlimit);
    // generichashSecure: the master key is held for the whole unlock session, so
    // it goes into guarded memory (sodium_malloc on Node), matching the original.
    return provider.generichashSecure(passwordKey, deviceSecret);
  } finally {
    if (passwordKey) provider.secureZero(passwordKey);
    provider.secureZero(passphraseBuf);
  }
}

export function encrypt(
  plaintext: Uint8Array,
  key: Buffer,
  associatedData: Buffer,
  provider: CryptoProvider = getPlatform().crypto,
): { nonce: Buffer; ciphertext: Buffer } {
  const nonce = randomBytes(NONCE_BYTES, provider);
  return { nonce, ciphertext: encryptWithNonce(plaintext, key, nonce, associatedData, provider) };
}

/**
 * For callers whose associated data must already contain the nonce (the vault
 * header). The nonce MUST be freshly random per call — reuse breaks XChaCha20.
 */
export function encryptWithNonce(
  plaintext: Uint8Array,
  key: Buffer,
  nonce: Buffer,
  associatedData: Buffer,
  provider: CryptoProvider = getPlatform().crypto,
): Buffer {
  return provider.aeadEncrypt(plaintext, associatedData, nonce, key);
}

export function decrypt(
  ciphertext: Buffer,
  key: Buffer,
  nonce: Buffer,
  associatedData: Buffer,
  provider: CryptoProvider = getPlatform().crypto,
): Buffer {
  if (ciphertext.length < AEAD_OVERHEAD) throw new VaultAuthError();
  try {
    return provider.aeadDecrypt(ciphertext, associatedData, nonce, key);
  } catch {
    throw new VaultAuthError();
  }
}

/** BLAKE2b-256 hex digest — the hash-chain primitive. */
export function blake2bHex(
  input: string | Buffer,
  provider: CryptoProvider = getPlatform().crypto,
): string {
  const message = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return provider.generichash(message).toString('hex');
}

export function memzero(buf: Buffer, provider: CryptoProvider = getPlatform().crypto): void {
  provider.secureZero(buf);
}
