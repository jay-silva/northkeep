import { timingSafeEqual, randomBytes as nodeRandomBytes } from 'node:crypto';
import {
  Vault,
  deriveMasterKey,
  loadDeviceSecret,
  withFileLock,
} from '@northkeep/core';
import { resolveMasterKey } from '@northkeep/mcp-server';

/**
 * In-memory UI session: the auth token and (once unlocked) the vault master
 * key. Nothing here ever touches disk; locking zeroes the key.
 */
export class UiSession {
  readonly token: string;
  private heldKey: Buffer | null = null;
  readonly vaultPath: string;

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
    this.token = nodeRandomBytes(32).toString('hex');
  }

  checkToken(candidate: string | undefined): boolean {
    if (!candidate || candidate.length !== this.token.length) return false;
    return timingSafeEqual(Buffer.from(candidate), Buffer.from(this.token));
  }

  /** Unlocked when we hold a key, or an ambient source (Keychain/env) provides one. */
  isUnlocked(): boolean {
    if (this.heldKey !== null) return true;
    const ambient = resolveMasterKey(this.vaultPath);
    if (ambient !== null) {
      this.heldKey = ambient.key; // cache; ambient sources are stable for the session
      return true;
    }
    return false;
  }

  /** Derives, verifies against the vault, and holds the key. Throws VaultAuthError on a bad passphrase. */
  async unlock(passphrase: string): Promise<void> {
    const header = Vault.readHeader(this.vaultPath);
    const key = deriveMasterKey(passphrase, loadDeviceSecret(), header.salt, header.kdf);
    await withFileLock(this.vaultPath, () => {
      Vault.openWithKey(this.vaultPath, Buffer.from(key)).close();
    });
    this.heldKey = key;
  }

  keyHex(): string {
    if (this.heldKey === null) throw new Error('locked');
    return this.heldKey.toString('hex');
  }

  lock(): void {
    if (this.heldKey !== null) {
      this.heldKey.fill(0);
      this.heldKey = null;
    }
  }

  /** Opens the vault under the file lock, runs fn, closes. */
  async withVault<T>(fn: (vault: Vault) => T): Promise<T> {
    if (!this.isUnlocked()) throw new LockedError();
    const keyCopy = Buffer.from(this.heldKey!); // openWithKey consumes its buffer
    return withFileLock(this.vaultPath, () => {
      const vault = Vault.openWithKey(this.vaultPath, keyCopy);
      try {
        return fn(vault);
      } finally {
        vault.close();
      }
    });
  }
}

export class LockedError extends Error {
  constructor() {
    super('Vault is locked.');
    this.name = 'LockedError';
  }
}
