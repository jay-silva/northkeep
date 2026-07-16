import { setPlatform } from '@northkeep/core';
import { mobilePlatformReady } from '@northkeep/platform-mobile';

/**
 * The integration seam with @northkeep/platform-mobile (ADR 0018 / 0021).
 * The root layout calls initMobilePlatform() once at startup and gates the UI
 * until it resolves, mirroring how the CLI / web GUI / MCP server call
 * setPlatform(nodePlatform()) from @northkeep/platform-node.
 *
 * This is ASYNC on purpose: the RN libsodium binding must reach `sodium.ready`
 * before any crypto runs, so we await mobilePlatformReady() (the package's own
 * documented startup call) and only then register the platform. That is why the
 * layout shows an initializing state until this resolves, rather than the
 * synchronous set the desktop entry points can do.
 *
 * NEEDS ON-DEVICE VALIDATION (invariant #3 / ADR 0021 remains Proposed): the RN
 * bindings behind mobilePlatformReady() (react-native-libsodium sodium.ready,
 * react-native-quick-crypto Argon2id, expo-sqlite, expo-file-system,
 * expo-secure-store) have NEVER executed off-device. This wiring is
 * typecheck-correct against the declared API only; the byte-exact proof covers
 * the pure adapter logic, not the native bindings or the startup timing.
 */

let initPromise: Promise<string | null> | null = null;

/**
 * Register the mobile platform adapters. Idempotent. Resolves to null on
 * success, or a human-readable error string so the UI can show a loud
 * degradation banner instead of crashing (invariant #6: degrade loudly).
 */
export function initMobilePlatform(): Promise<string | null> {
  if (!initPromise) {
    initPromise = mobilePlatformReady()
      .then((platform) => {
        setPlatform(platform);
        return null;
      })
      .catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
  }
  return initPromise;
}
