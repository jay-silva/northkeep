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
  it('compares the same characters, give or take outer whitespace and one closing full stop', () => {
    expect(saveNormalForm('  The harbor office is at Pier 4. \n')).toBe('The harbor office is at Pier 4');
    expect(saveNormalForm('Steps:\r\n  1. Open the gate')).toBe('Steps:\n  1. Open the gate');
    expect(saveNormalForm('and so on...')).toBe('and so on...');
    expect(saveNormalForm('.')).toBe('');
  });

  it('never calls two saves identical when a sign or symbol differs', () => {
    const pairs: Array<[string, string]> = [
      ['Morgan blood type is O+.', 'Morgan blood type is O-.'],
      ['Account balance is -500 dollars.', 'Account balance is 500 dollars.'],
      ['Rent is $1,450 a month.', 'Rent is €1,450 a month.'],
      ['Keep the dose < 5 mg.', 'Keep the dose > 5 mg.'],
      ['Loan rate is 3.5 percent.', 'Loan rate is 3-5 percent.'],
      ['The deposit was paid: ✅', 'The deposit was paid: ❌'],
      ['Grade A+', 'Grade A-'],
      ['Morgan takes vitamin A daily.', 'Morgan takes vitamin daily.'],
      ['The fee is 10%', 'The fee is 10'],
      ['Version 2', 'Version ²'],
      ['Balance is (500).', 'Balance is 500.'],
      ['Pat owes [nothing]', 'Pat owes nothing'],
      ["Board is 6' long", 'Board is 6" long'],
      ["Ceiling is 8'", 'Ceiling is 8'],
      ['Answer is 5!', 'Answer is 5'],
      ['Due June 3?', 'Due June 3.'],
      ['The wifi password is HarborLight42', 'The wifi password is harborlight42'],
      ['The pump draws 10 mW', 'The pump draws 10 MW'],
      ['The link is 500 Mb', 'The link is 500 MB'],
      ['Docs live at example.test/Harbor', 'Docs live at example.test/harbor'],
      ['Steps:\n  check the gate\n  log it', 'Steps:\ncheck the gate\nlog it'],
      ['Pat is allergic to nuts?', 'Pat is allergic to nuts.'],
      ['The harbor  office', 'The harbor office'],
    ];
    for (const [first, second] of pairs) {
      expect(checkSave(second, rows(first)).identical, `${first} / ${second}`).toBeNull();
    }
  });

  it('calls a save identical for the same text with outer whitespace or one closing full stop', () => {
    expect(checkSave('The harbor office is at Pier 4', rows('The harbor office is at Pier 4.')).identical).not.toBeNull();
    expect(checkSave('  Rent is $1,450 a month.\n', rows('Rent is $1,450 a month')).identical).not.toBeNull();
  });

  it('a save that differs only by case is held for the app to decide, never called identical', () => {
    const check = checkSave('the harbor office is at pier 4', rows('The harbor office is at Pier 4.'));
    expect(check.identical).toBeNull();
    expect(check.held).toEqual([{ content: 'The harbor office is at Pier 4.' }]);
  });

  it('calls a save identical only when some text is left to compare', () => {
    expect(checkSave('The harbor office is at Pier 4', rows('The harbor office is at Pier 4.')).identical).toEqual({ content: 'The harbor office is at Pier 4.' });
    expect(checkSave('.', rows('.')).identical).toBeNull();
    expect(checkSave('  ', rows('')).identical).toBeNull();
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
