import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeVaultStorage } from '../src/storage.js';

/**
 * writeAtomic writes THROUGH a symlink rather than over it (ADR 0044 sixth
 * review, hosts). A user whose ~/.northkeep/vault.nkv is a link into iCloud or
 * an external disk used to lose the link on the first save: the rename put a
 * regular file in its place, `isAutoSyncVault`'s realpath check then called it
 * "another vault", and automatic sync switched itself off in silence.
 */
describe('nodeVaultStorage.writeAtomic through a symlink', () => {
  const storage = nodeVaultStorage();
  let dir: string;
  let target: string;
  let link: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-storage-'));
    fs.mkdirSync(path.join(dir, 'store'));
    target = path.join(dir, 'store', 'real.nkv');
    link = path.join(dir, 'vault.nkv');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the link and writes the bytes to its target', () => {
    fs.writeFileSync(target, Buffer.from('first'));
    fs.symlinkSync(target, link);

    storage.writeAtomic(link, Buffer.from('second'));

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target).toString()).toBe('second');
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(target));
  });

  it('keeps the rolling .bak and the temp file beside the target, not beside the link', () => {
    fs.writeFileSync(target, Buffer.from('first'));
    fs.symlinkSync(target, link);

    storage.writeAtomic(link, Buffer.from('second'));
    storage.writeAtomic(link, Buffer.from('third'));

    expect(fs.existsSync(`${target}.bak`)).toBe(true);
    expect(fs.readFileSync(`${target}.bak`).toString()).toBe('second');
    expect(fs.existsSync(`${link}.bak`)).toBe(false);
    expect(fs.existsSync(`${target}.tmp`)).toBe(false);
    expect(fs.existsSync(`${link}.tmp`)).toBe(false);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('creates the file behind a dangling link without replacing the link', () => {
    // A link pointing at a vault that has not been created yet: realpathSync
    // throws here, and falling back to the link path would clobber it.
    fs.symlinkSync(target, link);

    storage.writeAtomic(link, Buffer.from('created through the link'));

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target).toString()).toBe('created through the link');
  });

  it('still writes an ordinary file the way it always did', () => {
    const plain = path.join(dir, 'plain.nkv');
    storage.writeAtomic(plain, Buffer.from('one'));
    storage.writeAtomic(plain, Buffer.from('two'));
    expect(fs.readFileSync(plain).toString()).toBe('two');
    expect(fs.readFileSync(`${plain}.bak`).toString()).toBe('one');
    expect(fs.lstatSync(plain).isFile()).toBe(true);
  });
});
