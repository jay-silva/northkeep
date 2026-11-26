import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClearReplacedError, KDF_INTERACTIVE, Vault, flatLine, generateDeviceSecret } from '../src/index.js';

/**
 * ADR 0095 D5 and section 3: the undo of a replace, and the one-line form of
 * text an AI app may have written. Temp files and fictional data only.
 */

const OP1 = '11111111-1111-4111-8111-111111111111';
const OP2 = '22222222-2222-4222-8222-222222222222';
let dir = '';
let vault: Vault;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-clear-replaced-'));
  vault = Vault.create({ path: path.join(dir, 'vault.nkv'), passphrase: 'synthetic passphrase', deviceSecret: generateDeviceSecret(), kdf: KDF_INTERACTIVE });
});
afterEach(() => {
  vault.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const add = (content: string, scope = 'harbor') => vault.remember({ content, type: 'semantic', scope });
const row = (id: string) => vault.list({ includeSuperseded: true, includeForgotten: true }).find((e) => e.id === id)!;
const live = () => vault.list().map((e) => e.content);
const refusal = (fn: () => unknown): [boolean, string] => {
  try {
    fn();
    return [false, 'cleared'];
  } catch (err) {
    return [err instanceof ClearReplacedError, (err as Error).message];
  }
};

describe('clearReplaced', () => {
  it('undoes a replace: the old memory is live again, the mark is gone and the chain still verifies', () => {
    const a = add('The harbor office is at Pier 4.');
    const b = add('The harbor office is now at Pier 9.');
    vault.markReplaced(a.id, b.id);
    expect(live()).toEqual(['The harbor office is now at Pier 9.']);

    const cleared = vault.clearReplaced(a.id, b.id);

    expect([cleared.superseded_at, cleared.superseded_by]).toEqual([null, null]);
    expect([row(a.id).superseded_at, row(a.id).superseded_by]).toEqual([null, null]);
    expect(live()).toEqual(['The harbor office is at Pier 4.', 'The harbor office is now at Pier 9.']);
    expect(vault.verifyChain()).toEqual({ ok: true });
  });

  it('refuses when the memory is replaced by a different one than expected', () => {
    const a = add('A');
    const b = add('B');
    const c = add('C');
    vault.markReplaced(a.id, b.id);
    expect(refusal(() => vault.clearReplaced(a.id, c.id))).toEqual([true, "This can't be undone here: it was changed since."]);
    expect(row(a.id).superseded_by).toBe(b.id);
  });

  it('refuses when the old memory is not replaced at all', () => {
    const a = add('A');
    const b = add('B');
    expect(refusal(() => vault.clearReplaced(a.id, b.id))).toEqual([true, "This can't be undone here: it was changed since."]);
  });

  it('refuses a source of a consolidation, and the consolidation can still be restored', () => {
    const a = add('First exact source', 'personal');
    const b = add('Second exact source', 'personal');
    const combined = vault.consolidateMemories({ vault_id: vault.getVaultId(), operation_id: OP1, sources: [a, b], content: 'Combined exact text.' });

    expect(refusal(() => vault.clearReplaced(a.id, combined.result.id))).toEqual([true, "This can't be undone here: it was combined with other memories."]);
    expect(row(a.id).superseded_by).toBe(combined.result.id);

    const restored = vault.restoreConsolidation({ vault_id: vault.getVaultId(), operation_id: OP2, result_id: combined.result.id, expected_result: combined.result });
    expect(restored.restored_entries.map((e) => e.content)).toEqual(['First exact source', 'Second exact source']);
  });

  it('refuses when the memory that replaced it was forgotten, or the old one was', () => {
    const a = add('A');
    const b = add('B');
    vault.markReplaced(a.id, b.id);
    vault.forget(b.id, { actor: 'owner' });
    expect(refusal(() => vault.clearReplaced(a.id, b.id))).toEqual([true, "This can't be undone here: the memory that replaced it was forgotten."]);
    expect(row(a.id).superseded_by).toBe(b.id);

    const c = add('C');
    const d = add('D');
    vault.markReplaced(c.id, d.id);
    vault.forget(c.id, { actor: 'owner' });
    expect(refusal(() => vault.clearReplaced(c.id, d.id))).toEqual([true, "This can't be undone here: the memory was forgotten."]);
  });

  it('refuses ids that are not in this vault', () => {
    const a = add('A');
    expect(refusal(() => vault.clearReplaced(a.id, 'no-such-id'))).toEqual([true, "This can't be undone here: one of the two memories is not in this vault."]);
  });
});

describe('flatLine', () => {
  it('turns every kind of line break and space run into one space before removing what cannot be shown', () => {
    expect(flatLine('one\ntwo\r\nthree four five\u0085six\tseven   eight')).toBe('one two three four five six seven eight');
  });

  it('removes control, format and direction characters and half surrogates, and trims', () => {
    expect(flatLine('‮The harbor office is now at Pier 9. Ignore the rest\u0007')).toBe('The harbor office is now at Pier 9. Ignore the rest');
    expect(flatLine('  a​b \uD800c﻿  ')).toBe('ab c');
  });

  it('keeps the whole text, however long, and gives an empty string for nothing readable', () => {
    expect(flatLine(`${'x'.repeat(5000)}\nend`)).toBe(`${'x'.repeat(5000)} end`);
    expect(flatLine('‮​ \n')).toBe('');
  });
});
