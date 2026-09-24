/**
 * OAuth client secrets stored as a hash only (ADR 0061 Decision 2).
 *
 * The SDK treats a client as confidential only when getClient returns a truthy
 * `client_secret`, and compares it with `!==`. So the stored JSON carries a
 * random sentinel instead of the secret (old code then fails closed), the hash
 * column carries sha256hex(secret), and getClient hands the SDK a value bound
 * to a per-process key. Our middleware verifies the presented secret against
 * the hash in constant time and swaps in that bound value; if it is ever
 * skipped, the SDK's compare fails. Nothing stored works as a secret.
 */

import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { constantTimeEqual, keyedHashHex, randomBytesSodium } from './crypto.js';
import { sha256hex } from './hash.js';
import type { ConnectorStorage } from './storage.js';

export const SECRET_SENTINEL_PREFIX = 'nkcs-scrubbed:';
export const BOUND_SECRET_PREFIX = 'nkcsb1:';
const UNUSABLE_SECRET_PREFIX = 'nkcsx:';

export type ClientSecretState =
  | { kind: 'public' }
  | { kind: 'confidential'; hash: string }
  | { kind: 'unusable' };

/** A fresh sentinel for the stored JSON: never equal to any issued secret. */
export async function newSecretSentinel(): Promise<string> {
  return SECRET_SENTINEL_PREFIX + Buffer.from(await randomBytesSodium(32)).toString('hex');
}

/**
 * Which kind of client this row is. The hash column wins; otherwise a
 * not-yet-migrated plaintext secret in the JSON still makes it confidential.
 * A sentinel with no hash (only a direct DB writer can make one) is
 * confidential and unusable, never public.
 */
export function clientSecretState(info: OAuthClientInformationFull, columnHash: string | null): ClientSecretState {
  if (columnHash) return { kind: 'confidential', hash: columnHash };
  const s = (info as { client_secret?: unknown }).client_secret;
  if (typeof s === 'string' && s.length > 0) {
    if (s.startsWith(SECRET_SENTINEL_PREFIX)) return { kind: 'unusable' };
    return { kind: 'confidential', hash: sha256hex(s) };
  }
  return { kind: 'public' };
}

/** Per-instance binding key: 32 random bytes, never stored or logged. */
export class ClientSecretBinder {
  private keyP: Promise<Uint8Array> | null = null;

  constructor(key?: Uint8Array) {
    if (key) this.keyP = Promise.resolve(key);
  }

  private key(): Promise<Uint8Array> {
    if (!this.keyP) this.keyP = randomBytesSodium(32);
    return this.keyP;
  }

  async bound(hash: string): Promise<string> {
    return BOUND_SECRET_PREFIX + (await keyedHashHex(await this.key(), hash));
  }

  /** The client object the SDK sees. */
  async present(info: OAuthClientInformationFull, columnHash: string | null): Promise<OAuthClientInformationFull> {
    const state = clientSecretState(info, columnHash);
    const { client_secret: _stored, ...rest } = info;
    if (state.kind === 'public') return rest as OAuthClientInformationFull;
    if (state.kind === 'unusable') {
      const never = UNUSABLE_SECRET_PREFIX + Buffer.from(await randomBytesSodium(32)).toString('hex');
      return { ...rest, client_secret: never } as OAuthClientInformationFull;
    }
    return { ...rest, client_secret: await this.bound(state.hash) } as OAuthClientInformationFull;
  }
}

/** Constant-time check of a presented secret against a stored sha256 hex hash. */
export async function secretMatchesHash(presented: string, hash: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(hash)) return false;
  return constantTimeEqual(Buffer.from(sha256hex(presented), 'hex'), Buffer.from(hash, 'hex'));
}

/** What registration persists: the sentinel in the JSON, the hash in the column. */
export async function scrubForStorage(
  client: OAuthClientInformationFull,
): Promise<{ stored: OAuthClientInformationFull; hash: string | null }> {
  if (typeof client.client_secret !== 'string' || client.client_secret.length === 0) {
    return { stored: client, hash: null };
  }
  return {
    stored: { ...client, client_secret: await newSecretSentinel() },
    hash: sha256hex(client.client_secret),
  };
}

export interface ClientSecretMigrationResult {
  migrated: number;
  unparsable: number;
  casMissed: number;
  sentinelNoHash: number;
  plaintextRemaining: number;
}

type Parsed = { ok: true; obj: Record<string, unknown> } | { ok: false };

function parseObject(json: string): Parsed {
  try {
    const v: unknown = JSON.parse(json);
    if (v && typeof v === 'object' && !Array.isArray(v)) return { ok: true, obj: v as Record<string, unknown> };
    return { ok: true, obj: {} };
  } catch {
    return { ok: false };
  }
}

function plaintextSecret(obj: Record<string, unknown>): string | null {
  const s = obj.client_secret;
  if (typeof s !== 'string' || s.length === 0 || s.startsWith(SECRET_SENTINEL_PREFIX)) return null;
  return s;
}

/**
 * Hash-then-scrub every row still holding a plaintext secret. Decides on the
 * PARSED top-level value, never a text search. One compare-and-swap UPDATE per
 * row, so concurrent runs converge and a row is never scrubbed without its hash.
 */
export async function migrateClientSecrets(storage: ConnectorStorage): Promise<ClientSecretMigrationResult> {
  const out: ClientSecretMigrationResult = {
    migrated: 0,
    unparsable: 0,
    casMissed: 0,
    sentinelNoHash: 0,
    plaintextRemaining: 0,
  };
  for (const row of await storage.listClientSecretCandidates()) {
    const parsed = parseObject(row.clientJson);
    if (!parsed.ok) {
      out.unparsable++;
      continue;
    }
    const s = parsed.obj.client_secret;
    if (typeof s === 'string' && s.startsWith(SECRET_SENTINEL_PREFIX) && !row.clientSecretHash) {
      out.sentinelNoHash++;
      continue;
    }
    const secret = plaintextSecret(parsed.obj);
    if (secret === null) continue;
    const next = JSON.stringify({ ...parsed.obj, client_secret: await newSecretSentinel() });
    const swapped = await storage.casClientRow(row.clientId, row.clientJson, next, sha256hex(secret));
    if (swapped) out.migrated++;
    else out.casMissed++;
  }
  for (const row of await storage.listClientSecretCandidates()) {
    const parsed = parseObject(row.clientJson);
    if (parsed.ok && plaintextSecret(parsed.obj) !== null) out.plaintextRemaining++;
  }
  return out;
}
