#!/usr/bin/env node
import { startServer } from './server.js';

export { createServer, startServer, grantedScopes } from './server.js';
export { auditAsCsv, auditAsJson } from './audit.js';
export {
  keychainAvailable,
  keychainDeleteMasterKey,
  keychainGetMasterKey,
  keychainSetMasterKey,
} from './keychain.js';
export { LOCKED_MESSAGE, resolveMasterKey } from './key.js';
export { appendCallLog, readCallLog, type CallLogEntry } from './log.js';
export {
  SERVER_NAME,
  chatgptStatus,
  claudeCodeAvailable,
  claudeCodeStatus,
  claudeDesktopConfigPath,
  claudeDesktopStatus,
  codexConfigPath,
  connect,
  connectChatgpt,
  connectClaudeCode,
  connectClaudeDesktop,
  connectCursor,
  connectStatus,
  cursorConfigPath,
  cursorStatus,
  disconnect,
  disconnectChatgpt,
  disconnectClaudeCode,
  disconnectClaudeDesktop,
  disconnectCursor,
  mcpEntryLooksValid,
  resolveMcpCommand,
  type ConnectResult,
  type ConnectStatus,
  type ConnectTarget,
  type McpCommand,
} from './connect.js';
export {
  CONTRACT_GRACEFUL_DEGRADATION,
  CONTRACT_TEXT,
  claudeRulesPath,
  codexAgentsPath,
  codexHomePath,
  contractStatus,
  contractStatusAll,
  cursorGitVisibilityNote,
  cursorRulePath,
  installAll,
  installContract,
  isCodexDetected,
  renderContract,
  uninstallContract,
  type ContractOpts,
  type ContractStatusKind,
  type ContractStatusResult,
  type ContractTarget,
  type InstallResult,
  type UninstallResult,
} from './contract.js';

// Executed directly (Claude Desktop config / `northkeep serve`), not imported.
if (process.argv[1]?.endsWith('mcp-server/dist/index.js')) {
  startServer().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
