import sodium from 'sodium-native';
import type { CryptoProvider } from '@northkeep/core';

/**
 * Node CryptoProvider: sodium-native (libsodium) behind the platform seam. Every
 * primitive here is byte-for-byte what the mobile adapter must reproduce
 * (verified in the Week-1 spike). This is the ONLY crypto backend on desktop;
 * changing it is a key-handling change requiring adversarial review (invariant #3).
 */

/** sodium-native wants real Buffers; core always passes Buffers, but be safe. */
function buf(x: Uint8Array): Buffer {
  return Buffer.isBuffer(x) ? x : Buffer.from(x.buffer, x.byteOffset, x.byteLength);
}

export function nodeCryptoProvider(): CryptoProvider {
  return {
    pwhash(passphrase, salt, opslimit, memlimit) {
      // Guarded (mlock'd, guard-paged) memory for the KDF output — matches the
      // pre-refactor deriveMasterKey. Only pwhash is guarded: generichash runs
      // in the hash-chain hot loop where per-call sodium_malloc would exhaust
      // RLIMIT_MEMLOCK, so its output is a plain buffer (same as before).
      const out = sodium.sodium_malloc(32);
      sodium.crypto_pwhash(
        out,
        buf(passphrase),
        buf(salt),
        opslimit,
        memlimit,
        sodium.crypto_pwhash_ALG_ARGON2ID13,
      );
      return out;
    },

    generichash(message, key) {
      const out = Buffer.alloc(32);
      if (key === undefined) sodium.crypto_generichash(out, buf(message));
      else sodium.crypto_generichash(out, buf(message), buf(key));
      return out;
    },

    generichashSecure(message, key) {
      // Master key into guarded (mlock'd, guard-paged) memory — matches the
      // pre-refactor deriveMasterKey, which allocated the master key with
      // sodium_malloc. Called once per unlock, so RLIMIT_MEMLOCK is not a concern.
      const out = sodium.sodium_malloc(32);
      sodium.crypto_generichash(out, buf(message), buf(key));
      return out;
    },

    aeadEncrypt(plaintext, aad, nonce, key) {
      const ciphertext = Buffer.alloc(
        plaintext.length + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES,
      );
      sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        ciphertext,
        buf(plaintext),
        buf(aad),
        null,
        buf(nonce),
        buf(key),
      );
      return ciphertext;
    },

    aeadDecrypt(ciphertext, aad, nonce, key) {
      // Throws on authentication failure; core wraps that in VaultAuthError.
      const plaintext = Buffer.alloc(
        ciphertext.length - sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES,
      );
      sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        plaintext,
        null,
        buf(ciphertext),
        buf(aad),
        buf(nonce),
        buf(key),
      );
      return plaintext;
    },

    randomBytes(length) {
      const b = Buffer.alloc(length);
      sodium.randombytes_buf(b);
      return b;
    },

    secureZero(target) {
      sodium.sodium_memzero(buf(target));
    },
  };
}

/**
 * Fail-fast guard: the KDF params, byte sizes, and AEAD/Argon2 constants are
 * inlined as literals in @northkeep/core so it carries no native dependency.
 * Assert here (at platform construction) that the linked libsodium still agrees,
 * so a future sodium-native bump that changed a constant is caught loudly instead
 * of silently producing an incompatible vault format.
 */
export function assertLibsodiumConstants(expected: {
  SALT_BYTES: number;
  NONCE_BYTES: number;
  AEAD_OVERHEAD: number;
  KDF_MODERATE: { opslimit: number; memlimit: number };
  KDF_INTERACTIVE: { opslimit: number; memlimit: number };
}): void {
  const checks: Array<[string, number, number]> = [
    ['SALT_BYTES', expected.SALT_BYTES, sodium.crypto_pwhash_SALTBYTES],
    ['NONCE_BYTES', expected.NONCE_BYTES, sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES],
    ['AEAD_OVERHEAD', expected.AEAD_OVERHEAD, sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES],
    ['KDF_MODERATE.opslimit', expected.KDF_MODERATE.opslimit, sodium.crypto_pwhash_OPSLIMIT_MODERATE],
    ['KDF_MODERATE.memlimit', expected.KDF_MODERATE.memlimit, sodium.crypto_pwhash_MEMLIMIT_MODERATE],
    ['KDF_INTERACTIVE.opslimit', expected.KDF_INTERACTIVE.opslimit, sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE],
    ['KDF_INTERACTIVE.memlimit', expected.KDF_INTERACTIVE.memlimit, sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE],
  ];
  for (const [name, got, want] of checks) {
    if (got !== want) {
      throw new Error(
        `@northkeep/platform-node: core constant ${name}=${got} does not match linked libsodium ${want}. ` +
          'The vault format depends on these; refusing to run.',
      );
    }
  }
}
