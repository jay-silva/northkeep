import { describe, expect, it } from 'vitest';
import type { MemoryEntry } from '@northkeep/core';
import { runReviewPass, type ReviewOutbound, type ReviewPassPhase } from '../src/review.js';
import type { ReviewPackHandle } from '../src/reviewRestore.js';

function mem(n: number, scope: string, content: string): MemoryEntry {
  return {
    id: `0000000${n}-0000-4000-8000-000000000000`, content, type: 'semantic', scope, source: 'test',
    source_model: null, confidence: 1, created_at: '2026-01-01T00:00:00Z', valid_from: null,
    superseded_at: null, superseded_by: null, forgotten_at: null,
    prev_hash: '0'.repeat(64), entry_hash: '0'.repeat(64), metadata: null,
  };
}

// Two collections of two related memories each: the pass compares within a
// collection, so this is two review batches.
const ENTRIES = [
  mem(1, 'alpha', 'Zyler Okonkwo keeps the spare key under the blue pot.'),
  mem(2, 'alpha', 'The spare key moved from the blue pot to the lockbox.'),
  mem(3, 'beta', 'Quarterly rent for unit 4 is due on the first.'),
  mem(4, 'beta', 'Rent for unit 4 is now due on the fifth.'),
];

function record(): { events: string[]; onPhase: (p: ReviewPassPhase) => void } {
  const events: string[] = [];
  return { events, onPhase: (p) => events.push(JSON.stringify(p)) };
}

function leaks(events: string[]): string[] {
  return ENTRIES.flatMap((e) => [e.content, e.scope, e.id, ...e.content.split(' ').filter((w) => w.length > 5)])
    .filter((needle) => events.some((event) => event.includes(needle)));
}

describe('runReviewPass progress phases', () => {
  it('local: reports each comparison, then each batch before it is checked, then the finished count', async () => {
    const { events, onPhase } = record();
    await runReviewPass(ENTRIES, {
      generateJson: async () => { events.push('generate'); return '{"proposals":[]}'; },
    }, { embed: async () => [1, 0, 0], onPhase });
    expect(events).toEqual([
      '{"phase":"comparing","done":0,"total":4}',
      '{"phase":"comparing","done":1,"total":4}',
      '{"phase":"comparing","done":2,"total":4}',
      '{"phase":"comparing","done":3,"total":4}',
      '{"phase":"comparing","done":4,"total":4}',
      '{"phase":"batch","done":0,"total":2,"failed":0}',
      'generate',
      '{"phase":"batch","done":1,"total":2,"failed":0}',
      'generate',
      '{"phase":"batch","done":2,"total":2,"failed":0}',
    ]);
    expect(leaks(events)).toEqual([]);
  });

  it('cloud: announces masking before prepare and each batch before its send', async () => {
    const { events, onPhase } = record();
    const outbound: ReviewOutbound = {
      async prepare(packs) {
        events.push(`prepare ${packs.length}`);
        return packs.map((): ReviewPackHandle => Object.freeze({ tag: 'k7q2', tokens: new Set<string>(), tokenInfo: new Map() }));
      },
      async send() { events.push('send'); return '{"proposals":[]}'; },
    };
    const result = await runReviewPass(ENTRIES, outbound, { embed: async () => [1, 0, 0], onPhase });
    expect(events.slice(5)).toEqual([
      '{"phase":"masking"}',
      'prepare 2',
      '{"phase":"batch","done":0,"total":2,"failed":0}',
      'send',
      '{"phase":"batch","done":1,"total":2,"failed":0}',
      'send',
      '{"phase":"batch","done":2,"total":2,"failed":0}',
    ]);
    expect(result.failedBatches).toBe(0);
    expect(leaks(events)).toEqual([]);
  });

  it('counts a batch whose provider fails twice as failed, and keeps going', async () => {
    const { events, onPhase } = record();
    let calls = 0;
    const result = await runReviewPass(ENTRIES, {
      generateJson: async () => {
        calls += 1;
        // Batch 1 (calls 1 and 2, the retry) fails; batch 2 succeeds.
        if (calls <= 2) throw new Error('HTTP 500 from provider');
        return '{"proposals":[]}';
      },
    }, { embed: async () => [1, 0, 0], onPhase });
    expect(events.slice(5)).toEqual([
      '{"phase":"batch","done":0,"total":2,"failed":0}',
      '{"phase":"batch","done":1,"total":2,"failed":1}',
      '{"phase":"batch","done":2,"total":2,"failed":1}',
    ]);
    expect(result.failedBatches).toBe(1);
    expect(result.batches).toBe(2);
  });

  it('with no embedder, reports no phases and no batches', async () => {
    const { events, onPhase } = record();
    const result = await runReviewPass(ENTRIES, { generateJson: async () => '{"proposals":[]}' }, { onPhase });
    expect(events).toEqual([]);
    expect(result).toMatchObject({ batches: 0, failedBatches: 0 });
  });
});
