export { timeoutSignal, withTimeout } from './abort.js';
export {
  AutoSync,
  AUTO_PULL_BACKUP_SUFFIX,
  DIVERGED_MESSAGE,
  syncAge,
  type AutoSyncEvent,
  type AutoSyncOptions,
  type AutoSyncPhase,
  type AutoSyncStatus,
} from './auto.js';
export { deriveConnectorToken, deriveSyncCreds, tokenHash, type SyncCreds } from './creds.js';
export {
  assertSyncUrl,
  loadSyncConfig,
  saveSyncConfig,
  setSyncServer,
  syncConfigPath,
  type SyncConfig,
} from './config.js';
export {
  MAX_BLOB_BYTES,
  pullVault,
  pushVault,
  syncState,
  subscriptionStatus,
  checkoutUrl,
  portalUrl,
  SubscriptionRequiredError,
  type PullResult,
  type PushResult,
  type RemoteStatus,
  type SyncState,
  type SubscriptionStatus,
} from './client.js';
export {
  assertConnectorUrl,
  connectorConfigPath,
  foldSidecarScopesIntoVault,
  loadConnectorConfig,
  saveConnectorConfig,
  setConnectorServer,
  type ConnectorConfig,
} from './connector-config.js';
export {
  downSyncConnector,
  fetchEntitlement,
  getManifest,
  ConnectorTombstoneError,
  pushSharedScopes,
  startPairing,
  unshareScope,
  type DownSyncResult,
  type ManifestEntry,
  type PushEntry,
  type PushSharedResult,
} from './connector-client.js';
