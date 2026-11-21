import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, FOUND_FIRST_INSTRUCTION, MILESTONE_INSTRUCTION } from '../src/mcp.js';
import { InMemoryConnectorStorage } from '../src/storage.js';
import { decryptRow, encryptRow } from '../src/crypto.js';
import { seedEncryptedEntry, testAccountDek } from './helpers.js';
import {
  FOUND_FIRST_INSTRUCTION as LOCAL_FOUND_FIRST,
  MILESTONE_INSTRUCTION as LOCAL_MILESTONE,
  SERVER_INSTRUCTIONS as LOCAL_SERVER_INSTRUCTIONS,
} from '../../../packages/mcp-server/src/project-recipe.js';

// ADR 0084 on the hosted connector. Every fact here is fictional.

const here = path.dirname(fileURLToPath(import.meta.url));
const account = 'acct-adr0084';
const connToken = 'conn-token-adr0084';
let storage: InMemoryConnectorStorage;

beforeEach(() => {
  storage = new InMemoryConnectorStorage();
});

async function client(): Promise<Client> {
  const dek = await testAccountDek(storage, account, connToken);
  const server = createMcpServer(storage, account, dek);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: 'adr0084-test', version: '0.0.0' });
  await c.connect(b);
  return c;
}

async function retrieve(tool: 'memory_retrieve' | 'search', query: string): Promise<string> {
  const res = (await (await client()).callTool({ name: tool, arguments: { query } })) as { content: Array<{ text: string }> };
  return res.content.map((c) => c.text).join('\n');
}

let n = 0;
async function seed(scope: string, type: string, content: string, flags: { confirmed?: boolean; archive?: boolean } = {}): Promise<void> {
  n += 1;
  await seedEncryptedEntry(storage, account, connToken, { entryId: `e${n}`, scope, type, content, createdAt: '2026-11-21T00:00:00.000Z', ...flags });
}

describe('ADR 0084 D1: one wording on both servers', () => {
  it('the connector sends the same instructions as the local server', async () => {
    expect(FOUND_FIRST_INSTRUCTION).toBe(LOCAL_FOUND_FIRST);
    expect(MILESTONE_INSTRUCTION).toBe(LOCAL_MILESTONE);
    expect((await client()).getInstructions()).toBe(LOCAL_SERVER_INSTRUCTIONS);
  });

  it('the stopword list and search rules match the device copy', () => {
    const read = (p: string): string => fs.readFileSync(path.join(here, p), 'utf8');
    const words = (src: string): string => src.slice(src.indexOf('export const SEARCH_STOPWORDS'), src.indexOf('/** Metadata key') > 0 ? src.indexOf('/** Metadata key') : src.indexOf('/** How much a confirmed'));
    const device = read('../../../packages/core/src/search-rules.ts');
    const hosted = read('../src/search-rules.ts');
    expect(words(hosted)).toBe(words(device));
  });
});

describe('ADR 0084 D3 and D5 on the connector', () => {
  it('skips project documents and archives, and matches whole words only', async () => {
    await seed('project:harbor', 'working', '## What & Why\n\nHarbor office move.');
    await seed('project:harbor', 'episodic', 'Decisions archive: harbor office lease', { archive: true });
    await seed('personal', 'semantic', 'The harbor office movers come on Friday');
    await seed('personal', 'semantic', 'Harborview Diner is open late');
    for (const tool of ['memory_retrieve', 'search'] as const) {
      const out = await retrieve(tool, 'harbor office');
      expect(out).toContain('movers come on Friday');
      expect(out).not.toContain('Harbor office move.');
      expect(out).not.toContain('lease');
      expect(out).not.toContain('Harborview');
    }
  });

  it('a query of stopwords alone finds nothing', async () => {
    await seed('personal', 'semantic', 'Who is the one that was here');
    expect(await retrieve('memory_retrieve', 'who is the')).not.toContain('Who is the one');
  });
});

describe('ADR 0084 D6: the confirmed flag rides inside the ciphertext', () => {
  it('round-trips through encryptRow and is not visible in the stored row', async () => {
    const dek = await testAccountDek(storage, account, connToken);
    const stored = await encryptRow({ accountHash: account, type: 'semantic', content: 'x', confirmed: true }, dek);
    expect(stored).not.toContain('confirmed');
    expect(await decryptRow(stored, account, dek)).toEqual({ type: 'semantic', content: 'x', confirmed: true });
    const plain = await encryptRow({ accountHash: account, type: 'semantic', content: 'x' }, dek);
    expect(await decryptRow(plain, account, dek)).toEqual({ type: 'semantic', content: 'x' });
  });

  it('ranks a confirmed memory above an unconfirmed near-copy', async () => {
    await seed('personal', 'episodic', 'Pat Example was the harbor office director last year');
    await seed('personal', 'semantic', 'Pat Example is the harbor office director', { confirmed: true });
    const out = await retrieve('memory_retrieve', 'harbor office director');
    expect(out.indexOf('is the harbor office director')).toBeLessThan(out.indexOf('was the harbor office director'));
  });
});
