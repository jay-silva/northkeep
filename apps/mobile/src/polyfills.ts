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

/**
 * Guards for newer JS built-ins that bundled deps can touch and Hermes may
 * not ship yet. Each is a no-op when
 * the engine already has the real thing.
 */

type WithResolvers<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

const P = Promise as unknown as { withResolvers?: <T>() => WithResolvers<T> };
if (typeof P.withResolvers !== 'function') {
  P.withResolvers = function withResolvers<T>(): WithResolvers<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

const g = globalThis as unknown as { structuredClone?: (value: unknown) => unknown };
if (typeof g.structuredClone !== 'function') {
  // Covers the shapes pdf.js actually clones (plain data, arrays, typed
  // arrays, Map/Set, Date). Not a full spec implementation.
  const clone = (value: unknown, seen: Map<object, unknown>): unknown => {
    if (value === null || typeof value !== 'object') return value;
    const obj = value as object;
    const existing = seen.get(obj);
    if (existing !== undefined) return existing;
    if (obj instanceof Date) return new Date(obj.getTime());
    if (ArrayBuffer.isView(obj)) return (obj as unknown as { slice(): unknown }).slice();
    if (obj instanceof ArrayBuffer) return obj.slice(0);
    if (Array.isArray(obj)) {
      const out: unknown[] = [];
      seen.set(obj, out);
      for (const item of obj) out.push(clone(item, seen));
      return out;
    }
    if (obj instanceof Map) {
      const out = new Map();
      seen.set(obj, out);
      for (const [k, v] of obj) out.set(clone(k, seen), clone(v, seen));
      return out;
    }
    if (obj instanceof Set) {
      const out = new Set();
      seen.set(obj, out);
      for (const v of obj) out.add(clone(v, seen));
      return out;
    }
    const out: Record<string, unknown> = {};
    seen.set(obj, out);
    for (const [k, v] of Object.entries(obj)) out[k] = clone(v, seen);
    return out;
  };
  g.structuredClone = (value: unknown) => clone(value, new Map());
}
