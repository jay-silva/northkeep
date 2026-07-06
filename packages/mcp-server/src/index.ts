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

// Executed directly (Claude Desktop config / `northkeep serve`), not imported.
if (process.argv[1]?.endsWith('mcp-server/dist/index.js')) {
  startServer().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
