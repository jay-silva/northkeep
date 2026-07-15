/**
 * Server entry point — for Vercel's Node preset AND self-hosting
 * (`node dist/index.js`). A module that creates an HTTP server and calls
 * `listen()` at startup is auto-detected by Vercel and routed to. All request
 * logic lives in `createConnectorServer`; this file wires storage + the port.
 * The importable, side-effect-free API lives in `./lib.js` for tests.
 *
 * Env: PUBLIC_URL (the deployed https origin, e.g. https://connector.northkeep.ai)
 * so OAuth metadata advertises absolute URLs that match the deploy; plus a
 * Postgres URL for the connector's SEPARATE Neon database (ADR 0016).
 */
import { createConnectorServer } from './server.js';
import { NeonConnectorStorage } from './neon-storage.js';
import { resolveDatabaseUrl } from './db-url.js';
import type { ConnectorStorage } from './storage.js';

const databaseUrl = resolveDatabaseUrl();
const storage: ConnectorStorage = databaseUrl ? new NeonConnectorStorage(databaseUrl) : missingDbStorage();

createConnectorServer(storage).listen(Number(process.env.PORT ?? 3000), () => {
  // eslint-disable-next-line no-console
  console.log(
    `NorthKeep connector listening on :${process.env.PORT ?? 3000} ` +
      `(PUBLIC_URL=${process.env.PUBLIC_URL ?? 'http://localhost:' + (process.env.PORT ?? 3000)})`,
  );
});

/**
 * If no Postgres URL is configured, don't crash at startup — serve, and let each
 * DB-touching request fail as a clean 500, keeping a misconfigured deploy
 * diagnosable instead of a boot loop (same posture as the sync server).
 */
function missingDbStorage(): ConnectorStorage {
  const fail = async (): Promise<never> => {
    throw new Error('No database configured (set DATABASE_URL / POSTGRES_URL).');
  };
  return {
    upsertAccount: fail,
    putPairingCode: fail,
    consumePairingCode: fail,
    getClient: fail,
    registerClient: fail,
    putCode: fail,
    getCode: fail,
    consumeCode: fail,
    putToken: fail,
    getToken: fail,
    deleteToken: fail,
    putEntry: fail,
    listEntries: fail,
    appendAudit: fail,
  };
}
