import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { createHarness, text, type Harness } from './harness-0060.js';

/**
 * ADR 0085: a save that repeats a memory is not stored twice, a save that
 * mostly repeats one is held until the app says "replaces" or "distinct",
 * and every row names the app that wrote it.
 */

let h: Harness;
const open: Client[] = [];
afterEach(async () => {
  for (const c of open.splice(0)) await c.close().catch(() => undefined);
  delete process.env.NORTHKEEP_SCOPES;
  delete process.env.NORTHKEEP_REDACT_TIER;
  await h.close();
});

async function app(name: string): Promise<Client> {
  const server = createServer(h.vaultPath);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name, version: '1.0' });
  await Promise.all([mcp.connect(ct), server.connect(st)]);
  open.push(mcp);
  return mcp;
}

interface Reply {
  isError: boolean;
  text: string;
  json: {
    stored?: { id: string; source: string; content: string; scope: string };
    already_saved?: boolean;
    replaced?: string;
    held?: boolean;
    saved?: boolean;
    next?: string;
    possible_updates?: Array<{ id: string; content: string }>;
  };
}

async function save(mcp: Client, args: Record<string, unknown>): Promise<Reply> {
  const r = await mcp.callTool({ name: 'memory_remember', arguments: { type: 'semantic', ...args } });
  const body = text(r);
  let json: Reply['json'] = {};
  try { json = JSON.parse(body) as Reply['json']; } catch { /* an error reply is plain text */ }
  return { isError: r.isError === true, text: body, json };
}

function rows(scope = 'personal'): Array<{ id: string; content: string; source: string; superseded_by: string | null; metadata: Record<string, unknown> | null }> {
  const vault = h.openVault();
  const all = vault.list({ scope, includeSuperseded: true });
  vault.close();
  return all;
}

const live = (scope = 'personal'): string[] => rows(scope).filter((r) => r.superseded_by === null).map((r) => r.content);

describe('the acceptance test: one fact, two apps, one live row', () => {
  it('saves once, holds the update, replaces on request, and search finds only the new fact', async () => {
    h = createHarness();
    const a = await app('app-alpha');
    const b = await app('app-beta');

    const first = await save(a, { content: 'The harbor office is at Pier 4.' });
    expect(first.json.stored?.source).toBe('mcp:app-alpha');

    const again = await save(a, { content: 'The harbor office is at Pier 4.' });
    expect(again.json.already_saved).toBe(true);
    expect(again.json.stored?.id).toBe(first.json.stored?.id);
    expect(rows()).toHaveLength(1);

    const update = await save(b, { content: 'The harbor office is now at Pier 9.' });
    expect(update.isError).toBe(false);
    expect(update.json.held).toBe(true);
    expect(update.json.saved).toBe(false);
    expect(update.json.possible_updates?.map((m) => m.id)).toEqual([first.json.stored?.id]);
    expect(update.json.next).toContain('replaces');
    expect(live()).toEqual(['The harbor office is at Pier 4.']);

    const replaced = await save(b, { content: 'The harbor office is now at Pier 9.', replaces: first.json.stored?.id });
    expect(replaced.json.stored?.source).toBe('mcp:app-beta');
    expect(live()).toEqual(['The harbor office is now at Pier 9.']);
    const old = rows().find((r) => r.id === first.json.stored?.id);
    expect(old?.superseded_by).toBe(replaced.json.stored?.id);

    const separate = await save(b, { content: 'The harbor office closes at five.', distinct: true });
    expect(separate.json.stored?.content).toBe('The harbor office closes at five.');
    expect(live()).toEqual(['The harbor office is now at Pier 9.', 'The harbor office closes at five.']);

    const found = text(await a.callTool({ name: 'memory_retrieve', arguments: { query: 'which pier is the harbor office at' } }));
    const hits = (JSON.parse(found) as { results: Array<{ content: string }> }).results.map((m) => m.content);
    expect(hits[0]).toBe('The harbor office is now at Pier 9.');
    expect(hits).not.toContain('The harbor office is at Pier 4.');
  });
});

describe('what counts as the same save', () => {
  it('ignores case, spacing and edge punctuation', async () => {
    h = createHarness();
    const a = await app('app-alpha');
    const first = await save(a, { content: 'The harbor office is at Pier 4.' });
    const again = await save(a, { content: '  the HARBOR office is at   pier 4' });
    expect(again.json.already_saved).toBe(true);
    expect(again.json.stored?.id).toBe(first.json.stored?.id);
    expect(rows()).toHaveLength(1);
  });

  it('returns the existing memory for an identical save even with distinct set', async () => {
    h = createHarness();
    const a = await app('app-alpha');
    const first = await save(a, { content: 'The harbor office is at Pier 4.' });
    const again = await save(a, { content: 'The harbor office is at Pier 4.', distinct: true });
    expect(again.json.stored?.id).toBe(first.json.stored?.id);
    expect(rows()).toHaveLength(1);
  });

  it('checks only the scope the save names', async () => {
    h = createHarness();
    const a = await app('app-alpha');
    await save(a, { content: 'The harbor office is at Pier 4.', scope: 'work' });
    const other = await save(a, { content: 'The harbor office is at Pier 4.', scope: 'personal' });
    expect(other.json.already_saved).toBeUndefined();
    expect(live('personal')).toEqual(['The harbor office is at Pier 4.']);
  });
});

describe('what is held and what is not', () => {
  it('saves a fact that shares one word with a memory', async () => {
    h = createHarness();
    const a = await app('app-alpha');
    await save(a, { content: 'My accountant is Leo Marsh.' });
    const next = await save(a, { content: 'My accountant is now Priya Shah.' });
    expect(next.json.held).toBeUndefined();
    expect(live()).toEqual(['My accountant is Leo Marsh.', 'My accountant is now Priya Shah.']);
  });

  it('does not let a short memory hold a longer new fact that repeats its words', async () => {
    h = createHarness();
    const a = await app('app-alpha');
    await save(a, { content: 'Pat Example, harbor director.' });
    const next = await save(a, { content: 'Pat Example, the harbor director, keeps the ferry ledger in the blue cabinet beside the chart room window.' });
    expect(next.json.held).toBeUndefined();
    expect(live()).toHaveLength(2);
  });

  it('never holds a save against a project document', async () => {
    h = createHarness();
    const a = await app('app-alpha');
    const made = await a.callTool({
      name: 'project_create',
      arguments: { project: 'harbor', title: 'Harbor office move', what_why: 'Move the harbor office from Pier 4 to Pier 9 before winter.', status: 'Planning the move.', draft: true },
    });
    expect(made.isError, text(made)).toBeFalsy();
    const note = await save(a, { content: 'Move the harbor office from Pier 4 to Pier 9.', scope: 'project:harbor' });
    expect(note.json.held).toBeUndefined();
    expect(note.json.stored?.scope).toBe('project:harbor');
  });

  it('lists at most three possible updates, closest first', async () => {
    h = createHarness();
    const a = await app('app-alpha');
    for (const n of [1, 2, 3, 4]) {
      await save(a, { content: `Ferry roster ${n}: harbor crew Monday Tuesday Wednesday.`, distinct: true });
    }
    const next = await save(a, { content: 'Ferry roster: harbor crew Monday Tuesday Wednesday.' });
    expect(next.json.held).toBe(true);
    expect(next.json.possible_updates).toHaveLength(3);
  });

  it('saves text with no Latin letters or digits unchecked', async () => {
    h = createHarness();
    const a = await app('app-alpha');
    await save(a, { content: '港口办公室在四号码头' });
    const next = await save(a, { content: '港口办公室在九号码头' });
    expect(next.json.held).toBeUndefined();
    expect(live()).toHaveLength(2);
  });
});

describe('replaces', () => {
  it('refuses a project document', async () => {
    h = createHarness();
    const a = await app('app-alpha');
    await a.callTool({ name: 'project_create', arguments: { project: 'harbor', title: 'Harbor office move', what_why: 'Move the office.', status: 'Planning the move.', draft: true } });
    const doc = rows('project:harbor')[0]!;
    const r = await save(a, { content: 'Harbor notes.', type: 'episodic', scope: 'project:harbor', replaces: doc.id });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('project document');
    expect(live('project:harbor')).toEqual([doc.content]);
  });

  it('answers already saved when the replacement is the same text in other casing', async () => {
    h = createHarness();
    const a = await app('app-alpha');
    const first = await save(a, { content: 'The harbor office is at Pier 4.' });
    const r = await save(a, { content: 'the harbor office is at PIER 4', replaces: first.json.stored?.id });
    expect(r.json.already_saved).toBe(true);
    expect(r.json.replaced).toBeUndefined();
    expect(r.json.stored?.id).toBe(first.json.stored?.id);
    expect(rows()).toHaveLength(1);
  });

  it('refuses a memory marked as a project archive', async () => {
    h = createHarness();
    const a = await app('app-alpha');
    const first = await save(a, { content: 'Decisions moved out of the harbor project.' });
    const vault = h.openVault();
    const archive = vault.markArchive(first.json.stored!.id);
    vault.save();
    vault.close();
    const r = await save(a, { content: 'Something else entirely.', replaces: archive.id });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('archive');
    expect(live()).toEqual(['Decisions moved out of the harbor project.']);
  });

  it('refuses when the scope named with the save is not the old memory\'s scope', async () => {
    h = createHarness();
    const a = await app('app-alpha');
    const first = await save(a, { content: 'The harbor office is at Pier 4.', scope: 'work' });
    const r = await save(a, { content: 'The harbor office is now at Pier 9.', scope: 'personal', replaces: first.json.stored?.id });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('"work" scope');
    expect(live('work')).toEqual(['The harbor office is at Pier 4.']);
    expect(live('personal')).toEqual([]);
  });

  it('keeps the old memory\'s scope when the save names none', async () => {
    h = createHarness();
    const a = await app('app-alpha');
    const first = await save(a, { content: 'The harbor office is at Pier 4.', scope: 'work' });
    const r = await save(a, { content: 'The harbor office is now at Pier 9.', replaces: first.json.stored?.id });
    expect(r.json.stored?.scope).toBe('work');
    expect(live('personal')).toEqual([]);
  });

  it('cannot reach a memory outside the connection\'s granted scopes', async () => {
    h = createHarness();
    const owner = await app('app-alpha');
    const first = await save(owner, { content: 'The harbor office is at Pier 4.', scope: 'work' });
    process.env.NORTHKEEP_SCOPES = 'personal';
    const narrow = await app('app-beta');
    const r = await save(narrow, { content: 'The harbor office is now at Pier 9.', replaces: first.json.stored?.id });
    expect(r.isError).toBe(true);
    expect(live('work')).toEqual(['The harbor office is at Pier 4.']);
  });

  it('drops the confirmed marker, since only the user vouches for text', async () => {
    h = createHarness();
    const a = await app('app-alpha');
    const first = await save(a, { content: 'The harbor office is at Pier 4.' });
    const vault = h.openVault();
    const confirmed = vault.confirmMemory(first.json.stored!.id);
    vault.save();
    vault.close();
    const r = await save(a, { content: 'The harbor office is now at Pier 9.', replaces: confirmed.id });
    const row = rows().find((x) => x.id === r.json.stored?.id);
    expect(row?.metadata ?? null).toBeNull();
  });
});

describe('the app name on a row', () => {
  it('an edit carries the editing app\'s name, not the first writer\'s', async () => {
    h = createHarness();
    const a = await app('app-alpha');
    const b = await app('app-beta');
    const first = await save(a, { content: 'The harbor office is at Pier 4.' });
    const edited = await b.callTool({ name: 'memory_edit', arguments: { id: first.json.stored?.id, content: 'The harbor office is at Pier 9.' } });
    expect((JSON.parse(text(edited)) as { edited: { source: string } }).edited.source).toBe('mcp:app-beta');
  });

  it('tames a hostile name to one printable line', async () => {
    h = createHarness();
    const a = await app(`evil\n‮name${'x'.repeat(200)}`);
    const first = await save(a, { content: 'The harbor office is at Pier 4.' });
    const source = first.json.stored!.source;
    expect(source.startsWith('mcp:evil')).toBe(true);
    expect(source).not.toMatch(/[\n‮]/);
    expect(source.length).toBeLessThanOrEqual(84);
  });
});

describe('a hold while returned text is masked', () => {
  it('offers distinct only at Tier 1, and refuses a replace', async () => {
    h = createHarness();
    const a = await app('app-alpha');
    const first = await save(a, { content: 'The harbor office is at Pier 4.' });
    process.env.NORTHKEEP_REDACT_TIER = '1';
    const held = await save(a, { content: 'The harbor office is now at Pier 9.' });
    expect(held.json.held).toBe(true);
    expect(held.json.next).toContain('distinct');
    expect(held.json.next).toContain('not available');
    const r = await save(a, { content: 'The harbor office is now at Pier 9.', replaces: first.json.stored?.id });
    expect(r.isError).toBe(true);
    expect(live()).toEqual(['The harbor office is at Pier 4.']);
  });
});
