export * from './types.js';
export * from './canonical.js';
export {
  KDF_INTERACTIVE,
  KDF_MODERATE,
  DEVICE_SECRET_BYTES,
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
