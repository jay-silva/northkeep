import type { CryptoProvider } from '@northkeep/core';
import { type Argon2idFn, pwhashViaArgon2id } from './argon2.js';
import { assertSodiumConstants, type SodiumApi } from './sodium-api.js';

/**
 * Mobile CryptoProvider: the platform-node reference (sodium-native) rebuilt on
 * a libsodium-wrappers-shaped backend + a generic Argon2id. This factory is
 * PURE — it never imports a React Native module — so the Node byte-exactness
 * suite (test/byte-exact.test.ts) constructs it with wasm/OpenSSL stand-ins
 * (libsodium-wrappers-sumo + node:crypto.argon2Sync) and asserts every output
 * is byte-identical to nodeCryptoProvider(). native.ts wires the real device
 * backends (react-native-libsodium + react-native-quick-crypto) into the SAME
 * code. Changing any primitive here is a key-handling change: invariant #3
 * adversarial review required (ADR 0021).
 *
 * Known hardening loss vs desktop (documented in ADR 0018/0021): no
 * sodium_malloc on RN, so pwhash/generichashSecure return plain buffers and
 * secureZero is a best-effort fill(0) rather than sodium_memzero.
 */

/** Zero-copy Buffer view over whatever the backend returned. */
function asBuffer(x: Uint8Array): Buffer {
  return Buffer.isBuffer(x) ? x : Buffer.from(x.buffer, x.byteOffset, x.byteLength);
}

export interface MobileCryptoDeps {
  sodium: SodiumApi;
  argon2id: Argon2idFn;
}

export function createMobileCryptoProvider({ sodium, argon2id }: MobileCryptoDeps): CryptoProvider {
  assertSodiumConstants(sodium);
  return {
    pwhash(passphrase, salt, opslimit, memlimit) {
      // Plain buffer (no guarded memory on RN) — contract-documented difference.
      return asBuffer(pwhashViaArgon2id(argon2id, passphrase, salt, opslimit, memlimit));
    },

    generichash(message, key) {
      return asBuffer(
        key === undefined
          ? sodium.crypto_generichash(32, message)
          : sodium.crypto_generichash(32, message, key),
      );
    },

    generichashSecure(message, key) {
      // Byte-identical to generichash; "secure" (guarded memory) is a Node-only
      // hardening this platform cannot provide. Kept as a separate method so
      // core's call sites stay identical across platforms.
      return asBuffer(sodium.crypto_generichash(32, message, key));
    },

    aeadEncrypt(plaintext, aad, nonce, key) {
      return asBuffer(
        sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad, null, nonce, key),
      );
    },

    aeadDecrypt(ciphertext, aad, nonce, key) {
      // The backend throws on authentication failure; core wraps VaultAuthError.
      return asBuffer(
        sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext, aad, nonce, key),
      );
    },

    randomBytes(length) {
      return asBuffer(sodium.randombytes_buf(length));
    },

    secureZero(target) {
      // Best effort: plain overwrite. No sodium_memzero fence on this backend.
      target.fill(0);
    },
  };
}
