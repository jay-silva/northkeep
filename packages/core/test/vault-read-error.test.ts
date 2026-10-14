import { describe, expect, it } from 'vitest';
import { Vault, getPlatform, type Platform } from '../src/index.js';

function platformWith(storage: Partial<Platform['storage']>): Platform {
  const base = getPlatform();
  return { ...base, storage: { ...base.storage, ...storage } };
}

describe('Vault.readHeader read errors', () => {
  it('keeps the read error when the file exists but cannot be read', () => {
    const platform = platformWith({ exists: () => true, readBytes: () => { throw new Error('readBytes[bytesSync] at x: denied'); } });
    expect(() => Vault.readHeader('/tmp/x.nkv', platform)).toThrow(
      'Could not read the vault file at /tmp/x.nkv: readBytes[bytesSync] at x: denied',
    );
  });

  it('still says no vault found when there is no file', () => {
    const platform = platformWith({ exists: () => false, readBytes: () => { throw new Error('No file at /tmp/x.nkv'); } });
    expect(() => Vault.readHeader('/tmp/x.nkv', platform)).toThrow('No vault found at /tmp/x.nkv. Run "northkeep init" first.');
  });
});
