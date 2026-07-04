import { Vault, deriveMasterKey, loadDeviceSecret } from '@northkeep/core';
import { keychainAvailable, keychainGetMasterKey } from './keychain.js';

export type KeySource = 'env-key' | 'keychain' | 'env-passphrase';

export interface ResolvedKey {
  key: Buffer;
  /** Where the key came from — determines the right error message when it fails. */
  source: KeySource;
}

/**
 * Resolves the vault master key for background (no-terminal) use, in order:
 *   1. NORTHKEEP_MASTER_KEY env (hex) — tests/CI
 *   2. macOS Keychain — populated by `northkeep unlock`
 *   3. NORTHKEEP_PASSPHRASE env — derives via Argon2id (slow path)
 * Returns null when locked. Callers get a FRESH Buffer each call because
 * Vault.openWithKey takes ownership of (and may zero) the buffer.
 */
export function resolveMasterKey(vaultPath: string): ResolvedKey | null {
  const fromEnv = process.env.NORTHKEEP_MASTER_KEY;
  if (fromEnv && /^[0-9a-f]{64}$/i.test(fromEnv)) {
    return { key: Buffer.from(fromEnv, 'hex'), source: 'env-key' };
  }
  if (keychainAvailable()) {
    const fromKeychain = keychainGetMasterKey();
    if (fromKeychain) return { key: fromKeychain, source: 'keychain' };
  }
  const passphrase = process.env.NORTHKEEP_PASSPHRASE;
  if (passphrase) {
    const header = Vault.readHeader(vaultPath);
    return {
      key: deriveMasterKey(passphrase, loadDeviceSecret(), header.salt, header.kdf),
      source: 'env-passphrase',
    };
  }
  return null;
}

export const LOCKED_MESSAGE =
  'The vault is locked. Ask the user to run "northkeep unlock" in a terminal ' +
  'to grant background access (and "northkeep lock" to revoke it).';
