import { AEAD_OVERHEAD, NONCE_BYTES } from '@northkeep/core';

/**
 * The libsodium surface the mobile CryptoProvider needs, as a structural
 * interface so the SAME adapter logic (crypto.ts) runs against two backends:
 *
 *   - react-native-libsodium on device (JSI, synchronous, API-compatible with
 *     libsodium-wrappers) — wired in native.ts;
 *   - libsodium-wrappers-sumo (wasm) in the Node byte-exactness tests, exactly
 *     the stand-in the Week-1 spike proved against a real desktop vault.
 *
 * Argon2id is deliberately NOT here: the RN libsodium binding does not expose
 * crypto_pwhash (the launch plan's fallback ladder is "PR crypto_pwhash into
 * serenity-kit"), so the KDF goes through Argon2idFn (argon2.ts) instead.
 */
export interface SodiumApi {
  /** BLAKE2b with explicit output length; key omitted/null = unkeyed. */
  crypto_generichash(hashLength: number, message: Uint8Array, key?: Uint8Array | null): Uint8Array;
  /** XChaCha20-Poly1305-IETF combined mode; returns plaintext.length + 16. */
  crypto_aead_xchacha20poly1305_ietf_encrypt(
    message: Uint8Array,
    additionalData: Uint8Array | null,
    secretNonce: null,
    publicNonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array;
  /** Combined-mode decrypt; MUST throw on authentication failure. */
  crypto_aead_xchacha20poly1305_ietf_decrypt(
    secretNonce: null,
    ciphertext: Uint8Array,
    additionalData: Uint8Array | null,
    publicNonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array;
  crypto_aead_xchacha20poly1305_ietf_ABYTES: number;
  crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: number;
  randombytes_buf(length: number): Uint8Array;
}

/**
 * Fail-fast guard, mirroring platform-node's assertLibsodiumConstants: the
 * AEAD sizes are inlined as literals in @northkeep/core, so assert at provider
 * construction that the linked libsodium build still agrees. (The crypto_pwhash
 * cost constants cannot be checked here — this backend has no pwhash — so the
 * KDF limits remain pinned solely by core's literals.)
 */
export function assertSodiumConstants(sodium: SodiumApi): void {
  const checks: Array<[string, number, number]> = [
    ['AEAD_OVERHEAD', AEAD_OVERHEAD, sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES],
    ['NONCE_BYTES', NONCE_BYTES, sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES],
  ];
  for (const [name, want, got] of checks) {
    if (want !== got) {
      throw new Error(
        `@northkeep/platform-mobile: core constant ${name}=${want} does not match linked libsodium ${got}. ` +
          'The vault format depends on these; refusing to run.',
      );
    }
  }
}
