/**
 * writeAtomic must leave the new bytes at the target before it returns. Since
 * Expo SDK 57, File.copy() and File.move() return Promises; the fake below
 * models that (the async calls land on a later tick, the *Sync calls at once),
 * so a regression to the async calls fails here instead of on a phone, where
 * the next read found no file (builds 32 and 33).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const files = new Map<string, Uint8Array>();

vi.mock('expo-file-system', () => {
  class File {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    get exists(): boolean {
      return files.has(this.uri);
    }
    create(): void {
      files.set(this.uri, new Uint8Array());
    }
    write(bytes: Uint8Array): void {
      files.set(this.uri, new Uint8Array(bytes));
    }
    delete(): void {
      if (!files.delete(this.uri)) throw new Error('path does not exist');
    }
    bytesSync(): Uint8Array {
      const bytes = files.get(this.uri);
      if (!bytes) throw new Error('no file');
      return bytes;
    }
    copySync(to: File): void {
      const bytes = files.get(this.uri);
      if (!bytes) throw new Error('copy source missing');
      files.set(to.uri, new Uint8Array(bytes));
    }
    moveSync(to: File): void {
      this.copySync(to);
      files.delete(this.uri);
      this.uri = to.uri;
    }
    copy(to: File): Promise<void> {
      return Promise.resolve().then(() => this.copySync(to));
    }
    move(to: File): Promise<void> {
      return Promise.resolve().then(() => this.moveSync(to));
    }
  }
  class Directory {
    constructor(public uri: string) {}
    get exists(): boolean {
      return true;
    }
    create(): void {}
  }
  return { File, Directory, Paths: { document: '/doc', cache: '/cache' } };
});

const { mobileVaultStorage } = await import('../src/storage');

describe('mobile writeAtomic', () => {
  beforeEach(() => files.clear());

  it('leaves a first write readable before it returns', () => {
    const storage = mobileVaultStorage();
    storage.writeAtomic('/cache/vault.nkv.pulled.tmp', Buffer.from('new'));
    expect(Buffer.from(storage.readBytes('/cache/vault.nkv.pulled.tmp')).toString()).toBe('new');
    expect(files.has('/cache/vault.nkv.pulled.tmp.tmp')).toBe(false);
  });

  it('replaces an existing file and keeps the previous one as .bak, synchronously', () => {
    const storage = mobileVaultStorage();
    storage.writeAtomic('/doc/vault.nkv', Buffer.from('old'));
    storage.writeAtomic('/doc/vault.nkv', Buffer.from('new'));
    expect(Buffer.from(storage.readBytes('/doc/vault.nkv')).toString()).toBe('new');
    expect(Buffer.from(files.get('/doc/vault.nkv.bak')!).toString()).toBe('old');
  });
});
