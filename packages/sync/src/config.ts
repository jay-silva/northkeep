import fs from 'node:fs';
import path from 'node:path';
import { northkeepHome } from '@northkeep/core';

/**
 * Sync config sidecar (`~/.northkeep/sync.json`). Holds only WHERE the vault
 * syncs and the last version this machine saw — never a secret (the token is
 * re-derived from `device.secret` on demand, ADR 0009). Mirrors the 0700-dir /
 * 0600-file posture of `@northkeep/converse`'s settings store.
 */

export interface SyncConfig {
  /** Sync server base URL (https, or loopback for tests). */
  serverUrl: string;
  /** Cached account id (derived from the device secret; convenience only). */
  accountId: string;
  /** Highest server version this machine has pulled or pushed. 0 = never synced. */
  lastVersion: number;
  lastSyncedAt: string | null;
}

export function syncConfigPath(): string {
  return path.join(northkeepHome(), 'sync.json');
}

export function loadSyncConfig(): SyncConfig | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(syncConfigPath(), 'utf8')) as SyncConfig;
    if (typeof parsed.serverUrl !== 'string') return null;
    return {
      serverUrl: parsed.serverUrl,
      accountId: typeof parsed.accountId === 'string' ? parsed.accountId : '',
      lastVersion: Number.isInteger(parsed.lastVersion) ? parsed.lastVersion : 0,
      lastSyncedAt: typeof parsed.lastSyncedAt === 'string' ? parsed.lastSyncedAt : null,
    };
  } catch {
    return null;
  }
}

export function saveSyncConfig(config: SyncConfig): void {
  const target = syncConfigPath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Refuse a non-https server unless it's loopback (tests / self-host on the
 * same box). Sending the bearer token or ciphertext to a plain-http public
 * host would cross the network unprotected — same stance as converse takes
 * with API keys.
 */
export function assertSyncUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Not a valid sync server URL: "${rawUrl}"`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && loopback) return url;
  throw new Error(
    `Refusing a non-https sync server ("${rawUrl}"). Use https:// so your token and vault never cross the network unprotected.`,
  );
}

/** Set (or change) the sync server, validating the URL and caching the account id. */
export function setSyncServer(serverUrl: string, accountId: string): SyncConfig {
  const url = assertSyncUrl(serverUrl);
  const existing = loadSyncConfig();
  const config: SyncConfig = {
    serverUrl: url.toString().replace(/\/$/, ''),
    accountId,
    // Changing servers resets the version baseline; keep it if the account matches.
    lastVersion: existing && existing.accountId === accountId ? existing.lastVersion : 0,
    lastSyncedAt: existing && existing.accountId === accountId ? existing.lastSyncedAt : null,
  };
  saveSyncConfig(config);
  return config;
}
