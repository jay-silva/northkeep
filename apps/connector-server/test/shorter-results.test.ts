import { beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp.js';
import { EXCERPT_OVER, excerptFor } from '../src/search-rules.js';
import { InMemoryConnectorStorage } from '../src/storage.js';
import { seedEncryptedEntry, testAccountDek } from './helpers.js';

// Every fact here is fictional.

const padding = (n: number, word: string): string => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ');
const longNote = `Session note. ${padding(200, 'chatter')} Pat's car is a blue hatchback kept at the harbor office. ${padding(200, 'afterword')}`;

describe('excerptFor', () => {
  it('leaves a short memory exactly as it is', () => {
    const short = 'Pat keeps the ledger\nin the harbor office';
    expect(excerptFor(short, 'ledger')).toEqual({ text: short, cut: false });
    expect('x'.repeat(EXCERPT_OVER).length).toBe(EXCERPT_OVER);
    expect(excerptFor('x'.repeat(EXCERPT_OVER), 'x').cut).toBe(false);
  });

  it('cuts a long memory to the stretch that holds the query words', () => {
    const { text, cut } = excerptFor(longNote, 'what car does Pat drive');
    expect(cut).toBe(true);
    expect(text).toContain("Pat's car is a blue hatchback");
    expect(text.length).toBeLessThan(420);
    expect(text.startsWith('… ')).toBe(true);
    expect(text.endsWith(' …')).toBe(true);
  });

  it('shows the start when no query word is in it, or there is no query', () => {
    expect(excerptFor(longNote, 'zebra').text.startsWith('Session note.')).toBe(true);
    expect(excerptFor(longNote, '').text.startsWith('Session note.')).toBe(true);
  });
});

describe('the connector search tool sends less', () => {
  const account = 'acct-shorter';
  const connToken = 'conn-token-shorter';
  let storage: InMemoryConnectorStorage;
  beforeEach(() => { storage = new InMemoryConnectorStorage(); });

  it('returns a long memory in part with the id that reads the rest, and fetch returns all of it', async () => {
    await seedEncryptedEntry(storage, account, connToken, { entryId: 'long-1', scope: 'conversations', type: 'episodic', content: longNote, createdAt: '2026-11-21T00:00:00.000Z' });
    await seedEncryptedEntry(storage, account, connToken, { entryId: 'short-1', scope: 'personal', type: 'semantic', content: 'Pat walks to the harbor office', createdAt: '2026-11-21T00:00:00.000Z' });
    const dek = await testAccountDek(storage, account, connToken);
    const server = createMcpServer(storage, account, dek);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'shorter-test', version: '0.0.0' });
    await client.connect(b);
    const call = async (name: string, args: Record<string, string>): Promise<string> =>
      ((await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }).content.map((part) => part.text).join('\n');

    const found = await call('memory_retrieve', { query: 'Pat car hatchback' });
    expect(found).toContain('blue hatchback');
    expect(found).toContain('read all of it with fetch, id long-1');
    expect(found).toContain('- [personal] Pat walks to the harbor office');
    expect(found).not.toContain('afterword199');
    // ADR 0092: the note is a fixed second block beside two or more memories; the memories themselves stay short.
    const [memories, note] = found.split('\nNorthKeep note ');
    expect(note).toBeDefined();
    expect(memories!.length).toBeLessThan(900);

    const listed = await call('memory_list', {});
    expect(listed).toContain('read all of it with fetch, id long-1');
    expect(listed).not.toContain('afterword199');

    expect(await call('fetch', { id: 'long-1' })).toContain('afterword199');
  });
});
