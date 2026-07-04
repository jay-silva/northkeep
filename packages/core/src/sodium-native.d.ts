/**
 * Minimal type declarations for the subset of sodium-native v5 that Northkeep
 * uses. sodium-native ships no types; the DefinitelyTyped package targets an
 * older major. Keep this in lockstep with crypto.ts — adding a sodium call
 * means adding its declaration here.
 */
declare module 'sodium-native' {
  const sodium: {
    // constants
    readonly crypto_pwhash_SALTBYTES: number;
    readonly crypto_pwhash_OPSLIMIT_MIN: number;
    readonly crypto_pwhash_MEMLIMIT_MIN: number;
    readonly crypto_pwhash_OPSLIMIT_INTERACTIVE: number;
    readonly crypto_pwhash_MEMLIMIT_INTERACTIVE: number;
    readonly crypto_pwhash_OPSLIMIT_MODERATE: number;
    readonly crypto_pwhash_MEMLIMIT_MODERATE: number;
    readonly crypto_pwhash_ALG_ARGON2ID13: number;
    readonly crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: number;
    readonly crypto_aead_xchacha20poly1305_ietf_ABYTES: number;

    // randomness & memory
    randombytes_buf(buf: Buffer): void;
    sodium_malloc(size: number): Buffer;
    sodium_memzero(buf: Buffer): void;

    // password hashing (Argon2id)
    crypto_pwhash(
      out: Buffer,
      password: Buffer,
      salt: Buffer,
      opslimit: number,
      memlimit: number,
      algorithm: number,
    ): void;

    // BLAKE2b (optionally keyed)
    crypto_generichash(out: Buffer, input: Buffer, key?: Buffer): void;

    // XChaCha20-Poly1305 AEAD
    crypto_aead_xchacha20poly1305_ietf_encrypt(
      ciphertext: Buffer,
      message: Buffer,
      additionalData: Buffer | null,
      secretNonce: null,
      publicNonce: Buffer,
      key: Buffer,
    ): number;
    crypto_aead_xchacha20poly1305_ietf_decrypt(
      message: Buffer,
      secretNonce: null,
      ciphertext: Buffer,
      additionalData: Buffer | null,
      publicNonce: Buffer,
      key: Buffer,
    ): number;
  };
  export = sodium;
}
