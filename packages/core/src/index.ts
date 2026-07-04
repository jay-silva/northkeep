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
export { Vault, computeEntryHash, type VaultOptions } from './vault.js';
