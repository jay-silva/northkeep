/**
 * Per-account request throttle (no dependencies, in-memory). Copied verbatim
 * from apps/sync-server/src/rate-limit.ts (ADR 0016 reuses this line of
 * defence). The only change is `rateLimitFromEnv` reads the connector's own env
 * var name at the call site — the function itself is identical.
 *
 * Keyed by token hash when the request carries a bearer token, else by client
 * IP. State is per-process: on Vercel each warm instance keeps its own window,
 * so the effective global ceiling is limit × instances — an intentional first
 * line against a single abusive account or a brute-force flood, not a precise
 * quota (KNOWN-LIMITS.md).
 *
 * Sliding window over timestamps, pruned on access. The key map is size-capped
 * so an attacker rotating tokens/IPs can't grow memory without bound; when the
 * cap is hit the stalest key is evicted.
 */

export interface RateLimiter {
  /** Returns null when allowed, else seconds until the caller may retry. */
  check(key: string): number | null;
}

export interface RateLimitOptions {
  /** Max requests per key per window. */
  limit: number;
  windowMs: number;
  /** Max distinct keys tracked before stalest-key eviction. */
  maxKeys?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export function createRateLimiter(options: RateLimitOptions): RateLimiter {
  const { limit, windowMs, maxKeys = 10_000, now = Date.now } = options;
  const hits = new Map<string, number[]>();

  return {
    check(key: string): number | null {
      const t = now();
      const cutoff = t - windowMs;
      let stamps = hits.get(key);
      if (stamps) {
        // Prune expired timestamps in place (they are appended in order).
        let firstLive = 0;
        while (firstLive < stamps.length && (stamps[firstLive] as number) <= cutoff) firstLive++;
        if (firstLive > 0) stamps.splice(0, firstLive);
      } else {
        if (hits.size >= maxKeys) evictStalest(hits);
        stamps = [];
        hits.set(key, stamps);
      }
      if (stamps.length >= limit) {
        const oldest = stamps[0] as number;
        return Math.max(1, Math.ceil((oldest + windowMs - t) / 1000));
      }
      stamps.push(t);
      // Re-insert so Map iteration order approximates recency for eviction.
      hits.delete(key);
      hits.set(key, stamps);
      return null;
    },
  };
}

/** Drop the key least recently touched (first in Map insertion order). */
function evictStalest(hits: Map<string, number[]>): void {
  const first = hits.keys().next();
  if (!first.done) hits.delete(first.value);
}

/**
 * Read the per-window request cap from an env value.
 * Unset → the default; explicit 0 → rate limiting disabled (returns null).
 */
export function rateLimitFromEnv(raw: string | undefined, defaultLimit: number): number | null {
  if (raw === undefined || raw.trim() === '') return defaultLimit;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return defaultLimit;
  return n === 0 ? null : n;
}
