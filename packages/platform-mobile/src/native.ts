import sodium from 'react-native-libsodium';
// Named import, NOT `import * as`: quick-crypto is an ESM module with a
// getter-only `default`, and Babel's wildcard-interop helper crashes on device
// with "Cannot assign to property 'default' which has only a getter". A named
// import compiles to plain member access and sidesteps that helper entirely.
import { argon2Sync } from 'react-native-quick-crypto';
import type { CryptoProvider } from '@northkeep/core';
import { createNodeCryptoArgon2id } from './argon2.js';
import { createMobileCryptoProvider } from './crypto.js';

/**
 * Device wiring: react-native-libsodium (JSI libsodium, libsodium-wrappers-
 * compatible API) for AEAD/BLAKE2b/random, react-native-quick-crypto (JSI,
 * node:crypto-compatible) for Argon2id. All LOGIC lives in crypto.ts/argon2.ts,
 * which the Node byte-exactness suite proves against platform-node; this file
 * is only the import glue and therefore the one part that can ONLY be validated
 * on a device (ADR 0021).
 */

/** react-native-libsodium keeps libsodium-wrappers' ready promise for API
 * compatibility (it resolves immediately — JSI loads synchronously). Await it
 * once at app startup before constructing the platform. */
export async function mobileCryptoReady(): Promise<void> {
  await sodium.ready;
}

export function mobileCryptoProvider(): CryptoProvider {
  return createMobileCryptoProvider({
    sodium,
    argon2id: createNodeCryptoArgon2id({ argon2Sync }),
  });
}
