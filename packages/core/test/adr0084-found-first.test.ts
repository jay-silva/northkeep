import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KDF_INTERACTIVE, generateDeviceSecret } from '../src/crypto.js';
import type { Embedder } from '../src/types.js';
import { Vault } from '../src/vault.js';
import { SEARCH_STOPWORDS, isConfirmed, rareTerms } from '../src/search-rules.js';
import { PROJECT_LOG_ARCHIVE_HEADING } from '../src/project-doc.js';

// ADR 0084 fixtures. Every fact here is fictional.

let dir: string;
let vault: Vault;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-0084-'));
  vault = Vault.create({ path: path.join(dir, 'vault.nkv'), passphrase: 'a strong test passphrase', deviceSecret: generateDeviceSecret(), kdf: KDF_INTERACTIVE });
});

afterEach(() => {
  vault.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const confirmedMeta = { confirmed: { by: 'user', at: '2026-11-21T00:00:00.000Z' } };

function contents(results: Array<{ entry: { content: string } }>): string[] {
  return results.map((r) => r.entry.content);
}

/** An embedder that is down, so retrieveSemantic shows the keyword path. */
const downEmbedder: Embedder = { model: 'down', async embed() { throw new Error('offline'); } };

/** Every text gets the same vector, so semantic ranking adds the same amount to each row. */
const flatEmbedder: Embedder = { model: 'flat', async embed() { return [1, 0, 0]; } };

describe('ADR 0084 D5: a keyword match needs a word that is not a stopword', () => {
  it('a confirmed memory sharing only "the" with the query does not appear, by keyword or by meaning', async () => {
    vault.remember({ content: 'Jay prefers the window seat on flights', type: 'procedural', metadata: confirmedMeta });
    vault.remember({ content: 'Pat Example is the harbor office director', type: 'semantic' });
    expect(contents(vault.retrieve('who runs the harbor office'))).toEqual(['Pat Example is the harbor office director']);
    const orthogonal: Embedder = { model: 'orth', async embed(t) { return t.includes('window') ? [0, 1, 0] : [1, 0, 0]; } };
    const r = await vault.retrieveSemantic('who runs the harbor office', orthogonal);
    expect(r.mode).toBe('semantic');
    expect(contents(r.results)).toEqual(['Pat Example is the harbor office director']);
  });

  it('a query made only of stopwords finds nothing', () => {
    vault.remember({ content: 'Who is the one that was here', type: 'semantic' });
    expect(vault.retrieve('who is the')).toEqual([]);
  });

  it('names a stopword list with the common words and none of the content words in these fixtures', () => {
    for (const w of ['the', 'who', 'is', 'my', 'what']) expect(SEARCH_STOPWORDS.has(w)).toBe(true);
    for (const w of ['harbor', 'office', 'dog', 'runs', 'birthday']) expect(SEARCH_STOPWORDS.has(w)).toBe(false);
  });
});

describe('ADR 0084 D4: confirmed memories rank first', () => {
  it('a confirmed answer outranks a newer agent-written near-copy, by keyword and by meaning', async () => {
    vault.remember({ content: 'Pat Example is the harbor office director', type: 'semantic', metadata: confirmedMeta });
    vault.remember({ content: 'Pat Example was the harbor office director last year', type: 'episodic', source: 'mcp' });
    expect(contents(vault.retrieve('harbor office director'))[0]).toBe('Pat Example is the harbor office director');
    const r = await vault.retrieveSemantic('harbor office director', flatEmbedder);
    expect(contents(r.results)[0]).toBe('Pat Example is the harbor office director');
  });

  it('confirmMemory adds the marker on a new row and keeps the content', () => {
    const m = vault.remember({ content: 'Pat Example is the harbor office director', type: 'semantic' });
    const c = vault.confirmMemory(m.id);
    expect(c.id).not.toBe(m.id);
    expect(c.content).toBe(m.content);
    expect(isConfirmed(c.metadata)).toBe(true);
    expect(vault.confirmMemory(c.id).id).toBe(c.id);
  });

  it('an agent edit drops the marker; an owner edit keeps it', () => {
    const m = vault.remember({ content: 'Pat Example is the harbor office director', type: 'semantic', metadata: confirmedMeta });
    const byOwner = vault.editMemory(m.id, { content: 'Pat Example is the harbor office director since 2019' }, { actor: 'owner' });
    expect(isConfirmed(byOwner.metadata)).toBe(true);
    const byAgent = vault.editMemory(byOwner.id, { content: 'Pat Example is the harbor office director, now part time' }, { actor: 'agent' });
    expect(isConfirmed(byAgent.metadata)).toBe(false);
    expect(byAgent.metadata).toBeNull();
  });
});

describe('ADR 0084 D3: search skips project paperwork', () => {
  it('skips a live project document, a log archive and a marked archive, and keeps other project facts', async () => {
    vault.updateProject({ project: 'harbor', expected_revision: null, what_why: 'Harbor office move.', status: 'Harbor office packing.', log_entry: 'Created.' }, { actor: 'owner' });
    vault.remember({ content: `${PROJECT_LOG_ARCHIVE_HEADING}: harbor office entries`, type: 'episodic', scope: 'project:harbor' });
    const moved = vault.remember({ content: 'Decisions archive: harbor office lease signed', type: 'episodic', scope: 'project:harbor' });
    vault.markArchive(moved.id);
    vault.remember({ content: 'The harbor office movers come on Friday', type: 'semantic', scope: 'project:harbor' });
    const opts = { skipProjectPaperwork: true };
    expect(contents(vault.retrieve('harbor office', opts))).toEqual(['The harbor office movers come on Friday']);
    expect(contents((await vault.retrieveSemantic('harbor office', flatEmbedder, opts)).results)).toEqual(['The harbor office movers come on Friday']);
    expect(contents((await vault.retrieveSemantic('harbor office', downEmbedder, opts)).results)).toEqual(['The harbor office movers come on Friday']);
    // Without the option (converse and other callers) nothing changes.
    expect(vault.retrieve('harbor office').length).toBe(4);
  });
});

describe('ADR 0084 baseline fixtures', () => {
  it('a long unrelated row does not outrank a short exact answer', () => {
    const filler = Array.from({ length: 400 }, (_, i) => `line ${i} about the harbor schedule, office supplies, staff names and directors meeting notes`).join('\n');
    // The answer is older, so recency favours the long row.
    vault.remember({ content: 'Pat Example is the harbor office director', type: 'semantic' });
    vault.remember({ content: filler, type: 'semantic', scope: 'conversations' });
    // The long row matches every query word, the answer all but "name".
    expect(contents(vault.retrieve('what is the name of the harbor office director'))[0]).toBe('Pat Example is the harbor office director');
  });

  it('an answer split across two short memories comes back whole within the default limit, even when a project is named after the word', () => {
    vault.updateProject({ project: 'beagles-game', expected_revision: null, what_why: 'A game about beagles.', status: 'Beagles everywhere.', log_entry: 'Created.' }, { actor: 'owner' });
    for (let i = 0; i < 12; i += 1) vault.remember({ content: `Beagles game build ${i} shipped with new beagle art`, type: 'episodic', scope: 'project:beagles-game' });
    vault.remember({ content: 'Jay has a beagle named Biscuit born in 2021', type: 'semantic' });
    vault.remember({ content: 'Jay has a second beagle named Pepper born in 2026', type: 'semantic' });
    const found = contents(vault.retrieve('what are the names of my beagles dogs', { skipProjectPaperwork: true }));
    expect(found).toContain('Jay has a beagle named Biscuit born in 2021');
    expect(found).toContain('Jay has a second beagle named Pepper born in 2026');
  });
});

describe('ADR 0084 D8: old AI session notes rank below other matches', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('lists a three-month-old agent note after a weaker fact, keeps a recent note in score order, and spares a confirmed one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-20T12:00:00.000Z'));
    vault.remember({ content: 'Session note: the half share of Example Holdings belongs to Alpha LLC', type: 'episodic', scope: 'conversations', source: 'mcp' });
    vault.remember({ content: 'Old checked note: Example Holdings half share is disputed', type: 'episodic', scope: 'conversations', source: 'mcp', metadata: confirmedMeta });
    vi.setSystemTime(new Date('2026-11-21T12:00:00.000Z'));
    vault.remember({ content: 'Example Holdings is a rental company', type: 'semantic', source: 'cli' });
    vault.remember({ content: 'Session note today: Example Holdings half share talk', type: 'episodic', scope: 'conversations', source: 'mcp:claude-code' });
    const order = contents(vault.retrieve('Example Holdings half share'));
    expect(order.at(-1)).toBe('Session note: the half share of Example Holdings belongs to Alpha LLC');
    expect(order.indexOf('Example Holdings is a rental company')).toBeLessThan(order.length - 1);
    const sem = contents((await vault.retrieveSemantic('Example Holdings half share', flatEmbedder)).results);
    expect(sem.at(-1)).toBe('Session note: the half share of Example Holdings belongs to Alpha LLC');
    expect(order).toContain('Old checked note: Example Holdings half share is disputed');
  });
});

describe('ADR 0087: a memory that matches only a common word is listed after one that matches a rarer word', () => {
  /** Twelve confirmed facts that name Pat, twelve rows that do not, and the one answer. */
  function seedPat(): void {
    vault.remember({ content: "Pat's car is a blue hatchback", type: 'semantic', source: 'mcp' });
    for (let i = 0; i < 12; i += 1) vault.remember({ content: `Pat keeps ledger ${i} in the harbor office`, type: 'identity', metadata: confirmedMeta });
    for (let i = 0; i < 12; i += 1) vault.remember({ content: `Tide table ${i} is pinned by the door`, type: 'semantic' });
  }
  const isLedger = (text: string): boolean => text.includes('ledger');

  it('a query that includes the name lists the answer first, by keyword and by meaning', async () => {
    seedPat();
    const byWord = contents(vault.retrieve('car vehicle Pat drives'));
    expect(byWord[0]).toBe("Pat's car is a blue hatchback");
    expect(byWord.slice(1).every(isLedger)).toBe(true);
    // The ledgers are only loosely like the question: here for the name, not the meaning.
    const loose: Embedder = { model: 'loose', async embed(t) { return /car|hatchback/.test(t) ? [1, 0, 0] : t.includes('ledger') ? [0.5, 0.87, 0] : [0, 1, 0]; } };
    const r = await vault.retrieveSemantic('car vehicle Pat drives', loose);
    expect(r.mode).toBe('semantic');
    expect(contents(r.results)[0]).toBe("Pat's car is a blue hatchback");
    expect(contents(r.results).slice(1).every(isLedger)).toBe(true);
  });

  it('keeps the name\'s memories when another row holds the rarer word', () => {
    seedPat();
    vault.remember({ content: "Robin's employer is Southcoast Marine", type: 'semantic' });
    const found = contents(vault.retrieve('Pat employer'));
    expect(found[0]).toBe("Robin's employer is Southcoast Marine");
    expect(found.length).toBe(8);
    expect(found.slice(1).every(isLedger)).toBe(true);
  });

  it('the name still counts when it is the only word, or the only word that matches anything', () => {
    seedPat();
    for (const query of ['Pat', 'Pat birthday']) {
      const found = vault.retrieve(query);
      expect(found.length, query).toBe(8);
      expect(isConfirmed(found[0].entry.metadata), query).toBe(true);
    }
  });

  it('measures commonness on the whole vault, so a scope filter does not bring the crowding back', () => {
    seedPat();
    vault.remember({ content: 'The spare car key hangs by the door', type: 'semantic', scope: 'garage' });
    for (let i = 0; i < 9; i += 1) vault.remember({ content: `Pat parks trailer ${i} in the garage`, type: 'identity', scope: 'garage', metadata: confirmedMeta });
    const found = contents(vault.retrieve('Pat car', { scope: 'garage' }));
    expect(found[0]).toBe('The spare car key hangs by the door');
    expect(found.length).toBe(8);
  });

  it('an old AI session note that matches a rarer word is listed before fresh rows that match only the name', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-08-01T12:00:00.000Z'));
      vault.remember({ content: 'Session note: Pat asked about the ferry timetable', type: 'episodic', scope: 'conversations', source: 'mcp' });
      vi.setSystemTime(new Date('2026-11-21T12:00:00.000Z'));
      seedPat();
      expect(contents(vault.retrieve('Pat ferry timetable'))[0]).toBe('Session note: Pat asked about the ferry timetable');
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats no word as common in a small vault, and a word in over a tenth of a larger one as common', () => {
    const rows = (n: number, withPat: number) => Array.from({ length: n }, (_, i) => new Set(i < withPat ? ['pat', `w${i}`] : [`w${i}`]));
    expect([...rareTerms(new Set(['pat', 'car']), rows(19, 19))]).toEqual(['pat', 'car']);
    expect([...rareTerms(new Set(['pat', 'car']), rows(20, 3))]).toEqual(['car']);
    expect([...rareTerms(new Set(['pat', 'car']), rows(20, 2))]).toEqual(['pat', 'car']);
    expect([...rareTerms(new Set(['pat']), rows(20, 20))]).toEqual([]);
  });
});
