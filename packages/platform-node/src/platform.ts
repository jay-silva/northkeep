import {
  AEAD_OVERHEAD,
  KDF_INTERACTIVE,
  KDF_MODERATE,
  NONCE_BYTES,
  SALT_BYTES,
  type Platform,
} from '@northkeep/core';
import { assertLibsodiumConstants, nodeCryptoProvider } from './crypto.js';
import { nodeSqliteDriver } from './sqlite.js';
import { nodeVaultStorage } from './storage.js';

/**
 * The Node platform: sodium-native crypto + better-sqlite3 driver + node:fs
 * atomic storage, bundled as one Platform. Every application entry point calls
 * setPlatform(nodePlatform()) exactly once at startup (CLI bin, web
 * startUiServer, mcp-server startServer, and the shared test setup).
 *
 * Constructing it verifies the linked libsodium still matches the constants core
 * inlines, so a native-module bump that shifted the vault format fails loudly.
 */
export function nodePlatform(): Platform {
  assertLibsodiumConstants({
    SALT_BYTES,
    NONCE_BYTES,
    AEAD_OVERHEAD,
    KDF_MODERATE,
    KDF_INTERACTIVE,
  });
  return {
    crypto: nodeCryptoProvider(),
    sqlite: nodeSqliteDriver(),
    storage: nodeVaultStorage(),
  };
}
