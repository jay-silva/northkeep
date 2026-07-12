import sodium from 'sodium-native';

/**
 * All cryptography in NorthKeep goes through this module and uses libsodium
 * primitives only (CLAUDE.md invariant #3). Design rationale: SPEC/decisions/0001.
 */

export const KEY_BYTES = 32;
export const SALT_BYTES = sodium.crypto_pwhash_SALTBYTES; // 16
export const NONCE_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES; // 24
export const AEAD_OVERHEAD = sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES; // 16
export const DEVICE_SECRET_BYTES = 32;

export interface KdfParams {
  opslimit: number;
  memlimit: number;
}

/** Production parameters. Tests may pass INTERACTIVE for speed. */
export const KDF_MODERATE: KdfParams = {
  opslimit: sodium.crypto_pwhash_OPSLIMIT_MODERATE,
  memlimit: sodium.crypto_pwhash_MEMLIMIT_MODERATE,
};

export const KDF_INTERACTIVE: KdfParams = {
  opslimit: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
  memlimit: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
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
    kdf.opslimit >= sodium.crypto_pwhash_OPSLIMIT_MIN &&
    kdf.opslimit <= sodium.crypto_pwhash_OPSLIMIT_MODERATE * 4 &&
    kdf.memlimit >= sodium.crypto_pwhash_MEMLIMIT_MIN &&
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

export function randomBytes(length: number): Buffer {
  const buf = Buffer.alloc(length);
  sodium.randombytes_buf(buf);
  return buf;
}

export function generateDeviceSecret(): Buffer {
  return randomBytes(DEVICE_SECRET_BYTES);
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
): Buffer {
  if (salt.length !== SALT_BYTES) throw new Error(`salt must be ${SALT_BYTES} bytes`);
  if (deviceSecret.length !== DEVICE_SECRET_BYTES) {
    throw new Error(`device secret must be ${DEVICE_SECRET_BYTES} bytes`);
  }
  const passwordKey = sodium.sodium_malloc(KEY_BYTES);
  const passphraseBuf = Buffer.from(passphrase, 'utf8');
  try {
    sodium.crypto_pwhash(
      passwordKey,
      passphraseBuf,
      salt,
      kdf.opslimit,
      kdf.memlimit,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
    );
    const masterKey = sodium.sodium_malloc(KEY_BYTES);
    sodium.crypto_generichash(masterKey, passwordKey, deviceSecret);
    return masterKey;
  } finally {
    sodium.sodium_memzero(passwordKey);
    sodium.sodium_memzero(passphraseBuf);
  }
}

export function encrypt(
  plaintext: Buffer,
  key: Buffer,
  associatedData: Buffer,
): { nonce: Buffer; ciphertext: Buffer } {
  const nonce = randomBytes(NONCE_BYTES);
  return { nonce, ciphertext: encryptWithNonce(plaintext, key, nonce, associatedData) };
}

/**
 * For callers whose associated data must already contain the nonce (the vault
 * header). The nonce MUST be freshly random per call — reuse breaks XChaCha20.
 */
export function encryptWithNonce(
  plaintext: Buffer,
  key: Buffer,
  nonce: Buffer,
  associatedData: Buffer,
): Buffer {
  const ciphertext = Buffer.alloc(plaintext.length + AEAD_OVERHEAD);
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    ciphertext,
    plaintext,
    associatedData,
    null,
    nonce,
    key,
  );
  return ciphertext;
}

export function decrypt(
  ciphertext: Buffer,
  key: Buffer,
  nonce: Buffer,
  associatedData: Buffer,
): Buffer {
  if (ciphertext.length < AEAD_OVERHEAD) throw new VaultAuthError();
  const plaintext = Buffer.alloc(ciphertext.length - AEAD_OVERHEAD);
  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      plaintext,
      null,
      ciphertext,
      associatedData,
      nonce,
      key,
    );
  } catch {
    throw new VaultAuthError();
  }
  return plaintext;
}

/** BLAKE2b-256 hex digest — the hash-chain primitive. */
export function blake2bHex(input: string | Buffer): string {
  const out = Buffer.alloc(KEY_BYTES);
  sodium.crypto_generichash(out, typeof input === 'string' ? Buffer.from(input, 'utf8') : input);
  return out.toString('hex');
}

export function memzero(buf: Buffer): void {
  sodium.sodium_memzero(buf);
}
