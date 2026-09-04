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
  /**
   * sha256 of the vault file as it stood at the end of the last successful push
   * or pull. Lets `syncState` tell "the server moved on" apart from "we BOTH
   * moved on" without downloading the remote blob. Null on configs written
   * before this field existed, and on a server change; callers treat null as
   * "cannot prove the local file is untouched".
   */
  lastSha: string | null;
  /**
   * The vault's `sync_generation` as it stood in the bytes this machine last
   * pushed or pulled. Two things lean on it (ADR 0044 fourth review):
   * `pushVault` bumps the generation only when the local file is not already
   * ahead of this, so a retry that follows a failed upload does not add a
   * second bump; and `pullVault` compares an incoming blob's generation
   * against this rather than against the local file's stamp, because "is this
   * a replay of something older than what I last synced?" is the question the
   * check exists to answer. Null on configs written before this field existed
   * and on a server change; the first push or pull records one.
   */
  lastGeneration: number | null;
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
      lastSha: typeof parsed.lastSha === 'string' ? parsed.lastSha : null,
      lastGeneration: Number.isInteger(parsed.lastGeneration) ? parsed.lastGeneration : null,
    };
  } catch {
    return null;
  }
}

/**
 * Write the config atomically: a temp file in the same directory, then a
 * rename. A kill (or a power cut) in the middle of a plain writeFileSync
 * leaves a truncated `sync.json`, which `loadSyncConfig` cannot parse, and
 * every command then says "Sync is not configured" with the server URL and
 * the baseline gone (ADR 0044 fourth review). The rename is atomic within the
 * directory, so a reader sees either the old file or the new one.
 */
export function saveSyncConfig(config: SyncConfig): void {
  const target = syncConfigPath();
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.sync.json.tmp-${process.pid}-${Date.now()}`);
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`);
      // Best effort: on a crash of the machine (not the process) the rename
      // could otherwise land before the bytes. A filesystem that refuses
      // fsync must not fail the save.
      try {
        fs.fsyncSync(fd);
      } catch {
        // ignore
      }
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
  }
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
    lastSha: existing && existing.accountId === accountId ? existing.lastSha : null,
    lastGeneration: existing && existing.accountId === accountId ? existing.lastGeneration : null,
  };
  saveSyncConfig(config);
  return config;
}
