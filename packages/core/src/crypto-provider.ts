/**
 * Platform seam: the low-level cryptographic primitives NorthKeep needs, as an
 * interface so the vault/crypto layer can run on a mobile TypeScript runtime by
 * swapping the adapter (ADR 0018). packages/core DEFINES this interface and
 * never imports a concrete provider — that would be a circular dependency, since
 * the provider packages depend on core for these types.
 *
 * The one Node implementation lives in @northkeep/platform-node; a future mobile
 * implementation (react-native-libsodium + react-native-quick-crypto) implements
 * the SAME interface. Every primitive, parameter, and byte format here is fixed:
 * the mobile spike decrypts real desktop vaults with an independent implementation
 * of exactly these operations. Do NOT change algorithms, output sizes, or params
 * (CLAUDE.md invariant #3 — libsodium primitives only).
 */
export interface CryptoProvider {
  /**
   * Argon2id v1.3 (ALG_ARGON2ID13) password hash → 32 bytes. `opslimit` and
   * `memlimit` come from the vault header (bounds-checked before this is called).
   * The Node adapter returns guarded (sodium_malloc) memory; mobile returns a
   * plain buffer (hardening loss documented in ADR 0018).
   */
  pwhash(passphrase: Uint8Array, salt: Uint8Array, opslimit: number, memlimit: number): Buffer;

  /**
   * BLAKE2b-256 → 32 bytes. Keyed (key present) for the sync credentials; unkeyed
   * (key omitted) for the entry hash chain. Returns a PLAIN buffer: this runs in
   * the hash-chain hot loop where per-call guarded allocation would exhaust
   * RLIMIT_MEMLOCK. For the long-lived master key use generichashSecure instead.
   */
  generichash(message: Uint8Array, key?: Uint8Array): Buffer;

  /**
   * Keyed BLAKE2b-256 → 32 bytes, returned in GUARDED memory on Node (sodium_malloc:
   * mlock'd, guard-paged, swap-resistant) — for the master key, which is held for
   * the entire unlock session. Called once per unlock, not in the hash-chain loop,
   * so the mlock cost is bounded. Mobile returns a plain buffer (guarded-memory
   * loss documented in ADR 0018). Byte-identical output to generichash.
   */
  generichashSecure(message: Uint8Array, key: Uint8Array): Buffer;

  /** XChaCha20-Poly1305-IETF encrypt. Returns ciphertext = plaintext.length + 16. */
  aeadEncrypt(plaintext: Uint8Array, aad: Uint8Array, nonce: Uint8Array, key: Uint8Array): Buffer;

  /**
   * XChaCha20-Poly1305-IETF decrypt. Returns plaintext = ciphertext.length - 16.
   * MUST throw on authentication failure (wrong key/nonce/aad or tampered input);
   * core catches that and raises VaultAuthError.
   */
  aeadDecrypt(ciphertext: Uint8Array, aad: Uint8Array, nonce: Uint8Array, key: Uint8Array): Buffer;

  /** Cryptographically secure random bytes. */
  randomBytes(length: number): Buffer;

  /** Zero a buffer in place (best-effort scrubbing of key material). */
  secureZero(buf: Uint8Array): void;
}
