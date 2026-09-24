/**
 * The ADR 0061 maintenance step: client-secret migration, OAuth code and token
 * cleanup, and the legacy plaintext purge. It runs only on explicit flags,
 * never on environment inference: Jay sets them in the connector's Vercel
 * Production environment only, so a preview built from a stray branch push
 * cannot rewrite or delete production rows (ADR 0061, Deploy safety). The
 * purge also needs its own flag and never runs while legacy passthrough is on.
 * Logs are counts and reasons only (invariant #5).
 */

import { migrateClientSecrets, type ClientSecretMigrationResult } from './client-secrets.js';
import type { ConnectorStorage, OAuthGcResult } from './storage.js';

export const MAINTENANCE_FLAG = 'NORTHKEEP_CONNECTOR_MAINTENANCE';
export const PURGE_FLAG = 'NORTHKEEP_CONNECTOR_PURGE_LEGACY_PLAINTEXT';
export const ALLOW_LEGACY_FLAG = 'NORTHKEEP_CONNECTOR_ALLOW_LEGACY_PLAINTEXT';

const ON_VALUES = new Set(['on', 'true', '1', 'yes']);
const OFF_VALUES = new Set(['', 'off', 'false', '0', 'no']);

export type FlagValue = 'on' | 'off' | 'unrecognized';

/** Trim, ignore case. on|true|1|yes is on; absent, empty, off|false|0|no is off; anything else is unrecognized (treated as off). */
export function parseFlag(raw: string | undefined): FlagValue {
  if (raw === undefined) return 'off';
  const v = raw.trim().toLowerCase();
  if (ON_VALUES.has(v)) return 'on';
  if (OFF_VALUES.has(v)) return 'off';
  return 'unrecognized';
}

export interface MaintenanceConfig {
  run: boolean;
  purge: boolean;
  /** Content-free reasons, by flag name only, for the log line. */
  notes: string[];
}

export function maintenanceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MaintenanceConfig {
  const notes: string[] = [];
  const m = parseFlag(env[MAINTENANCE_FLAG]);
  const p = parseFlag(env[PURGE_FLAG]);
  if (m === 'unrecognized') notes.push(`${MAINTENANCE_FLAG} value not recognized, treated as off`);
  if (p === 'unrecognized') notes.push(`${PURGE_FLAG} value not recognized, treated as off`);
  const run = m === 'on';
  if (!run) return { run: false, purge: false, notes: [...notes, `${MAINTENANCE_FLAG} not on`] };
  const allowLegacy = env[ALLOW_LEGACY_FLAG] === '1';
  let purge = p === 'on';
  if (!purge) notes.push(`purge skipped: ${PURGE_FLAG} not on`);
  if (purge && allowLegacy) {
    purge = false;
    notes.push(`purge skipped: ${ALLOW_LEGACY_FLAG}=1`);
  }
  return { run, purge, notes };
}

export interface MaintenanceResult {
  purged: number | null;
  clients: ClientSecretMigrationResult | null;
  gc: OAuthGcResult | null;
  failures: string[];
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'error';
}

/** Run the enabled parts independently; one failing part never stops another. */
export async function runMaintenance(
  storage: ConnectorStorage,
  cfg: MaintenanceConfig,
  log: (line: string) => void = (l) => console.log(l), // eslint-disable-line no-console
): Promise<MaintenanceResult | null> {
  if (!cfg.run) {
    log(`connector maintenance: skipped (${cfg.notes.join('; ')})`);
    return null;
  }
  const out: MaintenanceResult = { purged: null, clients: null, gc: null, failures: [] };
  try {
    out.clients = await migrateClientSecrets(storage);
  } catch (err) {
    out.failures.push(`client secrets: ${errMessage(err)}`);
  }
  try {
    out.gc = await storage.gcOAuth(Math.floor(Date.now() / 1000));
  } catch (err) {
    out.failures.push(`oauth cleanup: ${errMessage(err)}`);
  }
  if (cfg.purge) {
    try {
      out.purged = await storage.purgeLegacyPlaintext();
    } catch (err) {
      out.failures.push(`purge: ${errMessage(err)}`);
    }
  }
  const c = out.clients;
  const parts = [
    `purged=${out.purged === null ? 'skipped' : out.purged}`,
    c
      ? `clientsMigrated=${c.migrated} clientsUnparsable=${c.unparsable} clientsCasMissed=${c.casMissed} ` +
        `clientsSentinelNoHash=${c.sentinelNoHash} clientsPlaintextRemaining=${c.plaintextRemaining}`
      : 'clients=failed',
    out.gc ? `codesGc=${out.gc.codes} tokensGc=${out.gc.tokens}` : 'oauthGc=failed',
  ];
  const tail = [...cfg.notes, ...out.failures];
  log(`connector maintenance: ${parts.join(' ')}${tail.length ? ` (${tail.join('; ')})` : ''}`);
  return out;
}
