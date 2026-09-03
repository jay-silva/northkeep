import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, Vault, onVaultSave } from '../src/index.js';

describe('onVaultSave (ADR 0044 after-save hook)', () => {
  let home: string;
  const deviceSecret = Buffer.alloc(32, 3);
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-savehook-'));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('fires with the vault path on every save, survives a throwing listener, and unsubscribes', () => {
    const p = path.join(home, 'vault.nkv');
    const seen: string[] = [];
    const off = onVaultSave((vp) => seen.push(vp));
    const offThrower = onVaultSave(() => {
      throw new Error('observer bug');
    });
    const v = Vault.create({ path: p, passphrase: 'pw', deviceSecret, kdf: KDF_INTERACTIVE });
    expect(seen).toEqual([p]); // create() saves once
    v.remember({ content: 'x', type: 'semantic' });
    expect(() => v.save()).not.toThrow(); // the throwing listener never fails the save
    expect(seen).toEqual([p, p]);
    off();
    offThrower();
    v.save();
    expect(seen).toEqual([p, p]);
    v.close();
  });
});
