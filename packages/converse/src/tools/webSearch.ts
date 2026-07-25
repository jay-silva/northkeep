import type { ToolContext, ToolDefinition, ToolResult } from './types.js';
import { hardenedFetch, FetchRefusedError, type NetTestOverrides } from './net.js';

/**
 * web_search — the second egress tool (M10d, ADR 0030). It searches the public
 * web via the Brave Search API and returns ranked results FENCED as external
 * data (the loop wraps them because egress() is non-null — ADR 0030 decision 3;
 * this file never fences its own output). Two things differ from web_fetch:
 *
 *  - It carries a CREDENTIAL (the Brave subscription token) to ONE fixed host.
 *    The token rides net.ts's single named `authToken` seam and NEVER touches
 *    the egress() URL, argsPlain, the gate, the exfil screen, or the audit hash
 *    (ADR 0030 decision 1). The query rides the URL; the token rides the
 *    header; they never mix — buildBraveUrl below has no place to put a token.
 *  - It is a `trusted-api` egress (ADR 0030 decision 2), so the exfil screens
 *    drop identity/memory flags and keep only the catastrophic-secret block —
 *    but that policy lives in the loop; this file just declares egressTrust.
 *
 * Like web_fetch, failures return structured {error, guidance} JSON CONTENT
 * with meta.ok:false — NEVER a throw through the agent loop (invariant #6): the
 * model can recover (retry, search differently, or move on) and the user sees
 * the refusal in the transcript instead of a dead task.
 */

/** The fixed Brave endpoint. The token is bound to THIS host and no other. */
export const BRAVE_HOST = 'api.search.brave.com';
const BRAVE_SEARCH_PATH = '/res/v1/web/search';
/** Brave sends its subscription token in this purpose-named header. */
const BRAVE_AUTH_HEADER = 'X-Subscription-Token';
const DEFAULT_MAX_RESULTS = 5;
/** Brave JSON is small; no reason to hold the 2 MB page cap open for it. */
const SEARCH_MAX_BYTES = 512 * 1024;
const SEARCH_TIMEOUT_MS = 15_000;

export interface WebSearchConfig {
  /** The Brave subscription token. Rides the header only — never the URL. */
  apiKey: string;
  /** Cap on results requested and rendered (default 5). */
  maxResults?: number;
  /** TEST-ONLY — see NetTestOverrides in net.ts. Never set by production wiring. */
  testOverrides?: NetTestOverrides;
  /**
   * TEST-ONLY. Points the tool at a loopback fixture instead of the real Brave
   * host, and rebinds the credential's authorized host to that fixture so the
   * token-attach path is still exercised end to end. The production SSRF guard
   * refuses loopback, so real wiring NEVER sets this (enabledTools in
   * registry.ts constructs the tool without it); only e2e tests do, alongside
   * testOverrides. `origin` is like `http://127.0.0.1:PORT`.
   */
  testEndpoint?: { origin: string; authorizedHost: string };
}

/**
 * The Brave query URL. CRITICAL (ADR 0030 decision 1): this is exactly what the
 * gate, the exfil screen, and the audit see, and it must NOT contain the token
 * — there is deliberately no parameter here to hold one. The query is
 * percent-encoded by URLSearchParams. egress() and execute() build the URL
 * through this one function from the same query string. (The bytes that
 * actually reach Brave may carry LESS: for a bounded egress the loop applies
 * the Tier-1 floor to the args before execute, so a literal secret is masked
 * on the wire though the gate/audit saw it unmasked — the divergence only ever
 * removes data, never adds it.)
 */
export function buildBraveUrl(query: string, count: number, origin = `https://${BRAVE_HOST}`): string {
  const url = new URL(BRAVE_SEARCH_PATH, origin);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(count));
  // Pin text_decorations OFF (its documented default) so descriptions arrive as
  // plain text — never Brave's <strong> highlight markup. Explicit so a future
  // default change can't start injecting markup into the fenced model input.
  url.searchParams.set('text_decorations', 'false');
  return url.href;
}

/** One Brave web result, narrowed to the three fields we render. */
interface BraveHit {
  title: string;
  url: string;
  description: string;
}

/**
 * Pull the renderable hits out of a parsed Brave response. Brave's shape is
 * `{ web: { results: [{ title, url, description }, …] }, … }`; anything missing
 * or the wrong type is simply skipped (a partial/odd payload yields fewer hits,
 * never a throw). A response with no usable hits returns [] → "no results".
 */
export function extractBraveHits(parsed: unknown): BraveHit[] {
  const results = (parsed as { web?: { results?: unknown } } | null)?.web?.results;
  if (!Array.isArray(results)) return [];
  const hits: BraveHit[] = [];
  for (const r of results) {
    if (r === null || typeof r !== 'object') continue;
    const { title, url, description } = r as Record<string, unknown>;
    if (typeof title === 'string' && typeof url === 'string') {
      hits.push({ title, url, description: typeof description === 'string' ? description : '' });
    }
  }
  return hits;
}

/**
 * Render up to `maxResults` hits as a compact numbered list. This is PLAIN text
 * — the loop fences it as untrusted external data; we do not fence it here
 * (ADR 0030 decision 3). Zero hits is a valid answer, not an error.
 */
export function braveResultsToText(hits: BraveHit[], maxResults: number): string {
  if (hits.length === 0) return 'No results found for that query.';
  return hits
    .slice(0, maxResults)
    .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.description ? `\n   ${h.description}` : ''}`)
    .join('\n');
}

/**
 * The full wire-body → text step, kept pure so it is unit-testable without a
 * socket: parse the JSON, extract hits, render the list. Unparseable JSON is a
 * signalled failure ({ok:false}) rather than a throw — execute() maps it to a
 * `bad_response` result. An empty/shapeless-but-parseable body is a SUCCESS
 * ({ok:true} with the "no results" string): Brave answered, there just were no
 * hits, and the model should see that, not an error.
 */
export function braveBodyToText(
  body: string,
  maxResults: number,
): { ok: true; content: string } | { ok: false } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false };
  }
  return { ok: true, content: braveResultsToText(extractBraveHits(parsed), maxResults) };
}

/** One-line, actionable model guidance per error code — never chatty. */
const GUIDANCE: Record<string, string> = {
  invalid_arguments: 'Provide a query string: {"query": "your search terms"}.',
  rate_limited:
    'The search API is rate limiting (HTTP 429). Wait a moment before searching again, or answer from what you already know.',
  auth:
    'The search API rejected the subscription key (invalid or inactive). Search is unavailable this session; do not retry — proceed without it.',
  bad_response: 'The search API returned an unreadable response. Try a different query or continue without search.',
  'redirect-refused':
    'The search API returned a redirect, which is refused on a credentialed request. Search is unavailable right now; proceed without it.',
  timeout: 'The search API did not answer in time. Try once more or continue without search.',
  network: 'The connection to the search API failed. Try once more or continue without search.',
  dns: 'The search API host did not resolve. Search is unavailable right now.',
  'content-type': 'The search API returned an unexpected content type. Try a different query.',
  'too-large': 'The search response exceeded the size cap. Try a narrower query.',
  'http-status': 'The search API refused the request. Try a different query or continue without search.',
};

function errorResult(code: string, detail: string, host?: string): ToolResult {
  const content = JSON.stringify({
    error: code,
    detail,
    guidance: GUIDANCE[code] ?? 'The search failed. Try a different query or continue without search.',
  });
  return {
    content,
    meta: { ...(host !== undefined ? { host } : {}), bytes: 0, truncated: false, ok: false },
  };
}

/**
 * Map a hardened-client refusal to a structured tool result. 429 and 401/403
 * get their own clear guidance (rate limit vs bad key) because the model's best
 * next move differs — back off vs stop trying. The error message carries no
 * token (net.ts guarantees the credential never appears in a FetchRefusedError).
 */
export function fetchErrorToResult(err: FetchRefusedError, host: string): ToolResult {
  if (err.code === 'http-status' && err.status === 429) {
    return errorResult('rate_limited', 'Brave returned HTTP 429 (rate limited)', host);
  }
  // Brave signals a bad/inactive subscription token with HTTP 422
  // (SUBSCRIPTION_TOKEN_INVALID), NOT 401/403 — verified against the live API.
  // Our request is fixed and pre-validated, so a 422 here is an auth problem in
  // practice, not a malformed query.
  if (err.code === 'http-status' && (err.status === 401 || err.status === 403 || err.status === 422)) {
    return errorResult('auth', `Brave rejected the request (HTTP ${err.status}) — the subscription key is invalid or inactive`, host);
  }
  return errorResult(err.code, err.message, host);
}

/** Extract a usable query string from the model's arguments, or null. */
function parseQuery(args: unknown): string | null {
  if (args === null || typeof args !== 'object') return null;
  const q = (args as { query?: unknown }).query;
  if (typeof q !== 'string' || q.trim() === '') return null;
  return q;
}

export function createWebSearchTool(config: WebSearchConfig): ToolDefinition {
  const maxResults = config.maxResults ?? DEFAULT_MAX_RESULTS;
  // TEST-ONLY endpoint rebinding (see WebSearchConfig.testEndpoint); production
  // always uses the real Brave host and its bound authorized host.
  const origin = config.testEndpoint?.origin ?? `https://${BRAVE_HOST}`;
  const authorizedHost = config.testEndpoint?.authorizedHost ?? BRAVE_HOST;
  return {
    name: 'web_search',
    description:
      'Search the public web via Brave and return ranked results (title, url, snippet). ' +
      'Input: {"query": "..."}.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    risk: 'safe-read',
    // Fixed trusted endpoint: only the catastrophic-secret hard-block screens
    // this tool's args; identity/memory flags are dropped (ADR 0030 decision 2).
    egressTrust: 'trusted-api',
    // Brave's paid tier bills ~$0.005/query; the free tier is $0 (2k/month).
    // A nonzero value flags this tool as COSTED so the budget engine counts it
    // (ADR 0030 decision 4). The honest unit is a call count, not this estimate.
    costPerCallUsd: 0.005,

    egress(args: unknown): { url: string } | null {
      const query = parseQuery(args);
      if (query === null) return null;
      // The token is NOT here — this URL is what the gate/screen/audit see.
      return { url: buildBraveUrl(query, maxResults, origin) };
    },

    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const query = parseQuery(args);
      if (query === null) {
        return errorResult('invalid_arguments', 'expected {"query": "..."} with a non-empty string');
      }
      const url = buildBraveUrl(query, maxResults, origin);
      try {
        const res = await hardenedFetch(url, {
          // The credential seam: attached ONLY while the request host is
          // api.search.brave.com, and a redirect refuses (net.ts, ADR 0030).
          authToken: { headerName: BRAVE_AUTH_HEADER, value: config.apiKey, authorizedHost },
          // Brave 422s the default HTML-oriented Accept ("Unable to validate
          // request parameter(s)") — it wants application/json.
          accept: 'application/json',
          maxBytes: SEARCH_MAX_BYTES,
          timeoutMs: SEARCH_TIMEOUT_MS,
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
          ...(config.testOverrides !== undefined ? { testOverrides: config.testOverrides } : {}),
        });
        const rendered = braveBodyToText(res.body, maxResults);
        if (!rendered.ok) {
          return errorResult('bad_response', 'Brave returned a response that is not valid JSON', res.host);
        }
        return {
          content: rendered.content,
          meta: { host: res.host, bytes: res.bytes, truncated: res.truncated, ok: true },
        };
      } catch (err) {
        if (err instanceof FetchRefusedError) return fetchErrorToResult(err, BRAVE_HOST);
        // Unexpected — still no throw through the loop (invariant #6).
        return errorResult('network', err instanceof Error ? err.message : 'unexpected search failure', BRAVE_HOST);
      }
    },
  };
}
