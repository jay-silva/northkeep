/** Side-effect-free public API for tests and self-host tooling. */
export { createConnectorServer } from './create-server.js';
export {
  InMemoryConnectorStorage,
  type ConnectorStorage,
  type SharedEntry,
  type StoredOAuthCode,
  type StoredOAuthToken,
  type ConnectorAuditEntry,
} from './storage.js';
export { NeonConnectorStorage, SCHEMA_SQL, SCHEMA_STATEMENTS } from './neon-storage.js';
export {
  ConnectorCryptoError,
  KEK_LABEL_CONNECTOR_TOKEN,
  KEK_LABEL_PAIRING_CODE,
  KEK_LABEL_AUTH_CODE,
  KEK_LABEL_TOKEN,
  deriveKek,
  generateDek,
  wrapDek,
  unwrapDek,
  encryptRow,
  decryptRow,
  isEncryptedRow,
} from './crypto.js';
export { ConnectorOAuthProvider } from './provider.js';
export { createMcpServer } from './mcp.js';
export { sha256hex, generatePairingCode } from './hash.js';
export {
  verifyEntitlement,
  connectorGateFromEnv,
  parseConnectorAllowlist,
  ENTITLEMENT_GRACE_MS,
  type ConnectorGate,
  type EntitlementClaims,
} from './entitlement.js';
