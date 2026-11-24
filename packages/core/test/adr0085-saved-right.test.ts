import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, generateDeviceSecret } from '../src/crypto.js';
import { checkSave, saveNormalForm } from '../src/search-rules.js';
import { Vault } from '../src/vault.js';

// ADR 0085. Every fact here is fictional.

const rows = (...contents: string[]): Array<{ content: string }> => contents.map((content) => ({ content }));
const held = (save: string, ...memories: string[]): string[] => checkSave(save, rows(...memories)).held.map((row) => row.content);

describe('ADR 0085 D3: the save check', () => {
  it('compares text without case, spacing or punctuation at word edges', () => {
    expect(saveNormalForm('  "The HARBOR   office," is at Pier 4. ')).toBe('the harbor office is at pier 4');
    expect(saveNormalForm("Pat's e-mail")).toBe("pat's e-mail");
    expect(saveNormalForm('!!!')).toBe('');
  });

  it('calls a save identical only when some text is left to compare', () => {
    expect(checkSave('The harbor office is at Pier 4', rows('the harbor office is at pier 4.')).identical).toEqual({ content: 'the harbor office is at pier 4.' });
    expect(checkSave('!!!', rows('???')).identical).toBeNull();
  });

  it('holds an update that repeats the old fact and adds one word', () => {
    expect(held('The harbor office is now at Pier 9.', 'The harbor office is at Pier 4.')).toEqual(['The harbor office is at Pier 4.']);
  });

  it('holds nothing on one shared word, however rare', () => {
    expect(held('My accountant is now Priya Shah', 'My accountant is Leo Marsh')).toEqual([]);
    expect(held('Rent is $2,450', 'Rent is $2,300')).toEqual([]);
  });

  it('measures the save only, so a short memory does not hold a longer fact', () => {
    const long = 'Pat Example, the harbor director, keeps the ferry ledger in the blue cabinet beside the chart room window';
    expect(held(long, 'Pat Example, harbor director')).toEqual([]);
    expect(held('Pat Example, harbor director', long)).toEqual([long]);
  });

  it('weighs a word no memory holds above a word many hold', () => {
    const crowd = Array.from({ length: 30 }, (_, n) => `Harbor office note ${n + 100}`);
    // Two shared words that every memory holds carry little; the three new words carry the save.
    expect(held('Harbor office gets a green awning in spring', ...crowd)).toEqual([]);
  });

  it('holds nothing when the save has no words to weigh or nothing is stored', () => {
    expect(held('港口办公室在九号码头', '港口办公室在四号码头')).toEqual([]);
    expect(held('is it the')).toEqual([]);
    expect(held('The harbor office is at Pier 4')).toEqual([]);
  });

  it('lists three at most, closest first', () => {
    const found = held(
      'Ferry roster: harbor crew Monday Tuesday Wednesday',
      'Ferry roster: harbor crew Monday Tuesday',
      'Ferry roster: harbor crew Monday Tuesday Wednesday Thursday',
      'Ferry roster: harbor crew Monday',
      'Ferry roster: harbor crew Monday Tuesday Wednesday Friday',
    );
    expect(found).toHaveLength(3);
    expect(found).not.toContain('Ferry roster: harbor crew Monday');
  });
});

describe('ADR 0085: replace primitives in the vault', () => {
  let dir: string;
  let vault: Vault;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-0085-'));
    vault = Vault.create({ path: path.join(dir, 'vault.nkv'), passphrase: 'a strong test passphrase', deviceSecret: generateDeviceSecret(), kdf: KDF_INTERACTIVE });
  });
  afterEach(() => {
    vault.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('an app\'s edit names that app; the owner\'s edit keeps the first writer', () => {
    const first = vault.remember({ content: 'The harbor office is at Pier 4', type: 'semantic', source: 'mcp:app-alpha', sourceModel: 'mcp-client' });
    const byApp = vault.editMemory(first.id, { content: 'The harbor office is at Pier 9' }, { actor: 'agent', source: 'mcp:app-beta', sourceModel: 'mcp-client' });
    expect(byApp.source).toBe('mcp:app-beta');
    const byOwner = vault.editMemory(byApp.id, { content: 'The harbor office is at Pier 10' }, { actor: 'owner', source: 'ignored' });
    expect(byOwner.source).toBe('mcp:app-beta');
    expect(vault.verifyChain().ok).toBe(true);
  });

  it('markReplaced links two existing memories and leaves one live', () => {
    const old = vault.remember({ content: 'The harbor office is at Pier 4', type: 'semantic' });
    const next = vault.remember({ content: 'The harbor office is at Pier 9', type: 'semantic' });
    const marked = vault.markReplaced(old.id, next.id);
    expect(marked.superseded_by).toBe(next.id);
    expect(marked.superseded_at).toBe(vault.list({ includeSuperseded: true }).find((row) => row.id === old.id)?.superseded_at);
    expect(marked.superseded_at).not.toBeNull();
    expect(vault.list().map((row) => row.content)).toEqual(['The harbor office is at Pier 9']);
    expect(vault.list({ includeSuperseded: true }).find((row) => row.id === old.id)?.superseded_by).toBe(next.id);
    expect(vault.verifyChain().ok).toBe(true);
  });

  it('markReplaced refuses another scope, itself, and a memory already replaced', () => {
    const old = vault.remember({ content: 'The harbor office is at Pier 4', type: 'semantic', scope: 'work' });
    const next = vault.remember({ content: 'The harbor office is at Pier 9', type: 'semantic', scope: 'personal' });
    expect(() => vault.markReplaced(old.id, next.id)).toThrow('its own scope');
    expect(() => vault.markReplaced(old.id, old.id)).toThrow('cannot replace itself');
    const same = vault.remember({ content: 'The harbor office is at Pier 9', type: 'semantic', scope: 'work' });
    vault.markReplaced(old.id, same.id);
    expect(() => vault.markReplaced(old.id, same.id)).toThrow('No memory found');
  });
});
