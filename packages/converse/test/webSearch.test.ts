import { describe, expect, it } from 'vitest';
import { FetchRefusedError } from '../src/tools/net.js';
import {
  BRAVE_HOST,
  braveBodyToText,
  braveResultsToText,
  buildBraveUrl,
  createWebSearchTool,
  extractBraveHits,
  fetchErrorToResult,
} from '../src/tools/webSearch.js';
import type { ToolContext } from '../src/tools/types.js';

/**
 * M10d — web_search over Brave (ADR 0030). The credential rides net.ts's seam
 * (proven in net-auth.test.ts); here we prove the tool's OWN logic without a
 * socket: the egress URL carries the query but NEVER the token (decision 1),
 * JSON parses to a compact list, and every failure returns a structured
 * {error, guidance} result the model can act on (invariant #6, no throw).
 */

const API_KEY = 'brave-subscription-token-DO-NOT-LEAK';
const ctx: ToolContext = { maxResultChars: 10_000 };

describe('buildBraveUrl / egress — the query rides the URL, the token never does', () => {
  it('builds the fixed Brave endpoint with the encoded query, count, and decorations off', () => {
    const url = new URL(buildBraveUrl('carol mansfield doctor', 5));
    expect(url.hostname).toBe(BRAVE_HOST);
    expect(url.pathname).toBe('/res/v1/web/search');
    expect(url.protocol).toBe('https:');
    expect(url.searchParams.get('q')).toBe('carol mansfield doctor');
    expect(url.searchParams.get('count')).toBe('5');
    // Verified against Brave's live API docs: results live under web.results[]
    // with plain-string title/url/description, and text_decorations defaults
    // OFF — we pin it OFF so descriptions never arrive as <strong> markup.
    expect(url.searchParams.get('text_decorations')).toBe('false');
  });

  it('percent-encodes a query with URL-hostile characters', () => {
    const href = buildBraveUrl('a&b=c #d/e', 3);
    // The raw specials must be encoded so they cannot alter the querystring.
    expect(href).not.toContain('a&b=c #d');
    expect(new URL(href).searchParams.get('q')).toBe('a&b=c #d/e');
  });

  it("egress() returns the same URL and it NEVER contains the token", () => {
    const tool = createWebSearchTool({ apiKey: API_KEY });
    const eg = tool.egress({ query: 'northkeep vault' });
    expect(eg).not.toBeNull();
    expect(eg!.url).toBe(buildBraveUrl('northkeep vault', 5));
    expect(eg!.url).not.toContain(API_KEY);
    // The audit/gate/screen see this URL — the token must be nowhere in it.
    expect(eg!.url.toLowerCase()).not.toContain('token');
  });

  it('egress() honors a custom maxResults as the count', () => {
    const tool = createWebSearchTool({ apiKey: API_KEY, maxResults: 8 });
    expect(new URL(tool.egress({ query: 'x' })!.url).searchParams.get('count')).toBe('8');
  });

  it('egress() returns null when the query is missing or the wrong type', () => {
    const tool = createWebSearchTool({ apiKey: API_KEY });
    expect(tool.egress({})).toBeNull();
    expect(tool.egress({ query: 123 })).toBeNull();
    expect(tool.egress({ query: '  ' })).toBeNull();
    expect(tool.egress(null)).toBeNull();
  });
});

describe('extractBraveHits / braveResultsToText — JSON → compact list', () => {
  const braveBody = {
    web: {
      results: [
        { title: 'First', url: 'https://a.example/1', description: 'the first hit' },
        { title: 'Second', url: 'https://b.example/2', description: 'the second hit' },
        { title: 'No desc', url: 'https://c.example/3' },
        { title: 'Bad — no url', description: 'skipped' },
      ],
    },
  };

  it('extracts only well-formed hits, tolerating missing description and skipping bad rows', () => {
    const hits = extractBraveHits(braveBody);
    expect(hits).toEqual([
      { title: 'First', url: 'https://a.example/1', description: 'the first hit' },
      { title: 'Second', url: 'https://b.example/2', description: 'the second hit' },
      { title: 'No desc', url: 'https://c.example/3', description: '' },
    ]);
  });

  it('renders a numbered "title / url / description" list capped at maxResults', () => {
    const text = braveResultsToText(extractBraveHits(braveBody), 2);
    expect(text).toBe(
      '1. First\n   https://a.example/1\n   the first hit\n' +
        '2. Second\n   https://b.example/2\n   the second hit',
    );
  });

  it('omits the description line when a hit has none', () => {
    const text = braveResultsToText([{ title: 'T', url: 'https://u.example', description: '' }], 5);
    expect(text).toBe('1. T\n   https://u.example');
  });

  it('returns a valid "no results" string for an empty or shapeless payload', () => {
    expect(braveResultsToText(extractBraveHits({ web: { results: [] } }), 5)).toBe(
      'No results found for that query.',
    );
    expect(extractBraveHits({})).toEqual([]);
    expect(extractBraveHits(null)).toEqual([]);
    expect(extractBraveHits({ web: { results: 'nope' } })).toEqual([]);
  });
});

describe('braveBodyToText — the wire body → text step (JSON.parse included)', () => {
  it('parses a valid body into the rendered list', () => {
    const body = JSON.stringify({
      web: { results: [{ title: 'T', url: 'https://u.example', description: 'd' }] },
    });
    const r = braveBodyToText(body, 5);
    expect(r.ok).toBe(true);
    expect(r.ok && r.content).toBe('1. T\n   https://u.example\n   d');
  });

  it('treats a parseable-but-empty body as SUCCESS with the "no results" string', () => {
    const r = braveBodyToText(JSON.stringify({ web: { results: [] } }), 5);
    expect(r.ok).toBe(true);
    expect(r.ok && r.content).toBe('No results found for that query.');
  });

  it('signals ok:false for unparseable JSON (execute maps this to bad_response)', () => {
    expect(braveBodyToText('<html>not json</html>', 5).ok).toBe(false);
    expect(braveBodyToText('', 5).ok).toBe(false);
  });
});

describe('fetchErrorToResult — Brave HTTP failures map to clear guidance', () => {
  const parse = (r: { content: string }) => JSON.parse(r.content) as { error: string; guidance: string };

  it('maps 429 to rate_limited', () => {
    const r = fetchErrorToResult(new FetchRefusedError('http-status', 'HTTP 429', 429), BRAVE_HOST);
    expect(r.meta.ok).toBe(false);
    expect(r.meta.host).toBe(BRAVE_HOST);
    expect(parse(r).error).toBe('rate_limited');
    expect(parse(r).guidance).toMatch(/rate limit/i);
  });

  it('maps 401 and 403 to auth', () => {
    for (const status of [401, 403]) {
      const r = fetchErrorToResult(new FetchRefusedError('http-status', `HTTP ${status}`, status), BRAVE_HOST);
      expect(parse(r).error).toBe('auth');
      expect(parse(r).guidance).toMatch(/key/i);
    }
  });

  it('maps a refused redirect (credentialed path) to redirect-refused guidance', () => {
    const r = fetchErrorToResult(new FetchRefusedError('redirect-refused', 'redirect refused', 302), BRAVE_HOST);
    expect(parse(r).error).toBe('redirect-refused');
    expect(parse(r).guidance).toMatch(/redirect/i);
  });

  it('passes other codes through with their own guidance', () => {
    expect(parse(fetchErrorToResult(new FetchRefusedError('timeout', 'slow'), BRAVE_HOST)).error).toBe('timeout');
    expect(parse(fetchErrorToResult(new FetchRefusedError('dns', 'no host'), BRAVE_HOST)).error).toBe('dns');
  });

  it('never echoes anything token-shaped (error messages carry no credential)', () => {
    const r = fetchErrorToResult(new FetchRefusedError('http-status', 'HTTP 500', 500), BRAVE_HOST);
    expect(r.content).not.toContain(API_KEY);
  });
});

describe('execute — the missing-query guard returns a structured error, never throws', () => {
  it('rejects a missing/blank/non-string query with invalid_arguments', async () => {
    const tool = createWebSearchTool({ apiKey: API_KEY });
    for (const args of [{}, { query: '' }, { query: '   ' }, { query: 42 }, null]) {
      const r = await tool.execute(args, ctx);
      expect(r.meta.ok).toBe(false);
      expect((JSON.parse(r.content) as { error: string }).error).toBe('invalid_arguments');
    }
  });
});

describe('createWebSearchTool — the declared tool shape (ADR 0030)', () => {
  const tool = createWebSearchTool({ apiKey: API_KEY });

  it('is a costed, trusted-api safe-read with a query-only schema', () => {
    expect(tool.name).toBe('web_search');
    expect(tool.risk).toBe('safe-read');
    expect(tool.egressTrust).toBe('trusted-api');
    expect(tool.costPerCallUsd).toBeGreaterThan(0);
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      required: ['query'],
      additionalProperties: false,
    });
  });
});
