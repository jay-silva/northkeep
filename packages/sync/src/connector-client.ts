import type { MemoryType, Vault } from '@northkeep/core';
import { deriveConnectorToken } from './creds.js';
import { assertConnectorUrl } from './connector-config.js';

/**
 * The hosted-connector client (ADR 0019, phase C2). Pushes the user's REAL vault
 * entries for the scopes they marked Shared to the connector server, so their
 * cloud AI apps can read them. Authenticates with the SAME connector token used
 * for /pair/start (Bearer; the server keys accounts on its sha256).
 *
 * Transport conventions mirror the sync client: `redirect:'error'` (a redirect
 * could re-send the token/content to an attacker's Location), `AbortSignal.
 * timeout`, and status-only error messages (never echo a response body).
 */

const TIMEOUT_MS = 30_000;

/** Entry as pushed on the wire — byte-faithful to the vault (id/hash/scope/type/content). */
export interface PushEntry {
  entry_id: string;
  entry_hash: string;
  scope: string;
  type: string;
  content: string;
}

export interface ManifestEntry {
  entry_id: string;
  entry_hash: string;
  scope: string;
}

export interface PushSharedResult {
  /** How many entries were sent (the server made these scopes match exactly). */
  pushed: number;
  /** The scopes reconciled. */
  scopes: string[];
}

function authHeaders(deviceSecret: Buffer, entitlement?: string): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${deriveConnectorToken(deviceSecret)}` };
  // The billing gate (ADR 0019 C3): the desktop forwards the anonymous
  // "active subscriber" attestation it fetched from the sync server. Absent on a
  // self-hosted / ungated connector — the header is optional.
  if (entitlement) headers['x-nb-entitlement'] = entitlement;
  return headers;
}

/**
 * Fetch an anonymous entitlement attestation from the SYNC server (authenticated
 * with the sync token), to forward to the connector's billing gate. Returns null
 * if the sync server has no entitlement bridge configured (404) — the connector
 * is then either ungated or gates by its own allowlist.
 */
export async function fetchEntitlement(opts: { syncServer: string; syncToken: string }): Promise<string | null> {
  const server = opts.syncServer.replace(/\/$/, '');
  const res = await fetch(`${server}/api/entitlement`, {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.syncToken}`, 'content-type': 'application/json' },
    body: '{}',
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Sync server returned HTTP ${res.status} on entitlement.`);
  const body = (await res.json()) as { entitlement?: string };
  return body.entitlement ?? null;
}

function normalizeServer(server: string): string {
  return assertConnectorUrl(server).toString().replace(/\/$/, '');
}

/**
 * "Make these scopes match": read the live (non-forgotten, non-superseded)
 * entries in each shared scope from the OPEN vault and PUT them so the server's
 * rows for those scopes become EXACTLY these. A vault entry the user forgot or
 * removed disappears server-side on the next push.
 *
 * `scopes` MUST be the user's configured shared-scope list, not the scopes that
 * happen to have entries — a scope emptied of its last memory must still be sent
 * so the server clears its now-stale rows.
 */
export async function pushSharedScopes(opts: {
  server: string;
  deviceSecret: Buffer;
  scopes: string[];
  vault: Vault;
  /** Optional entitlement attestation forwarded to the connector's billing gate. */
  entitlement?: string;
}): Promise<PushSharedResult> {
  const server = normalizeServer(opts.server);
  const scopes = [...new Set(opts.scopes)];
  const entries: PushEntry[] = [];
  for (const scope of scopes) {
    // list() excludes forgotten + superseded by default → live entries only.
    for (const e of opts.vault.list({ scope })) {
      entries.push({
        entry_id: e.id,
        entry_hash: e.entry_hash,
        scope: e.scope,
        type: e.type,
        content: e.content,
      });
    }
  }
  const res = await fetch(`${server}/client/entries`, {
    method: 'PUT',
    headers: { ...authHeaders(opts.deviceSecret, opts.entitlement), 'content-type': 'application/json' },
    body: JSON.stringify({ scopes, entries }),
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 413) {
    throw new Error(
      'The connector server rejected the push: over the sharing caps (too many shared memories, or a memory is too large).',
    );
  }
  if (res.status === 401) throw new Error('The connector server rejected the connector token (401).');
  if (!res.ok) throw new Error(`Connector server returned HTTP ${res.status} on push.`);
  return { pushed: entries.length, scopes };
}

/** Unshare a scope: DELETE all its rows server-side and record a tombstone. */
export async function unshareScope(opts: {
  server: string;
  deviceSecret: Buffer;
  scope: string;
}): Promise<{ deleted: number }> {
  const server = normalizeServer(opts.server);
  const res = await fetch(`${server}/client/scope/${encodeURIComponent(opts.scope)}`, {
    method: 'DELETE',
    headers: authHeaders(opts.deviceSecret),
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Connector server returned HTTP ${res.status} on unshare.`);
  const body = (await res.json().catch(() => ({}))) as { deleted?: number };
  return { deleted: body.deleted ?? 0 };
}

/** The server's current shared-scope manifest for this account (for diffing/status). */
export async function getManifest(opts: {
  server: string;
  deviceSecret: Buffer;
}): Promise<ManifestEntry[]> {
  const server = normalizeServer(opts.server);
  const res = await fetch(`${server}/client/manifest`, {
    headers: authHeaders(opts.deviceSecret),
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Connector server returned HTTP ${res.status} on manifest.`);
  const body = (await res.json()) as { entries?: ManifestEntry[] };
  return body.entries ?? [];
}

/** One connector-born memory awaiting down-sync into the vault. */
interface PendingEntry {
  server_id: string;
  scope: string;
  type: string;
  content: string;
}

export interface DownSyncResult {
  /** New vault entries created from connector-born memories. */
  added: number;
  /** Vault entries tombstoned to satisfy a queued forget. */
  forgotten: number;
  /** Connector-born memories skipped because an identical live vault entry existed. */
  deduped: number;
}

/**
 * Write-back down-sync (ADR 0019, phase C3): pull the memories the user created
 * INSIDE an AI app (via memory_remember) and the forgets they issued there, apply
 * them to the OPEN vault, then ack the server so it stops re-sending them.
 *
 * Invariants this guarantees: verifyChain() stays true (every write is a normal
 * append/tombstone); no duplicate vault entry per server_id across re-runs (the
 * server only lists still-pending rows, and we dedupe on identical (scope,
 * content)); no resurrection of a forgotten entry (forget is permanent and we
 * ack the forget so the server row is deleted). The CALLER then re-runs
 * pushSharedScopes so each new row is rehashed server-side under its vault id.
 */
export async function downSyncConnector(opts: {
  server: string;
  deviceSecret: Buffer;
  vault: Vault;
  /** Optional entitlement attestation forwarded to the connector's billing gate. */
  entitlement?: string;
}): Promise<DownSyncResult> {
  const server = normalizeServer(opts.server);
  const clientLabel = new URL(server).hostname;

  const pendingRes = await fetch(`${server}/client/pending`, {
    headers: authHeaders(opts.deviceSecret, opts.entitlement),
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (pendingRes.status === 401) throw new Error('The connector server rejected the connector token (401).');
  if (pendingRes.status === 402) {
    throw new Error('The connector server requires an active subscription (402) to down-sync.');
  }
  if (!pendingRes.ok) throw new Error(`Connector server returned HTTP ${pendingRes.status} on pending.`);
  const pending = (await pendingRes.json()) as { entries?: PendingEntry[]; forgets?: Array<{ entry_id: string }> };
  const entries = pending.entries ?? [];
  const forgets = pending.forgets ?? [];

  const acked: Array<{ server_id: string; local_entry_id: string }> = [];
  let added = 0;
  let deduped = 0;

  for (const e of entries) {
    if (!e.server_id || !e.content) continue;
    // Dedupe against LIVE (non-forgotten, non-superseded) entries in the scope so
    // a re-run never creates a second copy of the same connector memory.
    const dup = opts.vault.list({ scope: e.scope }).find((v) => v.content === e.content);
    if (dup) {
      acked.push({ server_id: e.server_id, local_entry_id: dup.id });
      deduped++;
      continue;
    }
    const created = opts.vault.remember({
      content: e.content,
      type: e.type as MemoryType,
      scope: e.scope,
      source: `connector:${clientLabel}`,
      metadata: { connector: { server_id: e.server_id } },
    });
    acked.push({ server_id: e.server_id, local_entry_id: created.id });
    added++;
  }

  // Apply forgets: tombstone the vault entry if it is still live. Every forget is
  // acked regardless so the server drains its queue and deletes the row (no
  // resurrection on a later push).
  let forgotten = 0;
  const forgetIds: string[] = [];
  for (const f of forgets) {
    const id = f.entry_id;
    if (!id) continue;
    forgetIds.push(id);
    const live = opts.vault.list().find((v) => v.id === id);
    if (live) {
      opts.vault.forget(id);
      forgotten++;
    }
  }

  // Persist BEFORE acking: if the ack (or process) fails after save, the server
  // simply re-sends and the dedupe/forget-idempotence make the retry a no-op.
  opts.vault.save();

  const ackRes = await fetch(`${server}/client/ack`, {
    method: 'POST',
    headers: { ...authHeaders(opts.deviceSecret, opts.entitlement), 'content-type': 'application/json' },
    body: JSON.stringify({ acked, forgets: forgetIds }),
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!ackRes.ok) throw new Error(`Connector server returned HTTP ${ackRes.status} on ack.`);

  return { added, forgotten, deduped };
}

/**
 * POST /pair/start -> the 8-char single-use pairing code the user types into the
 * AI app's OAuth consent page. Bearer connector_token; the server binds the
 * eventual OAuth grant to this account.
 */
export async function startPairing(opts: {
  server: string;
  deviceSecret: Buffer;
  entitlement?: string;
}): Promise<string> {
  const server = normalizeServer(opts.server);
  const res = await fetch(`${server}/pair/start`, {
    method: 'POST',
    headers: { ...authHeaders(opts.deviceSecret, opts.entitlement), 'content-type': 'application/json' },
    body: '{}',
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Connector server returned HTTP ${res.status} on pairing.`);
  const body = (await res.json()) as { pairing_code?: string };
  if (!body.pairing_code) throw new Error('Connector server did not return a pairing code.');
  return body.pairing_code;
}
