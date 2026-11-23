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
import * as hostedRules from '../src/search-rules.js';
import * as deviceRules from '../../../packages/core/src/search-rules.js';
import { PROJECT_LOG_ARCHIVE_HEADING } from '../src/project-doc.js';
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

  it('the stopword list, word rules, boost and paperwork rule match the device copy', () => {
    const read = (p: string): string => fs.readFileSync(path.join(here, p), 'utf8');
    // Source from the stopword list through lengthPenalty, which both files share verbatim.
    const shared = (src: string): string => {
      const start = src.indexOf('export const SEARCH_STOPWORDS');
      const end = src.indexOf('}\n', src.indexOf('export function lengthPenalty')) + 2;
      return src.slice(start, end);
    };
    const device = read('../../../packages/core/src/search-rules.ts');
    expect(shared(read('../src/search-rules.ts'))).toBe(shared(device));
    expect(hostedRules.CONFIRMED_BOOST).toBe(deviceRules.CONFIRMED_BOOST);
    const rows = [
      { type: 'working', scope: 'project:harbor', content: 'doc' },
      { type: 'episodic', scope: 'project:harbor', content: `${PROJECT_LOG_ARCHIVE_HEADING}: old entries` },
      { type: 'episodic', scope: 'project:harbor', content: 'Decisions moved out', archive: true },
      { type: 'semantic', scope: 'project:harbor', content: 'The movers come Friday' },
      { type: 'working', scope: 'personal', content: 'Current context' },
    ];
    for (const row of rows) {
      const metadata = row.archive ? { archive: { by: 'user', at: 'x' } } : null;
      expect(hostedRules.isProjectPaperwork(row)).toBe(deviceRules.isProjectPaperwork({ ...row, metadata }));
    }
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

describe('ADR 0087 on the connector: a memory that matches only a common word is listed after one that matches a rarer word', () => {
  async function seedPat(): Promise<void> {
    await seed('personal', 'semantic', 'The car is a blue hatchback');
    for (let i = 0; i < 24; i += 1) await seed('personal', 'identity', `Pat keeps ledger ${i} in the harbor office`, { confirmed: true });
    for (let i = 0; i < 24; i += 1) await seed('personal', 'semantic', `Tide table ${i} is pinned by the door`);
  }

  it('a query that includes the name lists the answer first on both search tools', async () => {
    await seedPat();
    for (const tool of ['memory_retrieve', 'search'] as const) {
      const out = await retrieve(tool, 'car Pat');
      expect(out.indexOf('blue hatchback'), tool).toBeGreaterThan(-1);
      expect(out.indexOf('blue hatchback'), tool).toBeLessThan(out.indexOf('ledger'));
    }
  });

  it('keeps the name\'s memories when another row holds the rarer word, or no row does', async () => {
    await seedPat();
    await seed('personal', 'semantic', "Robin's employer is Southcoast Marine");
    const out = await retrieve('memory_retrieve', 'Pat employer');
    expect(out.indexOf('Southcoast Marine')).toBeGreaterThan(-1);
    expect(out.indexOf('Southcoast Marine')).toBeLessThan(out.indexOf('ledger'));
    expect(await retrieve('memory_retrieve', 'Pat')).toContain('ledger');
    expect(await retrieve('search', 'Pat birthday')).toContain('ledger');
  });

  it('a scope name on few rows counts as a rarer match even when the word is common in memory text', async () => {
    for (let i = 0; i < 24; i += 1) await seed('personal', 'semantic', `Harbor note ${i} about the pier`);
    await seed('project:harbor', 'semantic', 'The crew meets on Friday');
    const out = await retrieve('memory_retrieve', 'harbor');
    expect(out.indexOf('crew meets on Friday')).toBeGreaterThan(-1);
    expect(out.indexOf('crew meets on Friday')).toBeLessThan(out.indexOf('Harbor note'));
  });

  it('a scope name on most rows does not: "personal" in the query cannot bring the crowding back', async () => {
    await seedPat();
    const out = await retrieve('memory_retrieve', 'Pat personal car');
    expect(out.indexOf('blue hatchback')).toBeGreaterThan(-1);
    expect(out.indexOf('blue hatchback')).toBeLessThan(out.indexOf('ledger'));
  });

  it('the rule is the device copy, run on the same rows', () => {
    const rows = Array.from({ length: 20 }, (_, i) => new Set(i < 3 ? ['pat', `w${i}`] : [`w${i}`]));
    const query = new Set(['pat', 'car']);
    expect([...hostedRules.rareTerms(query, rows)]).toEqual([...deviceRules.rareTerms(query, rows)]);
    expect([...hostedRules.rareTerms(query, rows)]).toEqual(['car']);
  });
});
