import { SALT_BYTES } from '@northkeep/core';

/**
 * Argon2id for the mobile CryptoProvider. The RN libsodium binding does not
 * expose crypto_pwhash, so the KDF runs through react-native-quick-crypto's
 * argon2Sync (which tracks the node:crypto API added in Node 24). This module
 * is the PURE translation layer between sodium's crypto_pwhash semantics and
 * that generic Argon2id call — it is what the Node byte-exactness tests prove:
 * the same wrapper, driven by node:crypto.argon2Sync, must produce output
 * byte-identical to sodium-native's crypto_pwhash(ALG_ARGON2ID13).
 */

/** RFC 9106-style parameters, matching node:crypto / quick-crypto argon2Sync. */
export interface Argon2idParams {
  message: Uint8Array;
  nonce: Uint8Array;
  parallelism: number;
  tagLength: number;
  /** Memory cost in KiB (m_cost). */
  memory: number;
  /** Iterations (t_cost). */
  passes: number;
}

export type Argon2idFn = (params: Argon2idParams) => Uint8Array;

/** The node:crypto / react-native-quick-crypto surface the wrapper consumes. */
export interface NodeStyleArgon2Module {
  argon2Sync(algorithm: 'argon2d' | 'argon2i' | 'argon2id', parameters: Argon2idParams): Uint8Array;
}

/**
 * Translate sodium crypto_pwhash(ALG_ARGON2ID13) inputs into generic Argon2id
 * parameters. This mapping is FIXED by libsodium's implementation and must
 * never change (vault-format invariant, byte-exact tested against sodium-native):
 *   t_cost      = opslimit
 *   m_cost KiB  = floor(memlimit / 1024)   (libsodium floors non-multiples)
 *   parallelism = 1                        (always, in libsodium's Argon2)
 *   version     = 0x13 (Argon2id v1.3 — the ALG_ARGON2ID13 in the name)
 *   tag length  = 32 (the vault KDF output; KEY_BYTES)
 */
export function argon2ParamsFromSodium(
  passphrase: Uint8Array,
  salt: Uint8Array,
  opslimit: number,
  memlimit: number,
): Argon2idParams {
  if (salt.length !== SALT_BYTES) {
    throw new Error(`pwhash salt must be ${SALT_BYTES} bytes, got ${salt.length}`);
  }
  // Same floors libsodium enforces (OPSLIMIT_MIN=1, MEMLIMIT_MIN=8192). Upper
  // bounds are the caller's job: core bounds-checks header params BEFORE the
  // provider is invoked (kdfParamsInBounds), exactly as on desktop.
  if (!Number.isInteger(opslimit) || opslimit < 1) {
    throw new Error(`pwhash opslimit must be an integer >= 1, got ${opslimit}`);
  }
  if (!Number.isInteger(memlimit) || memlimit < 8192) {
    throw new Error(`pwhash memlimit must be an integer >= 8192, got ${memlimit}`);
  }
  return {
    message: passphrase,
    nonce: salt,
    parallelism: 1,
    tagLength: 32,
    memory: Math.floor(memlimit / 1024),
    passes: opslimit,
  };
}

/** sodium-crypto_pwhash-compatible Argon2id: the mobile pwhash code path. */
export function pwhashViaArgon2id(
  argon2id: Argon2idFn,
  passphrase: Uint8Array,
  salt: Uint8Array,
  opslimit: number,
  memlimit: number,
): Uint8Array {
  const out = argon2id(argon2ParamsFromSodium(passphrase, salt, opslimit, memlimit));
  if (out.length !== 32) {
    throw new Error(`Argon2id backend returned ${out.length} bytes, expected 32`);
  }
  return out;
}

/**
 * Adapt a node:crypto-shaped module (react-native-quick-crypto on device,
 * node:crypto in the byte-exactness tests) to Argon2idFn. Kept as a factory so
 * the tests exercise the exact code path the device uses.
 */
export function createNodeCryptoArgon2id(mod: NodeStyleArgon2Module): Argon2idFn {
  return (params) => mod.argon2Sync('argon2id', params);
}
