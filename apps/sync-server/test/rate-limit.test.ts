import { describe, expect, it } from 'vitest';
import { createRateLimiter, rateLimitFromEnv } from '../src/rate-limit.js';

describe('createRateLimiter', () => {
  it('allows up to the limit, then blocks with a retry-after', () => {
    let t = 1_000_000;
    const rl = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => t });
    expect(rl.check('a')).toBeNull();
    expect(rl.check('a')).toBeNull();
    expect(rl.check('a')).toBeNull();
    const retry = rl.check('a');
    expect(retry).not.toBeNull();
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(60);
  });

  it('keys are independent', () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 5 });
    expect(rl.check('a')).toBeNull();
    expect(rl.check('b')).toBeNull();
    expect(rl.check('a')).not.toBeNull();
  });

  it('allows again after the window slides past old hits', () => {
    let t = 0;
    const rl = createRateLimiter({ limit: 2, windowMs: 10_000, now: () => t });
    t = 1_000;
    expect(rl.check('a')).toBeNull();
    t = 2_000;
    expect(rl.check('a')).toBeNull();
    t = 3_000;
    expect(rl.check('a')).not.toBeNull();
    t = 11_001; // first hit (t=1000) now outside the window
    expect(rl.check('a')).toBeNull();
    t = 11_500; // window now holds 2000 + 11001 = at the limit again
    expect(rl.check('a')).not.toBeNull();
  });

  it('retry-after counts down toward the oldest hit expiring', () => {
    let t = 0;
    const rl = createRateLimiter({ limit: 1, windowMs: 30_000, now: () => t });
    expect(rl.check('a')).toBeNull(); // hit at t=0
    t = 20_000;
    expect(rl.check('a')).toBe(10); // 10s until t=0 leaves the 30s window
  });

  it('caps tracked keys by evicting the stalest (evicted key gets a fresh window)', () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 2, now: () => 5 });
    expect(rl.check('a')).toBeNull();
    expect(rl.check('a')).not.toBeNull(); // at limit
    expect(rl.check('b')).toBeNull();
    expect(rl.check('c')).toBeNull(); // map full → evicts 'a' (stalest)
    expect(rl.check('a')).toBeNull(); // forgotten, so 'a' is admitted fresh
  });
});

describe('rateLimitFromEnv', () => {
  it('unset or blank → default', () => {
    expect(rateLimitFromEnv(undefined, 120)).toBe(120);
    expect(rateLimitFromEnv('', 120)).toBe(120);
    expect(rateLimitFromEnv('  ', 120)).toBe(120);
  });
  it('explicit 0 disables (null)', () => {
    expect(rateLimitFromEnv('0', 120)).toBeNull();
  });
  it('a positive integer overrides', () => {
    expect(rateLimitFromEnv('500', 120)).toBe(500);
  });
  it('garbage or negatives fall back to the default', () => {
    expect(rateLimitFromEnv('abc', 120)).toBe(120);
    expect(rateLimitFromEnv('-5', 120)).toBe(120);
    expect(rateLimitFromEnv('1.5', 120)).toBe(120);
  });
});
