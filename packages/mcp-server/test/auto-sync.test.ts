import { describe, expect, it } from 'vitest';
import { describeEvent, flushBounded } from '../src/auto-sync.js';

/**
 * ADR 0044 in the standalone stdio server: shutdown gives a pending push a
 * bounded chance, then always stops the engine so no timer can outlive the
 * orphan-prevention exit in server.ts.
 */
describe('flushBounded', () => {
  function fakeEngine(flushMs: number | 'hang'): { flush: () => Promise<void>; stop: () => void; stopped: number; flushed: number } {
    const e = {
      stopped: 0,
      flushed: 0,
      stop() {
        e.stopped += 1;
      },
      flush() {
        e.flushed += 1;
        if (flushMs === 'hang') return new Promise<void>(() => {});
        return new Promise<void>((r) => setTimeout(r, flushMs));
      },
    };
    return e;
  }

  it("resolves 'flushed' when the flush finishes inside the budget, and stops the engine", async () => {
    const e = fakeEngine(10);
    await expect(flushBounded(e, 500)).resolves.toBe('flushed');
    expect(e.flushed).toBe(1);
    expect(e.stopped).toBe(1);
  });

  it('gives up at the budget when the flush hangs, and still stops the engine', async () => {
    const e = fakeEngine('hang');
    const started = Date.now();
    await expect(flushBounded(e, 60)).resolves.toBe('timeout');
    expect(Date.now() - started).toBeLessThan(500);
    expect(e.stopped).toBe(1);
  });

  it("resolves 'failed' and logs one line when the flush throws (the write is on disk; the next wake sends it)", async () => {
    let stopped = 0;
    const lines: string[] = [];
    const e = { flush: () => Promise.reject(new Error('HTTP 500')), stop: () => void (stopped += 1) };
    await expect(flushBounded(e, 500, (l) => lines.push(l))).resolves.toBe('failed');
    expect(lines).toEqual(['northkeep MCP server sync failed at exit: HTTP 500']);
    expect(stopped).toBe(1);
  });
});

describe('describeEvent', () => {
  it('names versions and reasons, never content', () => {
    expect(describeEvent({ type: 'pushed', version: 7 })).toContain('pushed version 7');
    expect(describeEvent({ type: 'pulled', version: 8 })).toContain('pulled version 8');
    expect(describeEvent({ type: 'diverged' })).toMatch(/both changed/);
    expect(describeEvent({ type: 'error', message: 'HTTP 500' })).toContain('HTTP 500');
    expect(describeEvent({ type: 'paused', reason: 'subscription' })).toContain('subscription required');
    expect(describeEvent({ type: 'paused', reason: 'private' })).toContain('private server');
    expect(describeEvent({ type: 'in-sync' })).toContain('in sync');
  });
});
