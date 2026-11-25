import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, Vault, VaultChangedError, generateDeviceSecret, getPlatform } from '../src/index.js';

/**
 * ADR 0097 D3: a save refuses when the vault file is not the one this handle
 * opened or last wrote. Temp files and fictional data only.
 */

const passphrase = 'synthetic passphrase';
const deviceSecret = generateDeviceSecret();
const REFUSAL = 'The vault changed while this was running. Nothing was saved. Try again.';
let dir = '';
let vaultPath = '';

const open = () => Vault.open({ path: vaultPath, passphrase, deviceSecret });
const onDisk = (): string[] => {
  const v = open();
  try {
    return v.list().map((e) => e.content);
  } finally {
    v.close();
  }
};
const add = (v: Vault, content: string) => v.remember({ content, type: 'semantic', scope: 'personal' });
const refusal = (fn: () => void): [boolean, string] => {
  try {
    fn();
    return [false, 'saved'];
  } catch (err) {
    return [err instanceof VaultChangedError, (err as Error).message];
  }
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-save-check-'));
  vaultPath = path.join(dir, 'vault.nkv');
  Vault.create({ path: vaultPath, passphrase, deviceSecret, kdf: KDF_INTERACTIVE }).close();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Vault.save checks the file first', () => {
  it('refuses the second of two handles that opened the same file, and the first save is what stays on disk', () => {
    const a = open();
    const b = open();
    add(a, 'Written through the first handle');
    add(b, 'Written through the second handle');
    b.save();

    expect(refusal(() => a.save())).toEqual([true, REFUSAL]);
    a.close();
    b.close();
    expect(onDisk()).toEqual(['Written through the second handle']);
  });

  it('lets one handle save again and again, and a handle opened after a save', () => {
    const a = open();
    add(a, 'One');
    a.save();
    add(a, 'Two');
    a.save();
    const b = open();
    add(b, 'Three');
    b.save();
    a.close();
    b.close();
    expect(onDisk()).toEqual(['One', 'Two', 'Three']);
  });

  it('refuses when the file was replaced by other bytes, such as a pulled vault renamed into place', () => {
    const other = path.join(dir, 'other.nkv');
    fs.copyFileSync(vaultPath, other);
    const o = Vault.open({ path: other, passphrase, deviceSecret });
    add(o, 'From the pulled copy');
    o.save();
    o.close();

    const a = open();
    add(a, 'Typed before the pull landed');
    fs.renameSync(other, vaultPath);
    expect(refusal(() => a.save())).toEqual([true, REFUSAL]);
    a.close();
    expect(onDisk()).toEqual(['From the pulled copy']);
  });

  it('refuses when the file is gone, and when it is no longer a vault', () => {
    const a = open();
    fs.rmSync(vaultPath);
    expect(refusal(() => a.save())).toEqual([true, REFUSAL]);
    expect(fs.existsSync(vaultPath)).toBe(false);

    fs.writeFileSync(vaultPath, 'not a vault');
    expect(refusal(() => a.save())).toEqual([true, REFUSAL]);
    expect(fs.readFileSync(vaultPath, 'utf8')).toBe('not a vault');
    a.close();
  });

  it('a platform that opts out saves over the newer file, as the phone does today', () => {
    const base = getPlatform();
    const a = Vault.open({ path: vaultPath, passphrase, deviceSecret, platform: { ...base, checkFileBeforeSave: false } });
    const b = open();
    add(b, 'Written through the checked handle');
    b.save();
    add(a, 'Written through the unchecked handle');
    a.save();
    a.close();
    b.close();
    expect(onDisk()).toEqual(['Written through the unchecked handle']);
  });

  it('checks without reading the whole file when the storage can read just the header', () => {
    const base = getPlatform();
    const reads: string[] = [];
    const storage = {
      ...base.storage,
      readBytes: (p: string) => (reads.push('whole'), base.storage.readBytes(p)),
      readHead: (p: string, n: number) => (reads.push(`head ${n}`), base.storage.readHead!(p, n)),
    };
    const a = Vault.open({ path: vaultPath, passphrase, deviceSecret, platform: { ...base, storage } });
    reads.length = 0;
    add(a, 'One');
    a.save();
    a.close();
    expect(reads).toEqual(['head 52']);
  });
});
