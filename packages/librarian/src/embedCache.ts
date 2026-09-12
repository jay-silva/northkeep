import { createHash } from 'node:crypto';
import type { Embedder } from '@northkeep/core';

/**
 * Process-local memo around an Embedder. The vault's own embedding table is
 * disposable cache that lives inside an open vault handle; the web server and
 * MCP server open the vault fresh on every request, so that table never
 * survives between searches and every query re-embeds every candidate
 * (measured: ~20 s for 859 memories). This wrapper keeps vectors in RAM keyed
 * by model + content hash, so the second search after launch is instant.
 *
 * Boundaries: nothing touches disk, the vault file, or the network beyond the
 * inner embedder's own loopback call. Vectors are derived from vault
 * plaintext, so callers clear() the cache when the vault locks. Bounded LRU.
 */
export interface CachedEmbedder extends Embedder {
  /** Drop every cached vector (call on vault lock). */
  clear(): void;
  /** Number of cached vectors, for tests and diagnostics. */
  readonly size: number;
}

export function createCachedEmbedder(inner: Embedder, maxEntries = 8192): CachedEmbedder {
  const cache = new Map<string, number[]>();
  const keyFor = (text: string): string =>
    `${inner.model} ${createHash('sha256').update(text, 'utf8').digest('hex')}`;
  return {
    model: inner.model,
    async embed(text: string): Promise<number[]> {
      const key = keyFor(text);
      const hit = cache.get(key);
      if (hit !== undefined) {
        // Refresh recency: Map iteration order is insertion order.
        cache.delete(key);
        cache.set(key, hit);
        return hit.slice();
      }
      const vec = await inner.embed(text);
      if (!Array.isArray(vec) || vec.length === 0) return vec;
      cache.set(key, vec.slice());
      while (cache.size > maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      return vec;
    },
    clear(): void {
      cache.clear();
    },
    get size(): number {
      return cache.size;
    },
  };
}
