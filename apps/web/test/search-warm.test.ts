import { describe, expect, it } from 'vitest';
import { createSearchWarmer, type WarmDependencies } from '../src/search-warm.js';

function harness(overrides: Partial<WarmDependencies> = {}) {
  const calls = { start: 0, list: 0, embed: [] as string[], status: 0 };
  let clock = 1_000;
  let unlocked = true;
  const runtime = { runtime: 'running', embedding_model: 'installed', can_start: true };
  const deps: WarmDependencies = {
    isUnlocked: () => unlocked,
    status: async () => { calls.status += 1; return { ...runtime }; },
    start: async () => { calls.start += 1; runtime.runtime = 'running'; },
    listContents: async () => { calls.list += 1; return ['a', 'b', 'c']; },
    embed: async (text) => { calls.embed.push(text); return [1]; },
    now: () => clock,
    retryAfterMs: 60_000,
    ...overrides,
  };
  const warmer = createSearchWarmer(deps);
  return {
    warmer, calls, runtime,
    lock: () => { unlocked = false; },
    unlock: () => { unlocked = true; },
    advance: (ms: number) => { clock += ms; },
  };
}

describe('createSearchWarmer', () => {
  it('embeds every memory once and then stays done', async () => {
    const h = harness();
    h.warmer.poke();
    expect(h.warmer.state).toBe('running');
    await h.warmer.settled();
    expect(h.warmer.state).toBe('done');
    expect(h.calls.embed).toEqual(['a', 'b', 'c']);
    h.warmer.poke();
    await h.warmer.settled();
    expect(h.calls.list).toBe(1);
  });

  it('starts the runtime through the gated path when it is down', async () => {
    const h = harness();
    h.runtime.runtime = 'unavailable';
    h.warmer.poke();
    await h.warmer.settled();
    expect(h.calls.start).toBe(1);
    expect(h.warmer.state).toBe('done');
  });

  it('does nothing when the runtime is down and cannot be started, then backs off', async () => {
    const h = harness();
    h.runtime.runtime = 'unavailable';
    h.runtime.can_start = false;
    h.warmer.poke();
    await h.warmer.settled();
    expect(h.calls.start).toBe(0);
    expect(h.calls.list).toBe(0);
    expect(h.warmer.state).toBe('idle');
    h.warmer.poke();
    expect(h.warmer.state).toBe('idle');
    expect(h.calls.status).toBe(1);
    h.advance(60_001);
    h.warmer.poke();
    await h.warmer.settled();
    expect(h.calls.status).toBe(2);
  });

  it('skips when the embedding model is missing (never downloads)', async () => {
    const h = harness();
    h.runtime.embedding_model = 'missing';
    h.warmer.poke();
    await h.warmer.settled();
    expect(h.calls.list).toBe(0);
    expect(h.warmer.state).toBe('idle');
  });

  it('stops as soon as the vault locks and can run again after unlock', async () => {
    let lockedOnce = false;
    const h = harness({
      embed: async function (this: void, text: string) {
        h.calls.embed.push(text);
        if (text === 'a' && !lockedOnce) { lockedOnce = true; h.lock(); }
        return [1];
      },
    });
    h.warmer.poke();
    await h.warmer.settled();
    expect(h.calls.embed).toEqual(['a']);
    expect(h.warmer.state).toBe('idle');
    h.warmer.reset();
    h.unlock();
    h.warmer.poke();
    await h.warmer.settled();
    expect(h.warmer.state).toBe('done');
  });

  it('treats an embedder failure as not-now and backs off', async () => {
    const h = harness({ embed: async () => { throw new Error('down'); } });
    h.warmer.poke();
    await h.warmer.settled();
    expect(h.warmer.state).toBe('idle');
    h.warmer.poke();
    expect(h.warmer.state).toBe('idle');
  });

  it('never runs while locked and never overlaps', async () => {
    const h = harness();
    h.lock();
    h.warmer.poke();
    expect(h.warmer.state).toBe('idle');
    h.unlock();
    h.warmer.poke();
    h.warmer.poke();
    await h.warmer.settled();
    expect(h.calls.list).toBe(1);
  });
});
