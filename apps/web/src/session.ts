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
  /** True after an explicit lock, until the next explicit unlock — suppresses
   * ambient (Keychain/env) re-caching so "Lock" isn't a no-op when a key
   * source is present in the environment. */
  private explicitlyLocked = false;
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
    if (this.explicitlyLocked) return false;
    const ambient = resolveMasterKey(this.vaultPath);
    if (ambient !== null) {
      this.heldKey = ambient.key; // cache; ambient sources are stable for the session
      return true;
    }
    return false;
  }

  /** Whether an env var (not the Keychain) grants access — the one thing the
   * in-app lock cannot revoke. Surfaced to the user, mirroring the CLI. */
  hasEnvGrant(): boolean {
    return Boolean(process.env.NORTHKEEP_MASTER_KEY || process.env.NORTHKEEP_PASSPHRASE);
  }

  /** Derives, verifies against the vault, and holds the key. Throws VaultAuthError on a bad passphrase. */
  async unlock(passphrase: string): Promise<void> {
    const header = Vault.readHeader(this.vaultPath);
    const key = deriveMasterKey(passphrase, loadDeviceSecret(), header.salt, header.kdf);
    try {
      await withFileLock(this.vaultPath, () => {
        Vault.openWithKey(this.vaultPath, Buffer.from(key)).close();
      });
    } catch (err) {
      key.fill(0); // bad passphrase — don't leave the derived key for GC
      throw err;
    }
    this.explicitlyLocked = false;
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
    // An env-var grant survives this (isUnlocked would re-cache it); the flag
    // stops that, so lock actually locks. hasEnvGrant() still warns the user.
    this.explicitlyLocked = true;
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
