/**
 * Server entry point — for Vercel's Node preset AND self-hosting
 * (`node dist/index.js`). Per Vercel's Node runtime docs, a module that
 * creates an HTTP server and calls `listen()` at startup is auto-detected and
 * routed to. All request logic lives in `handleSync` (via `createSyncServer`);
 * this file just wires storage + the port. The importable library API lives in
 * `./lib.js` (no side effects) for tests and self-host tooling.
 */
import { createSyncServer } from './server.js';
import { NeonStorage } from './neon-storage.js';
import { resolveDatabaseUrl } from './db-url.js';
import { billingFromEnv } from './billing.js';
import type { Storage } from './storage.js';

const databaseUrl = resolveDatabaseUrl();
const storage: Storage = databaseUrl ? new NeonStorage(databaseUrl) : missingDbStorage();
// Billing is on only when Stripe env is set; otherwise self-host / open.
const billing = billingFromEnv();

createSyncServer(storage, billing).listen(Number(process.env.PORT ?? 3000));

/**
 * If no Postgres URL is configured, don't crash at startup — serve, and let
 * each request fail as a clean 500 (the server handler catches it). This keeps
 * a misconfigured deploy diagnosable instead of a boot loop.
 */
function missingDbStorage(): Storage {
  const fail = async (): Promise<never> => {
    throw new Error('No database configured (set DATABASE_URL / POSTGRES_URL).');
  };
  return {
    get: fail,
    put: fail,
    getSubscription: fail,
    upsertSubscription: fail,
    updateSubscriptionByStripeId: fail,
  };
}
