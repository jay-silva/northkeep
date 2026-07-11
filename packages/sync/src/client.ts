import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { Vault, VaultAuthError, withFileLock } from '@northkeep/core';
import { deriveSyncCreds } from './creds.js';
import { assertSyncUrl, loadSyncConfig, saveSyncConfig, type SyncConfig } from './config.js';

/**
 * The sync client (ADR 0009). Pushes/pulls the opaque `.nkv` ciphertext blob
 * to the ciphertext-only server. Transport conventions match converse's raw
 * fetch: `redirect:'error'` (a redirect could re-send the token/blob to an
 * attacker's Location), `AbortSignal.timeout`, and status-only error messages
 * (never echo response bodies).
 */

const NKV_MAGIC = Buffer.from('NKV1', 'ascii');
const NKV_HEADER_LENGTH = 52;
const STATUS_TIMEOUT_MS = 15_000;
const BLOB_TIMEOUT_MS = 120_000;
export const MAX_BLOB_BYTES = 4 * 1024 * 1024;

/** Thrown when the server requires a subscription (HTTP 402) — surfaces a subscribe prompt. */
export class SubscriptionRequiredError extends Error {
  constructor() {
    super('This sync server requires a $10/month subscription. Run "northkeep sync subscribe".');
    this.name = 'SubscriptionRequiredError';
  }
}

export interface SubscriptionStatus {
  /** Does this server require (and offer) a subscription at all? A 200 from the
   * subscription endpoint means billing is on; a 404 means it isn't. This is the
   * only signal that distinguishes "new user who must subscribe" (status null,
   * billing true) from "self-hosted server that doesn't bill" (status null,
   * billing false). */
  billing: boolean;
  active: boolean;
  status: string | null;
  currentPeriodEnd: number | null;
}

export interface RemoteStatus {
  version: number;
  sha256: string;
  size: number;
  updatedAt: string;
}

export interface PushResult {
  ok: boolean;
  /** On success, the new server version; on conflict, the server's current version. */
  version: number;
  conflict: boolean;
}

export type PullResult =
  | { ok: true; version: number; wroteVault: boolean }
  | { ok: false; reason: 'no-remote' };

export type SyncState = 'no-config' | 'no-remote' | 'no-local' | 'in-sync' | 'ahead' | 'behind';

// --- raw transport ---

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function remoteStatus(serverUrl: string, token: string): Promise<RemoteStatus | null> {
  const res = await fetch(`${serverUrl}/api/status`, {
    headers: authHeaders(token),
    redirect: 'error',
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (res.status === 402) throw new SubscriptionRequiredError();
  if (!res.ok) throw new Error(`Sync server returned HTTP ${res.status} on status.`);
  const body = (await res.json()) as RemoteStatus;
  return body;
}

async function pullBlob(
  serverUrl: string,
  token: string,
): Promise<{ blob: Buffer; version: number; sha256: string } | null> {
  const res = await fetch(`${serverUrl}/api/blob`, {
    headers: authHeaders(token),
    redirect: 'error',
    signal: AbortSignal.timeout(BLOB_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (res.status === 402) throw new SubscriptionRequiredError();
  if (!res.ok) throw new Error(`Sync server returned HTTP ${res.status} on pull.`);
  const blob = Buffer.from(await res.arrayBuffer());
  const version = Number(res.headers.get('x-version') ?? '0');
  const sha256 = res.headers.get('x-sha256') ?? '';
  return { blob, version, sha256 };
}

async function pushBlob(
  serverUrl: string,
  token: string,
  blob: Buffer,
  baseVersion: number,
): Promise<PushResult> {
  const res = await fetch(`${serverUrl}/api/blob`, {
    method: 'PUT',
    headers: {
      ...authHeaders(token),
      'content-type': 'application/octet-stream',
      'x-base-version': String(baseVersion),
    },
    body: blob,
    redirect: 'error',
    signal: AbortSignal.timeout(BLOB_TIMEOUT_MS),
  });
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { version?: number };
    return { ok: false, conflict: true, version: body.version ?? baseVersion };
  }
  if (res.status === 402) throw new SubscriptionRequiredError();
  if (!res.ok) throw new Error(`Sync server returned HTTP ${res.status} on push.`);
  const body = (await res.json()) as { version: number };
  return { ok: true, conflict: false, version: body.version };
}

// --- helpers ---

function requireConfig(): SyncConfig {
  const config = loadSyncConfig();
  if (!config) {
    throw new Error('Sync is not configured. Run: northkeep sync config --server <url>');
  }
  assertSyncUrl(config.serverUrl);
  return config;
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** A well-formed vault blob starts with the NKV1 magic and carries a full header. */
function isVaultBlob(blob: Buffer): boolean {
  return blob.length >= NKV_HEADER_LENGTH && blob.subarray(0, 4).equals(NKV_MAGIC);
}

// --- high-level operations ---

/**
 * Push the local vault to the server. Reads the raw `.nkv` bytes under the
 * vault file lock (so a concurrent save can't hand us a half-written file) and
 * uploads them with the last-known version as the optimistic-concurrency base.
 * A 409 means another machine pushed first — the caller must pull, then push.
 */
export async function pushVault(options: {
  vaultPath: string;
  deviceSecret: Buffer;
}): Promise<PushResult> {
  const config = requireConfig();
  const { token } = deriveSyncCreds(options.deviceSecret);
  return withFileLock(options.vaultPath, async () => {
    if (!fs.existsSync(options.vaultPath)) {
      throw new Error('No local vault to push. Run "northkeep init" first.');
    }
    const blob = fs.readFileSync(options.vaultPath);
    if (!isVaultBlob(blob)) throw new Error('Local vault file is not a Northkeep vault.');
    if (blob.length > MAX_BLOB_BYTES) {
      throw new Error(
        `Vault is ${(blob.length / 1024 / 1024).toFixed(1)} MB, over the ${MAX_BLOB_BYTES / 1024 / 1024} MB sync limit.`,
      );
    }
    const result = await pushBlob(config.serverUrl, token, blob, config.lastVersion);
    if (result.ok) {
      saveSyncConfig({ ...config, lastVersion: result.version, lastSyncedAt: new Date().toISOString() });
    }
    return result;
  });
}

/**
 * Pull the server's vault and install it locally. CRITICAL SAFETY (ADR 0009):
 * a pull must never destroy a good local vault. The downloaded blob is
 * verified structurally + by transport hash, written to a temp file, and — if
 * a local vault already exists — proven to OPEN with the caller's master key
 * before it is swapped in (the old vault is kept as `.nkv.bak`). A corrupt
 * download or a malicious server serving garbage is thus rejected without
 * touching the existing vault. On a fresh machine (no local vault) there is
 * nothing to protect, so the verified blob is written directly.
 */
export async function pullVault(options: {
  vaultPath: string;
  deviceSecret: Buffer;
  /** Master key for open-verify when a local vault exists (pass a copy — openWithKey zeroes it). */
  masterKey?: Buffer;
}): Promise<PullResult> {
  const config = requireConfig();
  const { token } = deriveSyncCreds(options.deviceSecret);
  return withFileLock(options.vaultPath, async () => {
    const pulled = await pullBlob(config.serverUrl, token);
    if (pulled === null) return { ok: false, reason: 'no-remote' };

    if (!isVaultBlob(pulled.blob)) {
      throw new Error('Downloaded blob is not a Northkeep vault (corrupt download or wrong server).');
    }
    // Transport integrity only — the server supplies this sha, so it catches a
    // truncated/corrupted download, NOT a malicious server (which can serve a
    // blob + matching sha). The real defense against a hostile blob is the
    // open-verify below; the sha is a cheap early-out for honest corruption.
    if (pulled.sha256 && sha256Hex(pulled.blob) !== pulled.sha256) {
      throw new Error('Downloaded vault failed its integrity check (corrupt download). Nothing was changed.');
    }

    const tmpPath = `${options.vaultPath}.pulled.tmp`;
    fs.writeFileSync(tmpPath, pulled.blob, { mode: 0o600 });
    const localExists = fs.existsSync(options.vaultPath);
    try {
      if (localExists) {
        if (!options.masterKey) {
          throw new Error(
            'A local vault exists but no key was provided to verify the pulled vault before replacing it.',
          );
        }
        // Prove the pulled blob opens with our key BEFORE replacing the good vault.
        try {
          Vault.openWithKey(tmpPath, Buffer.from(options.masterKey)).close();
        } catch (err) {
          if (err instanceof VaultAuthError) {
            throw new Error(
              'The pulled vault does not open with your key — refusing to replace your local vault. ' +
                '(Wrong device secret/passphrase, a different account, or a bad download.)',
            );
          }
          throw err;
        }
        fs.copyFileSync(options.vaultPath, `${options.vaultPath}.bak`);
      }
      fs.renameSync(tmpPath, options.vaultPath);
    } finally {
      if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true });
    }

    saveSyncConfig({ ...config, lastVersion: pulled.version, lastSyncedAt: new Date().toISOString() });
    return { ok: true, version: pulled.version, wroteVault: true };
  });
}

/** Compare local state to the server without changing anything. */
export async function syncState(options: {
  vaultPath: string;
  deviceSecret: Buffer;
}): Promise<{ state: SyncState; localVersion: number; remoteVersion: number | null }> {
  const config = loadSyncConfig();
  if (!config) return { state: 'no-config', localVersion: 0, remoteVersion: null };
  const { token } = deriveSyncCreds(options.deviceSecret);
  const remote = await remoteStatus(config.serverUrl, token);
  const localExists = fs.existsSync(options.vaultPath);
  if (remote === null) {
    return { state: localExists ? 'no-remote' : 'no-config', localVersion: config.lastVersion, remoteVersion: null };
  }
  if (!localExists) return { state: 'no-local', localVersion: config.lastVersion, remoteVersion: remote.version };
  const state: SyncState =
    config.lastVersion === remote.version ? 'in-sync' : config.lastVersion > remote.version ? 'ahead' : 'behind';
  return { state, localVersion: config.lastVersion, remoteVersion: remote.version };
}

// --- billing (M5b) ---

/** This account's subscription status on the configured server. */
export async function subscriptionStatus(options: { deviceSecret: Buffer }): Promise<SubscriptionStatus> {
  const config = requireConfig();
  const { token } = deriveSyncCreds(options.deviceSecret);
  const res = await fetch(`${config.serverUrl}/api/subscription`, {
    headers: authHeaders(token),
    redirect: 'error',
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
  });
  // 404 = this server has no billing route (self-host / open); billing is off.
  if (res.status === 404) return { billing: false, active: false, status: null, currentPeriodEnd: null };
  if (!res.ok) throw new Error(`Sync server returned HTTP ${res.status} on subscription.`);
  const b = (await res.json()) as { active: boolean; status: string | null; current_period_end: number | null };
  return { billing: true, active: b.active, status: b.status, currentPeriodEnd: b.current_period_end };
}

/** A Stripe-hosted Checkout URL for this account to subscribe. Open it in a browser. */
export async function checkoutUrl(options: { deviceSecret: Buffer }): Promise<string> {
  const config = requireConfig();
  const { token } = deriveSyncCreds(options.deviceSecret);
  const res = await fetch(`${config.serverUrl}/api/checkout`, {
    method: 'POST',
    headers: authHeaders(token),
    redirect: 'error',
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
  });
  if (res.status === 404) throw new Error('This sync server does not offer subscriptions (billing is off).');
  if (!res.ok) throw new Error(`Sync server returned HTTP ${res.status} on checkout.`);
  const b = (await res.json()) as { url?: string };
  if (!b.url) throw new Error('Sync server did not return a checkout URL.');
  return b.url;
}

/** A Stripe billing-portal URL to manage/cancel, or null if there's no subscription. */
export async function portalUrl(options: { deviceSecret: Buffer }): Promise<string | null> {
  const config = requireConfig();
  const { token } = deriveSyncCreds(options.deviceSecret);
  const res = await fetch(`${config.serverUrl}/api/portal`, {
    method: 'POST',
    headers: authHeaders(token),
    redirect: 'error',
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
  });
  if (res.status === 404) return null; // no subscription to manage, or billing off
  if (!res.ok) throw new Error(`Sync server returned HTTP ${res.status} on portal.`);
  const b = (await res.json()) as { url?: string };
  return b.url ?? null;
}
