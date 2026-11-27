import type { CryptoProvider } from './crypto-provider.js';
import type { SqliteDriver } from './sqlite-driver.js';
import type { VaultStorage } from './vault-storage.js';

/**
 * The platform seam (ADR 0018). A Platform bundles the three swappable adapters
 * the vault/crypto/storage layer depends on. packages/core defines the interface
 * and holds a module-level default; each application ENTRY POINT registers a
 * concrete Platform exactly once at startup via setPlatform():
 *
 *   - packages/cli bin entry, apps/web startUiServer, packages/mcp-server
 *     startServer  → setPlatform(nodePlatform())  (from @northkeep/platform-node)
 *   - apps/mobile (future)                        → setPlatform(mobilePlatform())
 *   - tests                                       → a shared Vitest setup file
 *
 * core NEVER imports a concrete provider (that would be circular — the provider
 * packages import core for these types). Vault and the crypto helpers call
 * getPlatform() when no explicit platform is supplied.
 */
export interface Platform {
  crypto: CryptoProvider;
  sqlite: SqliteDriver;
  storage: VaultStorage;
  /**
   * ADR 0097 D3: `false` turns off the check that the vault file is unchanged
   * before a save. On unless a platform opts out; only the phone does, where
   * every vault action already waits in one line.
   */
  checkFileBeforeSave?: boolean;
  /**
   * ADR 0092: the phone opens a 0.5 vault but never makes the 0.4 to 0.5 step
   * itself, so a phone updated first cannot lock out a Mac not yet updated.
   */
  makeSchemaSteps?: boolean;
}

let defaultPlatform: Platform | null = null;

/** Register the platform adapters. Call once at application startup. */
export function setPlatform(platform: Platform): void {
  defaultPlatform = platform;
}

/** The registered platform. Throws if setPlatform() was never called. */
export function getPlatform(): Platform {
  if (!defaultPlatform) {
    throw new Error(
      'NorthKeep platform not configured: call setPlatform(nodePlatform()) at startup ' +
        '(from @northkeep/platform-node), or register a platform in your test setup.',
    );
  }
  return defaultPlatform;
}
