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
  VaultSchemaError,
  generateDeviceSecret,
  type KdfParams,
} from './crypto.js';
export {
  Vault,
  onVaultSave,
  type VaultSaveListener,
  computeEntryHash,
  cosineSimilarity,
  parseSyncGeneration,
  type VaultHeader,
  type VaultOptions,
} from './vault.js';
export { deriveMasterKey, memzero } from './crypto.js';
export { withFileLock, FileLockTimeoutError, type FileLockOptions } from './lock.js';
export * from './platform.js';
export { getPlatform, setPlatform, type Platform } from './platform-context.js';
export type { CryptoProvider } from './crypto-provider.js';
export type { SqliteDb, SqliteDriver, SqliteStatement } from './sqlite-driver.js';
export type { VaultStorage } from './vault-storage.js';
export {
  PROJECT_DOC_MAX_CHARS,
  PROJECT_DOC_CAP_MESSAGE,
  PROJECT_SCOPE_PREFIX,
  PROJECT_SLUG_PATTERN,
  PROJECT_SECTION_HEADINGS,
  assertProjectDocSize,
  emptyProjectDoc,
  firstNonEmptyLine,
  getProjectSection,
  isProjectScope,
  isValidProjectSlug,
  mergeProjectDoc,
  parseProjectDoc,
  parseProjectSlug,
  projectScope,
  projectSectionKind,
  serializeProjectDoc,
  type ProjectDoc,
  type ProjectDocSection,
  type ProjectDocUpdate,
  type ProjectSectionHeading,
} from './project-doc.js';
