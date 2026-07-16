import type { CryptoProvider } from '@northkeep/core';
import { AEAD_OVERHEAD, NONCE_BYTES } from '@northkeep/core';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { type Argon2idFn, pwhashViaArgon2id } from './argon2.js';
import type { SodiumApi } from './sodium-api.js';

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
  // Fail closed (invariant #6 / ADR 0021): the AEAD overhead and nonce size are
  // inlined in @northkeep/core and the vault format depends on them. noble's
  // XChaCha requires exactly NONCE_BYTES, and an empty message encrypts to just
  // the auth tag, so the ciphertext length IS the overhead.
  const probe = xchacha20poly1305(new Uint8Array(32), new Uint8Array(NONCE_BYTES), new Uint8Array(0)).encrypt(
    new Uint8Array(0),
  );
  if (probe.length !== AEAD_OVERHEAD) {
    throw new Error(
      `@northkeep/platform-mobile: AEAD overhead ${probe.length} does not match core ` +
        `AEAD_OVERHEAD=${AEAD_OVERHEAD}; refusing to run.`,
    );
  }
  return {
    pwhash(passphrase, salt, opslimit, memlimit) {
      // Plain buffer (no guarded memory on RN) — contract-documented difference.
      return asBuffer(pwhashViaArgon2id(argon2id, passphrase, salt, opslimit, memlimit));
    },

    generichash(message, key) {
      try {
        return asBuffer(
          key === undefined
            ? sodium.crypto_generichash(32, new Uint8Array(message))
            : sodium.crypto_generichash(32, new Uint8Array(message), new Uint8Array(key)),
        );
      } catch (err) {
        throw new Error(`generichash: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    generichashSecure(message, key) {
      // Byte-identical to generichash; "secure" (guarded memory) is a Node-only
      // hardening this platform cannot provide. Kept as a separate method so
      // core's call sites stay identical across platforms. Plain Uint8Array args
      // (not the Buffer polyfill) for the native binding.
      try {
        return asBuffer(sodium.crypto_generichash(32, new Uint8Array(message), new Uint8Array(key)));
      } catch (err) {
        throw new Error(`generichashSecure: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    aeadEncrypt(plaintext, aad, nonce, key) {
      // XChaCha20-Poly1305 via @noble/ciphers (pure JS, accepts the binary AAD),
      // NOT the native libsodium binding, whose AEAD only takes a string AAD.
      // Byte-identical to desktop's libsodium (test/byte-exact.test.ts).
      return asBuffer(xchacha20poly1305(key, nonce, aad).encrypt(plaintext));
    },

    aeadDecrypt(ciphertext, aad, nonce, key) {
      // noble throws on authentication failure; core wraps VaultAuthError.
      return asBuffer(xchacha20poly1305(key, nonce, aad).decrypt(ciphertext));
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
