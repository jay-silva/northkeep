/**
 * The MCP server surface: `memory_retrieve({query})` and `memory_list({})`.
 * Both return ONLY the authenticated account's shared entries — the query is
 * scoped by `accountHash` at the storage layer, so a second account's token
 * sees nothing of the first account's memories (the scope-isolation boundary).
 *
 * A fresh McpServer is created per request (stateless transport), bound to the
 * accountHash resolved from the bearer token's AuthInfo.extra. Responses carry
 * content only; every call writes ONE content-free `connector_audit` row
 * (counts + disclosed ids, never text — mirrors packages/mcp-server/src/log.ts).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ConnectorStorage, SharedEntry } from './storage.js';

const MAX_RESULTS = 20;

/** Lowercase word tokens, deduped — a tiny keyword scorer, no server-side embeddings (ADR 0016). */
function tokenize(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 2) seen.add(raw);
  }
  return [...seen];
}

function scoreEntry(entry: SharedEntry, terms: string[]): number {
  if (terms.length === 0) return 1;
  const hay = `${entry.content} ${entry.scope} ${entry.type}`.toLowerCase();
  let score = 0;
  for (const t of terms) if (hay.includes(t)) score++;
  return score;
}

export function createMcpServer(storage: ConnectorStorage, accountHash: string): McpServer {
  const server = new McpServer(
    { name: 'northkeep-connector', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'memory_retrieve',
    {
      title: 'Retrieve shared memories',
      description:
        'Search the memories the user has explicitly shared with this app and return the ones relevant to a query. Only shared scopes are visible; private memories are never returned.',
      inputSchema: { query: z.string().describe('What to search the shared memory for') },
    },
    async ({ query }) => {
      const terms = tokenize(query ?? '');
      const all = await storage.listEntries(accountHash);
      const ranked = all
        .map((e) => ({ e, s: scoreEntry(e, terms) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, MAX_RESULTS)
        .map((x) => x.e);

      await storage.appendAudit({
        ts: new Date().toISOString(),
        accountHash,
        tool: 'memory_retrieve',
        params: { query_terms: terms.length },
        ok: true,
        resultCount: ranked.length,
        resultIds: ranked.map((e) => e.entryId),
      });

      const text = ranked.length
        ? `Shared memories for "${query}":\n` + ranked.map((e) => `- [${e.scope}] ${e.content}`).join('\n')
        : `No shared memories matched "${query}".`;
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'memory_list',
    {
      title: 'List shared memories',
      description:
        'List all memories the user has explicitly shared with this app. Only shared scopes are visible; private memories are never listed.',
      inputSchema: {},
    },
    async () => {
      const all = (await storage.listEntries(accountHash)).slice(0, MAX_RESULTS);

      await storage.appendAudit({
        ts: new Date().toISOString(),
        accountHash,
        tool: 'memory_list',
        params: { limit: MAX_RESULTS },
        ok: true,
        resultCount: all.length,
        resultIds: all.map((e) => e.entryId),
      });

      const text = all.length
        ? 'Shared memories:\n' + all.map((e) => `- [${e.scope}] ${e.content}`).join('\n')
        : 'No shared memories yet.';
      return { content: [{ type: 'text', text }] };
    },
  );

  return server;
}
