import { setPlatform, type Platform } from '@northkeep/core';

/**
 * THE integration seam with @northkeep/platform-mobile (built in parallel;
 * ADR 0018). The root layout calls initMobilePlatform() exactly once at
 * startup, mirroring how the CLI / web GUI / MCP server call
 * setPlatform(nodePlatform()) from @northkeep/platform-node.
 *
 * TODO(platform-mobile integration): when the package lands, integration is
 * one edit: delete the local mobilePlatform() stub below and replace it with
 *
 *   import { mobilePlatform } from '@northkeep/platform-mobile';
 *
 * plus `"@northkeep/platform-mobile": "workspace:*"` in package.json. Nothing
 * else in the app changes: every vault/crypto/storage call already goes
 * through getPlatform().
 */

/**
 * Local stub standing in for @northkeep/platform-mobile until it is
 * resolvable in the workspace (adding the workspace dependency before the
 * package exists would break `pnpm install` for the whole monorepo). The
 * real package provides: react-native-libsodium + react-native-quick-crypto
 * (CryptoProvider), expo-sqlite serialize/deserialize (SqliteDriver), and
 * expo-file-system temp+move atomic writes (VaultStorage).
 */
function mobilePlatform(): Platform {
  throw new Error(
    'The NorthKeep mobile platform adapters are not wired in yet. ' +
      'Integrate @northkeep/platform-mobile in src/platform.ts (one import; see the TODO there).',
  );
}

let initialized = false;
let initError: string | null = null;

/**
 * Registers the mobile platform adapters. Idempotent. Returns null on
 * success or a human-readable error string so the UI can show a loud
 * degradation banner instead of crashing at import time (invariant #6:
 * degrade loudly, never silently).
 */
export function initMobilePlatform(): string | null {
  if (initialized) return initError;
  initialized = true;
  try {
    setPlatform(mobilePlatform());
    initError = null;
  } catch (err) {
    initError = err instanceof Error ? err.message : String(err);
  }
  return initError;
}

/** The last init result without re-running init. */
export function platformInitError(): string | null {
  return initialized ? initError : 'Platform not initialized yet.';
}
