import { createHash } from 'node:crypto';
import type { MemoryEntry, Vault } from '@northkeep/core';
import { loadSyncConfig } from './config.js';
import { isAutoSyncVault, pushVault, syncState, type PushResult } from './client.js';
import { pushSharedScopes, type PushSharedResult, type VaultStamp } from './connector-client.js';
import { markConnectorPushed } from './connector-config.js';

/**
 * ADR 0063 D5 on this device: every push to Cloud Connect says which
 * vault-sync copy it was taken from, and is sent only from a device that
 * holds the newest copy. Node-only (the phone does not push automatically).
 */

/** The `vault.server` value: the first 16 hex of sha256 over the sync server URL exactly as sync.json stores it. */
export function vaultServerHash(serverUrl: string): string {
  return createHash('sha256').update(serverUrl, 'utf8').digest('hex').slice(0, 16);
}

export type PushBlockedReason = 'behind' | 'diverged' | 'other-vault' | 'moved';

const BLOCKED_MESSAGES: Record<PushBlockedReason, string> = {
  behind: 'This Mac is behind your other devices, so Cloud Connect was not updated. Sync this Mac first (northkeep sync pull), then push again.',
  diverged: 'This Mac and your other devices both have changes, so Cloud Connect was not updated. Sync this Mac first (northkeep sync pull), then push again.',
  'other-vault': 'Cloud Connect is updated from your main vault only, and this command used another vault file.',
  moved: 'Another device synced while this Mac was pushing, so Cloud Connect was not updated. Sync this Mac first, then push again.',
};

/** A manual push refused because this device may not hold the newest vault (D5). Nothing was sent. */
export class ConnectorPushBlockedError extends Error {
  readonly reason: PushBlockedReason;
  constructor(reason: PushBlockedReason) {
    super(BLOCKED_MESSAGES[reason]);
    this.name = 'ConnectorPushBlockedError';
    this.reason = reason;
  }
}

/**
 * Refuse before a down-sync or resolve writes anything when the push that
 * must follow it would be refused: a local write on a device that is behind
 * would only make it diverged. No vault sync configured: nothing to check.
 */
export async function assertDeviceCanPush(opts: { vaultPath: string; deviceSecret: Buffer }): Promise<void> {
  if (loadSyncConfig() === null) return;
  if (!isAutoSyncVault(opts.vaultPath)) throw new ConnectorPushBlockedError('other-vault');
  const s = await syncState(opts);
  if (s.state === 'behind') throw new ConnectorPushBlockedError('behind');
  if (s.state === 'diverged') throw new ConnectorPushBlockedError('diverged');
}

/**
 * The stamp for a manual push (Sync now, share add, share push or sync).
 * In sync: the server's version. Ahead: push the vault first and use the
 * version the sync server returns. Behind or diverged: refuse. No vault sync:
 * no stamp. Runs with no vault lock held; `runVaultPush` lets a host route
 * the vault push through its AutoSync engine.
 */
export async function manualVaultStamp(opts: {
  vaultPath: string;
  deviceSecret: Buffer;
  masterKey: Buffer;
  runVaultPush?: (push: () => Promise<PushResult>) => Promise<PushResult>;
}): Promise<VaultStamp | undefined> {
  const config = loadSyncConfig();
  if (config === null) return undefined;
  // Pushing another vault file would overwrite the account's copy on the sync server.
  if (!isAutoSyncVault(opts.vaultPath)) throw new ConnectorPushBlockedError('other-vault');
  const s = await syncState({ vaultPath: opts.vaultPath, deviceSecret: opts.deviceSecret });
  if (s.state === 'in-sync' && s.remoteVersion !== null) return { server: vaultServerHash(config.serverUrl), version: s.remoteVersion };
  if (s.state === 'ahead' || s.state === 'no-remote') {
    const push = () => pushVault({ vaultPath: opts.vaultPath, deviceSecret: opts.deviceSecret, masterKey: Buffer.from(opts.masterKey) });
    const result = await (opts.runVaultPush ? opts.runVaultPush(push) : push());
    if (!result.ok) throw new ConnectorPushBlockedError('moved');
    return { server: vaultServerHash(config.serverUrl), version: result.version };
  }
  throw new ConnectorPushBlockedError(s.state === 'behind' ? 'behind' : 'diverged');
}

/** The shared scopes as they stood under the vault lock, so the upload itself holds no lock. */
export interface SharedSnapshot {
  scopes: string[];
  fingerprint: string;
  source: Pick<Vault, 'list' | 'sharedScopeRows'>;
}

export function snapshotSharedScopes(vault: Vault): SharedSnapshot {
  const scopes = [...new Set(vault.sharedScopes())].sort();
  const byScope = new Map<string, MemoryEntry[]>(scopes.map((scope) => [scope, vault.list({ scope })]));
  const rows = vault.sharedScopeRows();
  const hash = createHash('sha256').update(JSON.stringify(scopes));
  for (const scope of scopes) {
    for (const e of byScope.get(scope) ?? []) hash.update(`\n${e.id} ${e.entry_hash}`);
  }
  return {
    scopes,
    fingerprint: hash.digest('hex'),
    source: {
      list: (filter?: { scope?: string }) => (filter?.scope !== undefined ? (byScope.get(filter.scope) ?? []) : [...byScope.values()].flat()),
      sharedScopeRows: () => rows,
    } as Pick<Vault, 'list' | 'sharedScopeRows'>,
  };
}

/** Push a snapshot; on acceptance record the time and fingerprint. */
export async function pushSnapshot(opts: {
  server: string;
  deviceSecret: Buffer;
  entitlement?: string;
  snapshot: SharedSnapshot;
  vaultStamp?: VaultStamp;
  reset?: boolean;
}): Promise<PushSharedResult> {
  const result = await pushSharedScopes({
    server: opts.server,
    deviceSecret: opts.deviceSecret,
    scopes: opts.snapshot.scopes,
    vault: opts.snapshot.source,
    ...(opts.entitlement ? { entitlement: opts.entitlement } : {}),
    ...(opts.vaultStamp ? { vaultStamp: opts.vaultStamp } : {}),
    ...(opts.reset ? { reset: true } : {}),
  });
  markConnectorPushed(new Date(), opts.snapshot.fingerprint);
  return result;
}

/**
 * A whole manual push in its phases: stamp (maybe pushing the vault), then
 * snapshot under the vault lock, then upload with no lock. Null when nothing
 * is shared.
 */
export async function manualConnectorPush(opts: {
  server: string;
  deviceSecret: Buffer;
  vaultPath: string;
  masterKey: Buffer;
  entitlement?: string;
  reset?: boolean;
  withVault: <T>(fn: (vault: Vault) => T | Promise<T>) => Promise<T>;
  runVaultPush?: (push: () => Promise<PushResult>) => Promise<PushResult>;
}): Promise<PushSharedResult | null> {
  const vaultStamp = await manualVaultStamp(opts);
  const snapshot = await opts.withVault((vault) => snapshotSharedScopes(vault));
  if (snapshot.scopes.length === 0) return null;
  return pushSnapshot({ ...opts, snapshot, ...(vaultStamp ? { vaultStamp } : {}) });
}
