import type { Vault } from '@northkeep/core';
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

function authHeaders(deviceSecret: Buffer): Record<string, string> {
  return { authorization: `Bearer ${deriveConnectorToken(deviceSecret)}` };
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
    headers: { ...authHeaders(opts.deviceSecret), 'content-type': 'application/json' },
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

/**
 * POST /pair/start -> the 8-char single-use pairing code the user types into the
 * AI app's OAuth consent page. Bearer connector_token; the server binds the
 * eventual OAuth grant to this account.
 */
export async function startPairing(opts: { server: string; deviceSecret: Buffer }): Promise<string> {
  const server = normalizeServer(opts.server);
  const res = await fetch(`${server}/pair/start`, {
    method: 'POST',
    headers: { ...authHeaders(opts.deviceSecret), 'content-type': 'application/json' },
    body: '{}',
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Connector server returned HTTP ${res.status} on pairing.`);
  const body = (await res.json()) as { pairing_code?: string };
  if (!body.pairing_code) throw new Error('Connector server did not return a pairing code.');
  return body.pairing_code;
}
