/**
 * OAuth Client ID Metadata Documents (CIMD).
 *
 * A client may use an https URL as its client_id. We fetch that URL once and
 * treat the JSON as the client registration. This is a new outbound request,
 * so the URL is checked before any connection: https on port 443, no
 * credentials, no private or loopback address, and redirects are not followed.
 * The address check happens before the connection, so a name that changes
 * address in between is still possible. That residual is stated in KNOWN-LIMITS.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

const MAX_DOCUMENT_BYTES = 16 * 1024;
const FETCH_TIMEOUT_MS = 5_000;
const SUCCESS_TTL_MS = 10 * 60 * 1000;
const FAILURE_TTL_MS = 15_000;
const CACHE_MAX = 128;
const SUPPORTED_GRANTS = ['authorization_code', 'refresh_token'];

export type CimdLookup = (clientId: string) => Promise<OAuthClientInformationFull | undefined>;

export class CimdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CimdError';
  }
}

export interface CimdDeps {
  fetch: typeof fetch;
  lookupHost: (hostname: string) => Promise<string[]>;
  now: () => number;
}

interface CacheEntry {
  expiresAt: number;
  value: OAuthClientInformationFull | null;
}

const cache = new Map<string, CacheEntry>();

export function clearCimdCache(): void {
  cache.clear();
}

function remember(key: string, value: OAuthClientInformationFull | null, now: number, ttl: number): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { expiresAt: now + ttl, value });
}

function isBlockedV4(ip: string): boolean {
  const parts = ip.split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const a = parts[0] as number;
  const b = parts[1] as number;
  const c = parts[2] as number;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && (b === 18 || (b === 51 && c === 100))) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedV6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === '::' || s === '::1') return true;
  if (s.startsWith('::ffff:')) {
    const mapped = s.slice('::ffff:'.length);
    return isIP(mapped) === 4 ? isBlockedV4(mapped) : true;
  }
  const head = s.split(':')[0] ?? '';
  if (head.startsWith('fc') || head.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(head) || head.startsWith('fec')) return true;
  if (head.startsWith('ff')) return true;
  if (s.startsWith('2001:db8')) return true;
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  if (isIP(ip) === 4) return isBlockedV4(ip);
  if (isIP(ip) === 6) return isBlockedV6(ip);
  return true;
}

function hostnameBlockedWithoutDns(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  const kind = isIP(host);
  if (kind === 4 || kind === 6) return isBlockedAddress(host);
  if (!host.includes('.')) return true;
  return false;
}

/** True when `clientId` is an https URL we are willing to try to fetch. */
export function isCimdClientId(clientId: string): boolean {
  if (clientId.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return false;
  if (url.port !== '' && url.port !== '443') return false;
  return !hostnameBlockedWithoutDns(url.hostname);
}

function isAllowedRedirect(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
}

function asClient(clientId: string, body: unknown): OAuthClientInformationFull {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CimdError('Client metadata was not a JSON object.');
  const doc = body as Record<string, unknown>;
  if (doc.client_id !== clientId) throw new CimdError('client_id does not match the document URL.');
  if (doc.client_secret !== undefined) throw new CimdError('A client metadata document cannot carry a client secret.');
  if (!Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0 || doc.redirect_uris.length > 16) {
    throw new CimdError('redirect_uris must be a short non-empty list.');
  }
  const redirectUris: string[] = [];
  for (const uri of doc.redirect_uris) {
    if (typeof uri !== 'string' || !isAllowedRedirect(uri)) throw new CimdError('A redirect URI was refused.');
    redirectUris.push(uri);
  }
  if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== 'none') {
    throw new CimdError('Client metadata must use token_endpoint_auth_method none.');
  }
  // A document may list grants we do not offer (Claude lists jwt-bearer). We keep only ours,
  // and the token endpoint answers anything else with unsupported_grant_type.
  const listed = doc.grant_types === undefined ? ['authorization_code', 'refresh_token'] : doc.grant_types;
  if (!Array.isArray(listed) || listed.length > 16 || listed.some((g) => typeof g !== 'string')) {
    throw new CimdError('grant_types were refused.');
  }
  const grants = SUPPORTED_GRANTS.filter((g) => listed.includes(g));
  if (!grants.includes('authorization_code')) throw new CimdError('grant_types were refused.');
  const responses = doc.response_types === undefined ? ['code'] : doc.response_types;
  if (!Array.isArray(responses) || responses.some((g) => g !== 'code')) throw new CimdError('response_types were refused.');
  const name = doc.client_name === undefined ? undefined : doc.client_name;
  if (name !== undefined && (typeof name !== 'string' || name.length === 0 || name.length > 200 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(name))) {
    throw new CimdError('client_name was refused.');
  }
  return {
    client_id: clientId,
    client_name: name,
    redirect_uris: redirectUris,
    grant_types: grants,
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

async function readLimited(resp: Response): Promise<string> {
  const declared = Number(resp.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_DOCUMENT_BYTES) throw new CimdError('Client metadata is too large.');
  const reader = resp.body?.getReader();
  if (!reader) throw new CimdError('Client metadata was empty.');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    total += step.value.byteLength;
    if (total > MAX_DOCUMENT_BYTES) {
      await reader.cancel();
      throw new CimdError('Client metadata is too large.');
    }
    chunks.push(step.value);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

async function assertPublicHost(url: URL, lookupHost: CimdDeps['lookupHost']): Promise<void> {
  if (hostnameBlockedWithoutDns(url.hostname)) throw new CimdError('That client metadata host was refused.');
  if (isIP(url.hostname) !== 0) return;
  let addresses: string[];
  try {
    addresses = await lookupHost(url.hostname);
  } catch {
    throw new CimdError('The client metadata host did not resolve.');
  }
  if (addresses.length === 0 || addresses.some((ip) => isBlockedAddress(ip))) {
    throw new CimdError('The client metadata host resolved to a refused address.');
  }
}

export async function fetchClientMetadataDocument(clientId: string, deps: CimdDeps = defaultCimdDeps()): Promise<OAuthClientInformationFull> {
  if (!isCimdClientId(clientId)) throw new CimdError('client_id is not a client metadata URL.');
  const now = deps.now();
  const hit = cache.get(clientId);
  if (hit && hit.expiresAt > now) {
    if (hit.value) return hit.value;
    throw new CimdError('Client metadata was refused.');
  }
  const url = new URL(clientId);
  try {
    await assertPublicHost(url, deps.lookupHost);
    const resp = await deps.fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (resp.status < 200 || resp.status >= 300) throw new CimdError('Client metadata was not available.');
    const text = await readLimited(resp);
    const parsed: unknown = JSON.parse(text);
    const client = asClient(clientId, parsed);
    remember(clientId, client, now, SUCCESS_TTL_MS);
    return client;
  } catch (err) {
    remember(clientId, null, now, FAILURE_TTL_MS);
    if (err instanceof CimdError) throw err;
    throw new CimdError('Client metadata could not be read.');
  }
}

function defaultCimdDeps(): CimdDeps {
  return {
    fetch: globalThis.fetch,
    lookupHost: async (hostname: string) => {
      const found = await lookup(hostname, { all: true, verbatim: true });
      return found.map((row) => row.address);
    },
    now: Date.now,
  };
}

/** Storage misses call this. A non-URL client id returns undefined without a fetch. */
export async function resolveCimdClient(clientId: string, deps?: CimdDeps): Promise<OAuthClientInformationFull | undefined> {
  if (!isCimdClientId(clientId)) return undefined;
  try {
    return await fetchClientMetadataDocument(clientId, deps);
  } catch {
    return undefined;
  }
}
