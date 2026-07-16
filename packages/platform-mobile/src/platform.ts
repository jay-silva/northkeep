import type { Platform } from '@northkeep/core';
import { mobileCryptoProvider, mobileCryptoReady } from './native.js';
import { mobileSqliteDriver } from './sqlite.js';
import { mobileVaultStorage } from './storage.js';

/**
 * The mobile platform: react-native-libsodium + react-native-quick-crypto
 * crypto, expo-sqlite driver, expo-file-system atomic storage, bundled as one
 * Platform — the exact mirror of platform-node's nodePlatform(). The apps/
 * mobile entry point calls setPlatform(mobilePlatform()) once at startup
 * (after awaiting mobilePlatformReady()).
 *
 * Constructing the crypto provider asserts the linked libsodium's AEAD
 * constants still match the literals core inlines (sodium-api.ts), the mobile
 * analog of platform-node's assertLibsodiumConstants. The crypto_pwhash cost
 * constants cannot be asserted here (no pwhash in the RN binding); they stay
 * pinned by core's literals and the byte-exact test suite.
 */
export function mobilePlatform(): Platform {
  return {
    crypto: mobileCryptoProvider(),
    sqlite: mobileSqliteDriver(),
    storage: mobileVaultStorage(),
  };
}

/** Await the sodium ready promise, then build the platform. Convenience for
 * app startup: `setPlatform(await mobilePlatformReady())`. */
export async function mobilePlatformReady(): Promise<Platform> {
  await mobileCryptoReady();
  return mobilePlatform();
}
