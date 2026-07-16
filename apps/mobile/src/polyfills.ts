/**
 * Global polyfills. Loaded first from index.js, before expo-router (and
 * therefore before any @northkeep/core import evaluates).
 *
 * Buffer: the vault/crypto/sync code is written against Node's Buffer and the
 * plan keeps it that way (Metro `buffer` polyfill; do NOT refactor desktop
 * code to Uint8Array). The npm `buffer` package is API-compatible for
 * everything core uses: from/alloc/concat, subarray (returns Buffer since
 * buffer@6.0.2), equals, readUInt32LE/writeUInt32LE, toString('hex'|'base64').
 *
 * NEEDS ON-DEVICE VALIDATION: exercise a full vault open/save round trip on
 * Hermes to confirm polyfill behavior matches Node byte for byte (the Week-1
 * spike proved the crypto/SQLite contracts with wasm stand-ins, not this
 * polyfill).
 */
import { Buffer } from 'buffer';

declare const global: { Buffer?: typeof Buffer };

if (typeof global.Buffer === 'undefined') {
  global.Buffer = Buffer;
}
