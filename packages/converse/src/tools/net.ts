import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { IncomingMessage } from 'node:http';
import { classifyIpAddress } from '../provider.js';

/**
 * The hardened web egress client (M10b, ADR 0028). Every byte web_fetch ever
 * moves goes through this file, so this is where the SSRF story lives:
 *
 *  1. URL-layer guard (classifyFetchTarget): WHATWG-parse, https only, no
 *     userinfo, ports 443/8443 only, and IP-literal or name-based-local
 *     hostnames must be PUBLIC. Reuses classifyIpAddress from provider.ts —
 *     the SAME loopback/RFC-1918/link-local/ULA/IPv4-mapped parser as the
 *     privacy badge; one classifier, never two that can disagree.
 *  2. DNS-layer guard + PIN (resolvePinned): dns.lookup(host, {all}) FIRST;
 *     if ANY resolved address classifies private, refuse. Then the actual
 *     connection is DIALED TO THAT EXACT VALIDATED ADDRESS via the request's
 *     custom `lookup` override (node:http/https support this natively —
 *     Node's global fetch does not, which is why this file uses the core
 *     modules instead). Host header and TLS SNI still carry the hostname.
 *     Because the socket can only ever reach the address we validated, the
 *     classic TTL-0 DNS-rebinding race (validate A, attacker re-answers B,
 *     client dials B) is CLOSED, not merely narrowed. Residual: we dial the
 *     FIRST resolved address only (no happy-eyeballs fallback), and a server
 *     that is itself a public-facing proxy into a private network is out of
 *     scope (that is the server's egress, not ours). See KNOWN-LIMITS.md.
 *  3. Redirects are manual: every hop re-runs guards 1 and 2 and re-pins,
 *     capped at 5 hops — a public page 302ing to http://169.254.169.254/ is
 *     refused at the hop, not followed.
 *  4. Response hygiene: content-type allowlist checked BEFORE any body byte
 *     is read; streamed byte cap (default 2 MB) that destroys the socket
 *     mid-body and marks the result truncated; one overall deadline (default
 *     25 s) across all hops; fixed UA; `accept-encoding: identity` (no
 *     compression bombs); no cookies, no Authorization, ever — there is no
 *     cookie jar and no credential path into this client by construction.
 */

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 25_000;
const MAX_REDIRECT_HOPS = 5;
const USER_AGENT = 'NorthKeep/1.0';
/** v1 keeps ports simple: standard TLS + the one common alternate. */
const ALLOWED_PORTS: ReadonlySet<string> = new Set(['', '443', '8443']);
const ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'text/html',
  'text/plain',
  'application/json',
  'application/xhtml+xml',
  'text/xml',
]);

export type FetchRefusalCode =
  | 'scheme'
  | 'userinfo'
  | 'private-address'
  | 'bad-port'
  | 'unparseable'
  | 'dns'
  | 'timeout'
  | 'cancelled'
  | 'too-large'
  | 'content-type'
  | 'too-many-redirects'
  // M10d (ADR 0030 decision 1): a redirect arrived on the CREDENTIALED path.
  // A fixed trusted API that 302s is a signal, not a hop to chase — we refuse
  // rather than follow it (with or without the header). Distinct from
  // 'too-many-redirects' so guidance can say "the API redirected", not "loop".
  | 'redirect-refused'
  | 'http-status'
  | 'network';

export class FetchRefusedError extends Error {
  constructor(
    readonly code: FetchRefusalCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'FetchRefusedError';
  }
}

/**
 * TEST-ONLY dependency-injection seam. The SSRF guard refuses loopback by
 * design, and unit/e2e tests run their fake servers ON loopback — so tests
 * (and ONLY tests) inject a resolver/classifier/scheme-relaxation here to
 * point the client at their local fixture while exercising the real pinning,
 * redirect, cap, and timeout code paths. No production code path constructs
 * this object: the registry/CLI wiring never exposes it, and webFetch only
 * threads it through for its own tests.
 */
export interface NetTestOverrides {
  /** Replaces dns.lookup(host, {all:true}). */
  resolver?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  /** Replaces the private-address classifier (both URL and DNS layers). */
  isPrivateAddress?: (ip: string) => boolean;
  /** Allows http: and non-standard ports so a plain local server can serve fixtures. */
  allowHttp?: boolean;
}

/** Fail closed: anything that is not provably a public address is private. */
function defaultIsPrivate(ip: string): boolean {
  const classified = classifyIpAddress(ip);
  return classified === null || classified.tier !== 'bounded';
}

/**
 * URL-layer guard. WHATWG parsing canonicalizes the nasty spellings first
 * (0x7f.1, 2130706433, mixed-case schemes, embedded credentials), so every
 * check below runs on a normalized URL.
 */
export function classifyFetchTarget(
  rawUrl: string,
  overrides?: NetTestOverrides,
): { ok: true; url: URL } | { ok: false; code: FetchRefusalCode; reason: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, code: 'unparseable', reason: 'not a parseable URL' };
  }
  const allowHttp = overrides?.allowHttp === true;
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    return { ok: false, code: 'scheme', reason: `only https is fetched (got "${url.protocol}")` };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, code: 'userinfo', reason: 'URLs with embedded credentials are refused' };
  }
  if (!ALLOWED_PORTS.has(url.port) && !allowHttp) {
    return { ok: false, code: 'bad-port', reason: `port ${url.port} is refused (443 or 8443 only)` };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) !== 0) {
    const isPriv = overrides?.isPrivateAddress ?? defaultIsPrivate;
    if (isPriv(host)) {
      return { ok: false, code: 'private-address', reason: `${host} is a private address` };
    }
  } else if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    // Name-based local hosts are refused unconditionally (even under the test
    // seam — tests use explicit loopback literals, never these names).
    return { ok: false, code: 'private-address', reason: `${host} is a local hostname` };
  }
  return { ok: true, url };
}

/**
 * DNS-layer guard + pin: resolve, refuse if ANY address is private, and
 * return the one address the socket will actually dial.
 */
async function resolvePinned(
  host: string,
  overrides?: NetTestOverrides,
): Promise<{ address: string; family: number }> {
  const literal = net.isIP(host);
  if (literal !== 0) return { address: host, family: literal }; // already validated at the URL layer
  const resolve =
    overrides?.resolver ?? ((h: string) => dns.lookup(h, { all: true, verbatim: true }));
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await resolve(host);
  } catch {
    return Promise.reject(new FetchRefusedError('dns', `could not resolve ${host}`));
  }
  if (addresses.length === 0) throw new FetchRefusedError('dns', `no addresses for ${host}`);
  const isPriv = overrides?.isPrivateAddress ?? defaultIsPrivate;
  for (const a of addresses) {
    if (isPriv(a.address)) {
      // ANY private answer refuses the whole fetch — a mixed public/private
      // answer is exactly what a rebinding/split-horizon attack looks like.
      throw new FetchRefusedError('private-address', `${host} resolves to a private address`);
    }
  }
  return addresses[0]!;
}

/** The default Accept for page fetches (web_fetch). A JSON API (web_search →
 * Brave) overrides it: Brave 422s this multi-type value ("Unable to validate
 * request parameter(s)") and wants application/json — verified against the
 * live API, a mismatch the fake test server could not catch. */
const DEFAULT_ACCEPT = 'text/html, application/xhtml+xml, application/json, text/plain, text/xml';

/** One pinned HTTP(S) request; resolves at response headers. */
function requestOnce(
  url: URL,
  pinned: { address: string; family: number },
  signal: AbortSignal,
  /**
   * M10d (ADR 0030 decision 1): the ONLY credential path in this client. The
   * caller (hardenedFetch) passes this ONLY on the hop whose host already
   * equals the authorized host — the host match is decided ONCE there, so this
   * function just attaches what it is given. The token rides this header only:
   * never a URL, never logged, never returned in the result or an error.
   */
  authToken?: AuthToken,
  accept: string = DEFAULT_ACCEPT,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const headers: Record<string, string> = {
      accept,
      'user-agent': USER_AGENT,
      'accept-encoding': 'identity',
    };
    // Attach the bearer credential under its purpose-named header. This is the
    // sole write of a credential in the whole file; the header name is
    // caller-supplied and distinct from the three fixed headers above, so it
    // never collides with or overwrites one the client already sends.
    if (authToken !== undefined) headers[authToken.headerName] = authToken.value;
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname, // Host header + TLS SNI come from here
        port: url.port !== '' ? Number(url.port) : isHttps ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        signal,
        headers,
        // THE PIN: the socket dials the address we validated seconds ago —
        // whatever DNS says between validation and connect is irrelevant.
        lookup: ((_hostname: string, options: { all?: boolean }, callback: unknown) => {
          if (options.all === true) {
            (callback as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [
              pinned,
            ]);
          } else {
            (callback as (e: null, address: string, family: number) => void)(
              null,
              pinned.address,
              pinned.family,
            );
          }
        }) as net.LookupFunction,
      },
      resolve,
    );
    req.on('error', reject);
    req.end();
  });
}

/** Stream the body under the byte cap; over the cap = destroy + truncated. */
function readBody(
  res: IncomingMessage,
  maxBytes: number,
): Promise<{ body: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    res.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        chunks.push(chunk.subarray(0, chunk.length - (total - maxBytes)));
        // Settle BEFORE destroy: destroy can emit 'aborted' synchronously,
        // and the reject below must not beat this resolve.
        resolve({ body: Buffer.concat(chunks), truncated: true });
        res.destroy(); // abort mid-body — never buffer past the cap
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => resolve({ body: Buffer.concat(chunks), truncated: false }));
    res.on('aborted', () => reject(new Error('response aborted')));
    res.on('error', (err) => reject(err));
  });
}

/**
 * M10d (ADR 0030 decision 1): a bearer-style credential for a FIXED trusted
 * API. Purpose-named, NOT a generic headers map — a generic map would downgrade
 * "no credential path by construction" to "no credentials unless a caller
 * passes some", which every future caller must remember to avoid. This single
 * named seam is greppable and hard to misuse: the header is attached ONLY while
 * the request host === authorizedHost, and a redirect on a credentialed request
 * is REFUSED (a fixed API that 302s is a signal, not something to chase).
 * web_fetch never sets this — its model-chosen-URL path stays credential-free.
 */
export interface AuthToken {
  headerName: string;
  value: string;
  authorizedHost: string;
}

export interface HardenedFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** TEST-ONLY — see NetTestOverrides. Production wiring never passes this. */
  testOverrides?: NetTestOverrides;
  /** M10d (ADR 0030): the one credential seam — see AuthToken. web_fetch omits it. */
  authToken?: AuthToken;
  /** Override the Accept header (default: HTML-oriented for page fetches). A
   * JSON API sets 'application/json' — Brave rejects the default value. */
  accept?: string;
}

export interface HardenedFetchResult {
  status: number;
  /** Normalized media type (lowercased, parameters stripped). */
  contentType: string;
  body: string;
  bytes: number;
  truncated: boolean;
  finalUrl: string;
  host: string;
}

export async function hardenedFetch(
  rawUrl: string,
  options: HardenedFetchOptions = {},
): Promise<HardenedFetchResult> {
  const overrides = options.testOverrides;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // One deadline for the WHOLE fetch (every hop + the body) — a slow-drip
  // server cannot hold the agent loop hostage past it.
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (options.signal) signals.push(options.signal);
  const signal = AbortSignal.any(signals);
  const mapAbort = (err: unknown): FetchRefusedError => {
    if (options.signal?.aborted) return new FetchRefusedError('cancelled', 'fetch cancelled');
    if (signal.aborted) return new FetchRefusedError('timeout', `no complete response within ${timeoutMs} ms`);
    return new FetchRefusedError('network', err instanceof Error ? err.message : 'network error');
  };

  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    // EVERY hop — including hop 0 — passes the URL guard, the DNS guard, and
    // gets its own pin. A redirect into private space dies right here.
    const target = classifyFetchTarget(current, overrides);
    if (!target.ok) throw new FetchRefusedError(target.code, target.reason);
    const url = target.url;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const pinned = await resolvePinned(host, overrides);

    // M10d (ADR 0030 decision 1): the credential is bound to ONE host. This
    // single boolean decides BOTH whether the token is attached AND whether a
    // redirect is refused — one source of truth, so the two can never drift
    // into "token attached but redirect followed". Host match is
    // case-insensitive with IPv6 brackets already stripped (into `host`).
    const credentialed =
      options.authToken !== undefined &&
      host.toLowerCase() === options.authToken.authorizedHost.toLowerCase();

    let res: IncomingMessage;
    try {
      // Only the credentialed hop carries the token; every other hop (a
      // redirect elsewhere on the uncredentialed path) gets undefined.
      res = await requestOnce(url, pinned, signal, credentialed ? options.authToken : undefined, options.accept);
    } catch (err) {
      throw err instanceof FetchRefusedError ? err : mapAbort(err);
    }
    const status = res.statusCode ?? 0;

    // On the credentialed path a 3xx is REFUSED outright — not followed with
    // the header stripped. The token already went out on THIS request; chasing
    // the redirect would either leak it onward or silently drop the auth, and a
    // fixed trusted API redirecting is a signal something is wrong. (304 cannot
    // arise: the client sends no conditional headers.) web_fetch's
    // uncredentialed 5-hop follow below is untouched.
    if (credentialed && status >= 300 && status < 400) {
      res.resume(); // drain and discard the body
      throw new FetchRefusedError(
        'redirect-refused',
        `the trusted API answered HTTP ${status} with a redirect, which is refused on a credentialed request`,
        status,
      );
    }

    if (status >= 300 && status < 400 && typeof res.headers.location === 'string') {
      res.resume(); // drain and discard the redirect body
      let next: URL;
      try {
        next = new URL(res.headers.location, url);
      } catch {
        throw new FetchRefusedError('unparseable', 'redirect Location is not a valid URL');
      }
      current = next.href;
      continue;
    }
    if (status < 200 || status >= 300) {
      res.resume();
      throw new FetchRefusedError('http-status', `the server answered HTTP ${status}`, status);
    }

    // Content-type gate BEFORE any body byte is read.
    const contentType = (res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      res.destroy();
      throw new FetchRefusedError(
        'content-type',
        `content-type "${contentType || '(none)'}" is not fetchable (text/HTML/JSON/XML only)`,
      );
    }
    // A declared oversize body is refused outright; an undeclared one is
    // caught by the streaming cap below (returned truncated, not errored).
    const declared = Number(res.headers['content-length'] ?? Number.NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      res.destroy();
      throw new FetchRefusedError('too-large', `the document declares ${declared} bytes (cap ${maxBytes})`);
    }

    let read: { body: Buffer; truncated: boolean };
    try {
      read = await readBody(res, maxBytes);
    } catch (err) {
      throw mapAbort(err);
    }
    return {
      status,
      contentType,
      body: read.body.toString('utf8'),
      bytes: read.body.length,
      truncated: read.truncated,
      finalUrl: url.href,
      host,
    };
  }
  throw new FetchRefusedError('too-many-redirects', `more than ${MAX_REDIRECT_HOPS} redirects`);
}
