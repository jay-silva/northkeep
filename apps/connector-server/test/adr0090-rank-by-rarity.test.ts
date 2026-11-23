import { beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp.js';
import { rankSharedEntries } from '../src/search-rules.js';
import * as hostedRules from '../src/search-rules.js';
import * as deviceRules from '../../../packages/core/src/search-rules.js';
import { InMemoryConnectorStorage } from '../src/storage.js';
import { RANKING_CASES } from '../../../packages/core/test/ranking-cases.js';
import { seedEncryptedEntry, testAccountDek } from './helpers.js';

// ADR 0090 on the hosted connector. Every fact here is fictional.

const row = (content: string, extra: { confirmed?: boolean; scope?: string; type?: string } = {}) =>
  ({ type: extra.type ?? 'semantic', scope: extra.scope ?? 'personal', content, ...(extra.confirmed ? { confirmed: true } : {}) });
const top = (rows: ReturnType<typeof row>[], query: string, limit = 8): string[] => rankSharedEntries(rows, query, limit).map((r) => r.content);

describe.each(RANKING_CASES)('ADR 0090 hard case on the connector: $name', (c) => {
  it('finds the answer', () => {
    const found = top(c.memories.map((m) => row(m.content, { confirmed: m.confirmed, type: m.type ?? (m.confirmed ? 'identity' : 'semantic') })), c.query);
    const rank = found.findIndex((content) => content.includes(c.want)) + 1;
    if (c.first) expect(rank, found.slice(0, 3).join(' | ')).toBe(1);
    else expect(rank, found.slice(0, 3).join(' | ')).toBeGreaterThan(0);
  });
});

describe('ADR 0090 D5: the connector weighs words the way the device does', () => {
  it('uses the device\'s weights and long-row cut on the same rows', () => {
    const rows = Array.from({ length: 30 }, (_, i) => new Set(i < 12 ? ['pat', `w${i}`] : i === 12 ? ['car'] : [`w${i}`]));
    const query = new Set(['pat', 'car', 'vehicle']);
    expect([...hostedRules.wordWeights(query, rows)]).toEqual([...deviceRules.wordWeights(query, rows)]);
    expect(hostedRules.weightedMatch(hostedRules.wordWeights(query, rows), new Set(['car']))).toBe(deviceRules.weightedMatch(deviceRules.wordWeights(query, rows), new Set(['car'])));
    for (const words of [10, 64, 200, 5000]) expect(hostedRules.lengthPenalty(words)).toBe(deviceRules.lengthPenalty(words));
  });

  it('a confirmed memory leads an unconfirmed one that matches the same words, and is not marked down for length', () => {
    const long = `Pat Example is the harbor office director. ${Array.from({ length: 300 }, (_, i) => `xword${i}`).join(' ')}`;
    expect(top([row('Pat Example was the harbor office director last year'), row(long, { confirmed: true })], 'harbor office director')[0]).toBe(long);
    expect(top([row(long), row('Pat Example is the harbor office director')], 'harbor office director')[0]).toBe('Pat Example is the harbor office director');
  });

  it('a query that matches only a scope name still returns that scope\'s rows', () => {
    const rows = [...Array.from({ length: 24 }, (_, i) => row(`Tide table ${i} is pinned by the door`)), row('The crew meets on Friday', { scope: 'project:harbor' })];
    expect(top(rows, 'harbor')).toEqual(['The crew meets on Friday']);
  });

  it('a word in the text outranks the same word found only in a scope name', () => {
    const rows = [row('The crew meets on Friday', { scope: 'project:harbor' }), row('The harbor crew list is on the wall'), ...Array.from({ length: 24 }, (_, i) => row(`Tide table ${i} is pinned by the door`))];
    expect(top(rows, 'harbor crew').slice(0, 2)).toEqual(['The harbor crew list is on the wall', 'The crew meets on Friday']);
  });

  it('a query with no words lists everything, and one of stopwords alone finds nothing', () => {
    const rows = [row('One'), row('Two'), row('Three')];
    expect(top(rows, '  ', 2)).toEqual(['One', 'Two']);
    expect(top(rows, 'who is the')).toEqual([]);
    expect(top(rows, 'zebra')).toEqual([]);
  });
});

describe('ADR 0090 through the connector\'s search tools', () => {
  const account = 'acct-adr0090';
  const connToken = 'conn-token-adr0090';
  let storage: InMemoryConnectorStorage;
  beforeEach(() => { storage = new InMemoryConnectorStorage(); });

  it('a query that names the user returns the answer first on both tools', async () => {
    const memories = RANKING_CASES[0].memories;
    for (const [i, m] of memories.entries()) {
      await seedEncryptedEntry(storage, account, connToken, { entryId: `e${i}`, scope: 'personal', type: m.confirmed ? 'identity' : 'semantic', content: m.content, createdAt: '2026-11-21T00:00:00.000Z', ...(m.confirmed ? { confirmed: true } : {}) });
    }
    const dek = await testAccountDek(storage, account, connToken);
    const server = createMcpServer(storage, account, dek);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'adr0090-test', version: '0.0.0' });
    await client.connect(b);
    for (const tool of ['memory_retrieve', 'search'] as const) {
      const res = (await client.callTool({ name: tool, arguments: { query: 'car vehicle Pat drives' } })) as { content: Array<{ text: string }> };
      const out = res.content.map((part) => part.text).join('\n');
      expect(out.indexOf('blue hatchback'), tool).toBeGreaterThan(-1);
      expect(out.indexOf('blue hatchback'), tool).toBeLessThan(out.indexOf('ledger'));
    }
  });
});
