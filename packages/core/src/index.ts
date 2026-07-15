export * from './types.js';
export * from './canonical.js';
export {
  KDF_INTERACTIVE,
  KDF_MODERATE,
  DEVICE_SECRET_BYTES,
  SALT_BYTES,
  NONCE_BYTES,
  AEAD_OVERHEAD,
  KEY_BYTES,
  VaultAuthError,
  generateDeviceSecret,
  type KdfParams,
} from './crypto.js';
export {
  Vault,
  computeEntryHash,
  cosineSimilarity,
  type VaultHeader,
  type VaultOptions,
} from './vault.js';
export { deriveMasterKey, memzero } from './crypto.js';
export { withFileLock } from './lock.js';
export * from './platform.js';
export { getPlatform, setPlatform, type Platform } from './platform-context.js';
export type { CryptoProvider } from './crypto-provider.js';
export type { SqliteDb, SqliteDriver, SqliteStatement } from './sqlite-driver.js';
export type { VaultStorage } from './vault-storage.js';
