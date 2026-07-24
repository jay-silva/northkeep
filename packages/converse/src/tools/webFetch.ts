import type { ToolContext, ToolDefinition, ToolResult } from './types.js';
import {
  classifyFetchTarget,
  hardenedFetch,
  FetchRefusedError,
  type NetTestOverrides,
} from './net.js';
import { extractText } from './extract-text.js';

/**
 * web_fetch — tools v1's read-only page fetch (M10b, ADR 0028). Wires the
 * hardened client (net.ts) to the zero-dep extractor (extract-text.ts).
 * Failures come back as structured {error, guidance} JSON CONTENT with
 * meta.ok:false — never a throw through the agent loop — so the model can
 * correct course (try https, another page) and the user sees the refusal in
 * the transcript instead of a dead task (invariant #6).
 */

export interface WebFetchConfig {
  maxBytes?: number;
  timeoutMs?: number;
  /** TEST-ONLY — see NetTestOverrides in net.ts. Never set by production wiring. */
  testOverrides?: NetTestOverrides;
}

/** One-line model guidance per refusal code — actionable, never chatty. */
const GUIDANCE: Record<string, string> = {
  scheme: 'Only https:// URLs can be fetched. Retry with an https URL.',
  userinfo: 'URLs with embedded credentials are refused. Retry without user:pass@.',
  'private-address': 'That address is private/internal and can never be fetched. Only public sites are reachable.',
  'bad-port': 'Only ports 443 and 8443 are allowed. Retry without a custom port.',
  unparseable: 'That is not a valid URL. Retry with a full https:// URL.',
  dns: 'The hostname did not resolve. Check the domain spelling.',
  timeout: 'The site did not answer in time. It may be slow or down; try once more or move on.',
  cancelled: 'The fetch was cancelled by the user.',
  'too-large': 'The document is larger than the fetch cap. Try a more specific page.',
  'content-type': 'Only HTML, plain text, JSON, and XML documents can be fetched.',
  'too-many-redirects': 'The URL redirected more than 5 times. Try the final destination directly.',
  'http-status': 'The server refused the request. The page may not exist or may require login.',
  network: 'The connection failed. The site may be unreachable; try once more or move on.',
};

function errorResult(code: string, detail: string, host?: string): ToolResult {
  const content = JSON.stringify({
    error: code,
    detail,
    guidance: GUIDANCE[code] ?? 'The fetch failed. Consider a different URL.',
  });
  return {
    content,
    meta: { ...(host !== undefined ? { host } : {}), bytes: 0, truncated: false, ok: false },
  };
}

export function createWebFetchTool(config: WebFetchConfig = {}): ToolDefinition {
  return {
    name: 'web_fetch',
    description:
      'Fetch a public web page over https and return its readable text content. ' +
      'Use for looking up current information the user asks about. Input: {"url": "https://..."}.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The full https URL of the page to fetch.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    risk: 'safe-read',

    egress(args: unknown): { url: string } | null {
      if (args !== null && typeof args === 'object' && typeof (args as { url?: unknown }).url === 'string') {
        return { url: (args as { url: string }).url };
      }
      return null;
    },

    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const url =
        args !== null && typeof args === 'object' && typeof (args as { url?: unknown }).url === 'string'
          ? (args as { url: string }).url
          : null;
      if (url === null) {
        return errorResult('invalid_arguments', 'expected {"url": "https://..."}');
      }
      const target = classifyFetchTarget(url, config.testOverrides);
      if (!target.ok) return errorResult(target.code, target.reason);

      try {
        const res = await hardenedFetch(url, {
          ...(config.maxBytes !== undefined ? { maxBytes: config.maxBytes } : {}),
          ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
          ...(config.testOverrides !== undefined ? { testOverrides: config.testOverrides } : {}),
        });
        const isHtml = res.contentType === 'text/html' || res.contentType === 'application/xhtml+xml';
        const content = isHtml ? extractText(res.body) : res.body;
        return {
          content,
          meta: { host: res.host, bytes: res.bytes, truncated: res.truncated, ok: true },
        };
      } catch (err) {
        if (err instanceof FetchRefusedError) {
          return errorResult(err.code, err.message, target.url.hostname);
        }
        // Unexpected — still no throw through the loop (invariant #6 wants a
        // loud per-call error, not a dead task).
        return errorResult(
          'network',
          err instanceof Error ? err.message : 'unexpected fetch failure',
          target.url.hostname,
        );
      }
    },
  };
}
