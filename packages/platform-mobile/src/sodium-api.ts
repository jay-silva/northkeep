/**
 * The libsodium surface the mobile CryptoProvider needs from its backend, as a
 * structural interface so the SAME adapter logic (crypto.ts) runs against two:
 *
 *   - react-native-libsodium on device (JSI, synchronous) — wired in native.ts;
 *   - libsodium-wrappers-sumo (wasm) in the Node byte-exactness tests, exactly
 *     the stand-in the Week-1 spike proved against a real desktop vault.
 *
 * Only BLAKE2b (generichash) and random bytes come from libsodium here.
 *
 * XChaCha20-Poly1305 is deliberately NOT in this seam: react-native-libsodium's
 * native binding only accepts a STRING additional-data, but NorthKeep's vault
 * authenticates a 52-byte BINARY header, so the on-device binding cannot open
 * desktop vaults. The AEAD instead runs through @noble/ciphers (pure JS, binary
 * AAD, byte-identical to libsodium — proven in test/byte-exact.test.ts against
 * both libsodium-wrappers-sumo and platform-node's sodium-native). Argon2id
 * likewise goes through Argon2idFn (argon2.ts), since the RN binding has no
 * crypto_pwhash.
 */
export interface SodiumApi {
  /** BLAKE2b with explicit output length; key omitted/null = unkeyed. */
  crypto_generichash(hashLength: number, message: Uint8Array, key?: Uint8Array | null): Uint8Array;
  randombytes_buf(length: number): Uint8Array;
}
