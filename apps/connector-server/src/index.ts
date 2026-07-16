/**
 * Server entry point — the deploy entrypoint for Vercel AND self-hosting.
 *
 * package.json "main" points here (a source file) so Vercel's Node.js builder
 * resolves an entrypoint during its PRE-build detection pass — pointing "main"
 * at the compiled dist/ fails, because dist/ does not exist yet at that phase.
 * The builder then serves the DEFAULT-EXPORTED Express app as a function; the
 * connector is stateless by design (all OAuth state lives in Neon), so it needs
 * no long-lived listener there. For self-hosting and local dev we still bind a
 * port — but only when NOT running on Vercel, where a listen() would be wrong.
 *
 * All request logic lives in `createConnectorServer`; this file wires storage.
 * The importable, side-effect-free API lives in `./lib.js` for tests.
 *
 * Env: PUBLIC_URL (the deployed https origin, e.g. https://connector.northkeep.ai)
 * so OAuth metadata advertises absolute URLs that match the deploy; plus a
 * Postgres URL for the connector's SEPARATE Neon database (ADR 0016).
 */
import { createConnectorServer } from './create-server.js';
import { NeonConnectorStorage } from './neon-storage.js';
import { resolveDatabaseUrl } from './db-url.js';
import type { ConnectorStorage } from './storage.js';

const databaseUrl = resolveDatabaseUrl();
const storage: ConnectorStorage = databaseUrl ? new NeonConnectorStorage(databaseUrl) : missingDbStorage();

const app = createConnectorServer(storage);

// Vercel detects and serves this default export (an Express app is a request
// handler function). Self-host/local bind a port; Vercel sets VERCEL=1.
export default app;

if (!process.env.VERCEL) {
  app.listen(Number(process.env.PORT ?? 3000), () => {
    // eslint-disable-next-line no-console
    console.log(
      `NorthKeep connector listening on :${process.env.PORT ?? 3000} ` +
        `(PUBLIC_URL=${process.env.PUBLIC_URL ?? 'http://localhost:' + (process.env.PORT ?? 3000)})`,
    );
  });
}

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
    replaceScopes: fail,
    deleteScope: fail,
    listTombstones: fail,
    appendAudit: fail,
  };
}
