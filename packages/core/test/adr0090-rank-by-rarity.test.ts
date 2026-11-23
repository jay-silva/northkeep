import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KDF_INTERACTIVE, generateDeviceSecret } from '../src/crypto.js';
import { lengthPenalty, searchTerms, wordWeights } from '../src/search-rules.js';
import type { Embedder } from '../src/types.js';
import { Vault } from '../src/vault.js';
import { RANKING_CASES, type RankingCase, type RankingMemory } from './ranking-cases.js';

// ADR 0090. Every fact here is fictional.

const NOW = Date.parse('2026-11-23T12:00:00.000Z');
const DAY = 86_400_000;
let dir: string;
let vault: Vault;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-0090-'));
  vault = Vault.create({ path: path.join(dir, 'vault.nkv'), passphrase: 'a strong test passphrase', deviceSecret: generateDeviceSecret(), kdf: KDF_INTERACTIVE });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vault.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Save memories with their ages, oldest first, then set the clock to "now". */
function seed(memories: RankingMemory[], extra: { scope?: string } = {}): void {
  const age = (m: RankingMemory): number => m.daysAgo ?? (m.confirmed ? 11 : 175);
  for (const m of [...memories].sort((a, b) => age(b) - age(a))) {
    vi.setSystemTime(NOW - age(m) * DAY);
    vault.remember({
      content: m.content,
      type: m.type ?? (m.confirmed ? 'identity' : 'semantic'),
      source: 'mcp',
      scope: extra.scope,
      metadata: m.confirmed ? { confirmed: { by: 'user', at: new Date().toISOString() } } : null,
    });
  }
  vi.setSystemTime(NOW);
}

/** Where the answer lands, counting from 1; 0 when it is not in the results. */
const rankOf = (contents: string[], want: string): number => contents.findIndex((c) => c.includes(want)) + 1;
const contents = (results: Array<{ entry: { content: string } }>): string[] => results.map((r) => r.entry.content);

/**
 * A stand-in for the local search model: a text becomes a bag of its words,
 * so two texts are close in meaning exactly as far as they share words.
 */
const bagOfWords: Embedder = {
  model: 'bag-of-words',
  async embed(text) {
    const v = new Array<number>(512).fill(0);
    for (const term of searchTerms(text)) {
      let h = 2166136261;
      for (const ch of term) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
      v[(h >>> 0) % 512] += 1;
    }
    return v;
  },
};

function expectFound(c: RankingCase, found: string[]): void {
  const rank = rankOf(found, c.want);
  if (c.first) expect(rank, found.slice(0, 3).join(' | ')).toBe(1);
  else expect(rank, found.slice(0, 3).join(' | ')).toBeGreaterThan(0);
}

describe.each(RANKING_CASES)('ADR 0090 hard case: $name', (c) => {
  it('finds the answer by word', () => {
    seed(c.memories);
    expectFound(c, contents(vault.retrieve(c.query)));
  });

  it.skipIf(c.byMeaning === false)('finds the answer by meaning', async () => {
    seed(c.memories);
    const r = await vault.retrieveSemantic(c.query, bagOfWords);
    expect(r.mode).toBe('semantic');
    expectFound(c, contents(r.results));
  });
});

describe('ADR 0090 D1: words weigh by how rare they are among the rows searched', () => {
  const rows = (n: number, holding: Record<string, number>): Array<Set<string>> =>
    Array.from({ length: n }, (_, i) => new Set(Object.entries(holding).filter(([, count]) => i < count).map(([word]) => word)));

  it('a rare word outweighs a common one, and a word no row holds weighs nothing', () => {
    const w = wordWeights(new Set(['pat', 'car', 'vehicle']), rows(100, { pat: 40, car: 1 }));
    expect(w.get('car')!).toBeGreaterThan(3 * w.get('pat')!);
    expect(w.get('pat')!).toBeGreaterThan(0);
    expect(w.get('vehicle')).toBe(0);
  });

  it('weights stay close in a tiny vault, so two rows are not enough to call a word rare', () => {
    const w = wordWeights(new Set(['name', 'harbor']), rows(2, { name: 1, harbor: 2 }));
    expect(w.get('name')! / w.get('harbor')!).toBeLessThan(1.4);
  });

  it('a filter does not let rows outside it change the order', () => {
    seed([{ content: 'The spare car key hangs by the door' }, ...Array.from({ length: 9 }, (_, i) => ({ content: `Pat parks trailer ${i} in the garage`, confirmed: true }))], { scope: 'garage' });
    seed([...Array.from({ length: 60 }, (_, i) => ({ content: `Car wash receipt ${i}` })), ...Array.from({ length: 200 }, (_, i) => ({ content: `Tide table ${i} is pinned by the door` }))]);
    expect(contents(vault.retrieve('Pat car', { scope: 'garage' }))[0]).toBe('The spare car key hangs by the door');
  });
});

describe('ADR 0090 D3: long memories are marked down by a share, confirmed ones not at all', () => {
  it('takes 15% off per doubling past 64 distinct words, up to half', () => {
    expect(lengthPenalty(64)).toBe(0);
    expect(lengthPenalty(128)).toBeCloseTo(0.15, 5);
    expect(lengthPenalty(256)).toBeCloseTo(0.3, 5);
    expect(lengthPenalty(100_000)).toBe(0.5);
  });

  it('a long confirmed memory scores as if it were short', () => {
    const long = `Pat Example is the harbor office director. ${Array.from({ length: 300 }, (_, i) => `xword${i}`).join(' ')}`;
    seed([{ content: long, confirmed: true, daysAgo: 0 }, { content: 'Pat Example is the harbor office director', confirmed: true, daysAgo: 0 }]);
    const [a, b] = vault.retrieve('harbor office director');
    expect(a.score).toBeCloseTo(b.score, 5);
  });
});

describe('ADR 0090: the trade it makes on purpose', () => {
  it('a confirmed memory and a note that matches one more word both come back', () => {
    seed([
      { content: 'Pat works at Harbor Rescue', confirmed: true, daysAgo: 60 },
      { content: 'Session note: Pat said the old employer was Harbor Freight', type: 'episodic', daysAgo: 10 },
      ...Array.from({ length: 40 }, (_, i) => ({ content: `Tide table ${i} is pinned by the door` })),
    ]);
    const found = contents(vault.retrieve('Pat employer Harbor')).slice(0, 2);
    expect(found).toContain('Pat works at Harbor Rescue');
    expect(found).toContain('Session note: Pat said the old employer was Harbor Freight');
  });

  it('a correction saved as a new memory and the old fact both come back', () => {
    seed([
      { content: 'Pat is a dispatcher at Harbor Rescue, a job held since 2020', daysAgo: 365 },
      { content: 'Correction: Pat left dispatch and now trains crews at Harbor Rescue', daysAgo: 1 },
      ...Array.from({ length: 40 }, (_, i) => ({ content: `Tide table ${i} is pinned by the door` })),
    ]);
    const found = contents(vault.retrieve('Pat dispatcher job Harbor Rescue')).slice(0, 2);
    expect(found.some((c) => c.startsWith('Correction:'))).toBe(true);
    expect(found.some((c) => c.startsWith('Pat is a dispatcher'))).toBe(true);
  });
});

describe('ADR 0090, not fixed: by meaning, short rows that echo the question can outrank a long answer', () => {
  it.each(RANKING_CASES.filter((c) => c.byMeaning === false))('$name: the answer is still found by word', (c) => {
    seed(c.memories);
    expect(rankOf(contents(vault.retrieve(c.query)), c.want)).toBe(1);
  });
});
