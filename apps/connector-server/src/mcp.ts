/**
 * The MCP server surface. Two tool families over ONE account-scoped data path:
 *   - Claude's tools: `memory_retrieve({query})`, `memory_list({})`,
 *     `memory_remember({content,type,scope})`, `memory_forget({id})`.
 *   - ChatGPT's retrieval tools (C4): `search({query})` and `fetch({id})` — the
 *     exact names and result shape ChatGPT's deep-research + connector retrieval
 *     model calls by convention. They are THIN adapters over the SAME keyword/
 *     recency scoring and the same `storage.listEntries`/`getEntry` the memory_*
 *     tools use — never a second store or a new data path.
 * Every tool returns ONLY the authenticated account's shared entries — the query
 * is scoped by `accountHash` at the storage layer, so a second account's token
 * sees nothing of the first account's memories (the scope-isolation boundary).
 *
 * search/fetch follow ChatGPT's contract (OpenAI "Building MCP servers for
 * ChatGPT"): search returns `{ results: [{ id, title, url?, snippet }] }`, fetch
 * returns `{ id, title, text, url?, metadata? }`, and BOTH echo that value as
 * `structuredContent` AND as a JSON-encoded string in the `content` array for
 * compatibility. We declare NO outputSchema, so the SDK passes structuredContent
 * through unvalidated (it only validates when an outputSchema is present). `url`
 * is omitted: a private shared memory has no user-openable web URL, and ChatGPT
 * only renders a citation when url is a non-empty string — an honest omission
 * beats a fabricated link. fetch is account-scoped via `getEntry(accountHash,id)`
 * and both tools drop pending-forgotten ids, so a foreign id returns not-found
 * (isolation) and a forgotten memory disappears immediately.
 *
 * A fresh McpServer is created per request (stateless transport), bound to the
 * accountHash resolved from the bearer token's AuthInfo.extra. Responses carry
 * content only; every call writes ONE content-free `connector_audit` row
 * (counts + disclosed ids, never text — mirrors packages/mcp-server/src/log.ts).
 */

import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ConnectorStorage, SharedEntry } from './storage.js';
import { ConnectorCryptoError, decryptRow, encryptRow, isEncryptedRow } from './crypto.js';

const MAX_RESULTS = 20;
const MAX_REMEMBER_BYTES = 8 * 1024; // mirrors the push per-entry content cap
const MAX_SHARED_ENTRIES = 5000; // per-account row cap, mirrors create-server.ts push cap
/** The vault's memory types (kept local so the serverless bundle never pulls @northkeep/core). */
const MEMORY_TYPES = new Set(['episodic', 'semantic', 'procedural', 'working', 'identity']);

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

// ---- ChatGPT search/fetch presentation helpers (C4) ----------------------
const SEARCH_SNIPPET_MAX = 240;
const SEARCH_TITLE_MAX = 72;

/** A short, human-readable title for a memory result: its scope + first line, clipped. */
function titleFor(entry: SharedEntry): string {
  const firstLine = (entry.content.split('\n')[0] ?? '').trim();
  const clipped =
    firstLine.length > SEARCH_TITLE_MAX ? `${firstLine.slice(0, SEARCH_TITLE_MAX - 1)}…` : firstLine;
  return clipped ? `[${entry.scope}] ${clipped}` : `[${entry.scope}] (shared memory)`;
}

/** A one-line snippet of the content, whitespace-collapsed and clipped. */
function snippetOf(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length > SEARCH_SNIPPET_MAX ? `${flat.slice(0, SEARCH_SNIPPET_MAX - 1)}…` : flat;
}

/**
 * Shown when a stored row does not decrypt under this connection's DEK (a DB
 * restored across a key wipe, or rows from before a re-pair). Content-free.
 */
const REENCRYPT_MSG =
  'The shared memories for this account cannot be decrypted over this connection. ' +
  'Ask the user to push their shared scopes again from NorthKeep (the vault is the source of truth), then retry.';

/**
 * `dek` is the per-account data-encryption key, unwrapped by the /mcp route
 * from the wrap riding on the presented access token (ADR 0020). It exists only
 * for this request; nothing here ever writes it anywhere.
 *
 * `allowLegacyPlaintext` gates rows without the nkc1: envelope (ADR 0020 crypto
 * review): the hosted deploy leaves it FALSE, so a non-encrypted row is never
 * served (a DB-writer cannot inject a chosen-plaintext memory). Self-host may
 * opt in for pre-encryption rows.
 */
export function createMcpServer(
  storage: ConnectorStorage,
  accountHash: string,
  dek: Uint8Array,
  allowLegacyPlaintext = false,
): McpServer {
  const server = new McpServer(
    { name: 'northkeep-connector', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  /**
   * Decrypt one stored row to its plaintext view. A legacy (non-nkc1) row is
   * passed through ONLY when explicitly allowed, else dropped (returns null).
   */
  async function decryptEntry(e: SharedEntry): Promise<SharedEntry | null> {
    if (!isEncryptedRow(e.content)) return allowLegacyPlaintext ? e : null;
    const plain = await decryptRow(e.content, accountHash, dek);
    return { ...e, type: plain.type, content: plain.content };
  }

  /** The account's non-hidden entries, decrypted (legacy rows dropped unless allowed). */
  async function visibleEntries(): Promise<SharedEntry[]> {
    const hidden = new Set(await storage.listPendingForgets(accountHash));
    const all = (await storage.listEntries(accountHash)).filter((e) => !hidden.has(e.entryId));
    const decrypted = await Promise.all(all.map(decryptEntry));
    return decrypted.filter((e): e is SharedEntry => e !== null);
  }

  /** Content-free failure audit + the re-encrypt guidance, for a row that will not open. */
  async function reencryptResult(tool: string): Promise<{ content: Array<{ type: 'text'; text: string }>; isError: true }> {
    await storage.appendAudit({
      ts: new Date().toISOString(),
      accountHash,
      tool,
      params: {},
      ok: false,
      resultCount: 0,
      resultIds: [],
    });
    return { content: [{ type: 'text', text: REENCRYPT_MSG }], isError: true };
  }

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
      let all: SharedEntry[];
      try {
        all = await visibleEntries();
      } catch (err) {
        if (err instanceof ConnectorCryptoError) return reencryptResult('memory_retrieve');
        throw err;
      }
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
      let all: SharedEntry[];
      try {
        all = (await visibleEntries()).slice(0, MAX_RESULTS);
      } catch (err) {
        if (err instanceof ConnectorCryptoError) return reencryptResult('memory_list');
        throw err;
      }

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

  // ---- memory_remember: write a new memory back into a shared scope (C3) ----
  // The row is born on the server (origin='connector', pending=true) and flows
  // into the user's vault on the next down-sync. Fail-closed on scope: the AI may
  // only write into a scope the account ALREADY shares (≥1 existing row), never
  // invent a new shared scope.
  server.registerTool(
    'memory_remember',
    {
      title: 'Remember a new shared memory',
      description:
        'Save a new memory into one of the scopes the user has already shared with this app. It flows back into the user’s NorthKeep vault. You cannot create a new scope — only add to a scope that is already shared.',
      inputSchema: {
        content: z.string().describe('The memory to remember'),
        type: z.string().describe('One of: episodic, semantic, procedural, working, identity'),
        scope: z.string().describe('An already-shared scope to save into'),
      },
    },
    async ({ content, type, scope }) => {
      const body = (content ?? '').trim();
      const auditFail = async (): Promise<void> => {
        await storage.appendAudit({
          ts: new Date().toISOString(),
          accountHash,
          tool: 'memory_remember',
          params: {},
          ok: false,
          resultCount: 0,
          resultIds: [],
        });
      };
      if (!body) {
        await auditFail();
        return { content: [{ type: 'text', text: 'Nothing was saved: the memory content was empty.' }] };
      }
      if (Buffer.byteLength(body, 'utf8') > MAX_REMEMBER_BYTES) {
        await auditFail();
        return { content: [{ type: 'text', text: `Nothing was saved: the memory exceeds the ${MAX_REMEMBER_BYTES}-byte limit.` }] };
      }
      const memType = (type ?? '').trim();
      if (!MEMORY_TYPES.has(memType)) {
        await auditFail();
        return {
          content: [{ type: 'text', text: `Nothing was saved: "${memType}" is not a valid memory type. Use episodic, semantic, procedural, working, or identity.` }],
        };
      }
      const targetScope = (scope ?? '').trim();
      const existing = await storage.listEntries(accountHash);
      const sharesScope = existing.some((e) => e.scope === targetScope);
      if (!targetScope || !sharesScope) {
        await auditFail();
        return {
          content: [{ type: 'text', text: `Nothing was saved: "${targetScope}" is not a scope you have shared. Ask the user to share it in NorthKeep first.` }],
        };
      }
      // Per-account row cap: the AI could otherwise create rows without limit
      // (rate-limited only), growing the store and every /client/pending payload.
      if (existing.length >= MAX_SHARED_ENTRIES) {
        await auditFail();
        return {
          content: [{ type: 'text', text: `Nothing was saved: this account is at the shared-memory cap (${MAX_SHARED_ENTRIES}). Ask the user to remove some shared memories in NorthKeep first.` }],
        };
      }
      const entryId = `conn_${randomUUID().replace(/-/g, '')}`;
      // ADR 0020: the row lands as ciphertext — the {type, content} envelope
      // encrypted under this request's DEK; the stored type column is ''.
      await storage.putEntry(accountHash, {
        entryId,
        scope: targetScope,
        type: '',
        content: await encryptRow({ accountHash, type: memType, content: body }, dek),
        entryHash: '',
        origin: 'connector',
        pending: true,
        createdAt: new Date().toISOString(),
      });
      await storage.appendAudit({
        ts: new Date().toISOString(),
        accountHash,
        tool: 'memory_remember',
        params: {},
        ok: true,
        resultCount: 1,
        resultIds: [entryId],
      });
      return {
        content: [{ type: 'text', text: `Saved to shared scope "${targetScope}". It will sync into the vault. (id: ${entryId})` }],
      };
    },
  );

  // ---- memory_forget: forget a shared memory by id (C3) -------------------
  // A forget is ALWAYS recorded as a tombstone in pending_forgets — never an
  // outright delete, even for a still-pending connector-born row. This closes
  // the fetch→forget→ack race: the row is hidden from /client/pending delivery
  // immediately (so a not-yet-delivered memory never lands in the vault), and if
  // the client HAD already fetched it, the forget still propagates because
  // /client/ack re-points the queued tombstone from the server id onto the
  // vault-local id. Either way the memory ends up forgotten, never orphaned.
  server.registerTool(
    'memory_forget',
    {
      title: 'Forget a shared memory',
      description:
        'Forget a shared memory by its id. Use the id shown by memory_remember or memory_list. The memory is hidden immediately and, on the next sync, tombstoned in the user’s vault — it never comes back.',
      inputSchema: { id: z.string().describe('The id of the memory to forget') },
    },
    async ({ id }) => {
      const entryId = (id ?? '').trim();
      const row = entryId ? await storage.getEntry(accountHash, entryId) : null;
      if (row) await storage.enqueueForget(accountHash, entryId);
      await storage.appendAudit({
        ts: new Date().toISOString(),
        accountHash,
        tool: 'memory_forget',
        params: {},
        ok: row !== null,
        resultCount: row ? 1 : 0,
        resultIds: row ? [entryId] : [],
      });
      const text = row
        ? 'Forgotten. It is hidden now and will be removed from the vault on the next sync — it will not come back.'
        : 'No shared memory with that id.';
      return { content: [{ type: 'text', text }] };
    },
  );

  // ---- search: ChatGPT's retrieval entry point (C4) ----------------------
  // Same account-scoped keyword/recency scoring as memory_retrieve, but shaped to
  // ChatGPT's contract: returns { results: [{ id, title, url?, snippet }] } both
  // as structuredContent AND JSON-in-content. Pending-forgotten ids are dropped.
  // Content-free audit: term count + result ids, never the content.
  server.registerTool(
    'search',
    {
      title: 'Search shared memories',
      description:
        'Search the memories the user has explicitly shared with this app and return matching results as {id, title, snippet}. Pass an id to `fetch` to read the full memory. Only shared scopes are visible; private memories are never returned.',
      inputSchema: { query: z.string().describe('What to search the shared memory for') },
    },
    async ({ query }) => {
      const terms = tokenize(query ?? '');
      let all: SharedEntry[];
      try {
        all = await visibleEntries();
      } catch (err) {
        if (err instanceof ConnectorCryptoError) return reencryptResult('search');
        throw err;
      }
      const ranked = all
        .map((e) => ({ e, s: scoreEntry(e, terms) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, MAX_RESULTS)
        .map((x) => x.e);

      await storage.appendAudit({
        ts: new Date().toISOString(),
        accountHash,
        tool: 'search',
        params: { query_terms: terms.length },
        ok: true,
        resultCount: ranked.length,
        resultIds: ranked.map((e) => e.entryId),
      });

      // No `url`: a private shared memory has no user-openable web address, and
      // ChatGPT only emits a citation when url is non-empty (omitting is honest).
      const results = ranked.map((e) => ({ id: e.entryId, title: titleFor(e), snippet: snippetOf(e.content) }));
      const structuredContent = { results };
      return { structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] };
    },
  );

  // ---- fetch: ChatGPT reads one full record by id (C4) -------------------
  // Account-scoped via getEntry(accountHash, id): a foreign or unknown id returns
  // not-found (isolation), as does a pending-forgotten id. Returns
  // { id, title, text, metadata } both structured and JSON-in-content.
  server.registerTool(
    'fetch',
    {
      title: 'Fetch a shared memory',
      description:
        'Fetch the full record for a shared-memory id returned by `search`. Returns {id, title, text, metadata}. Only the authenticated user’s shared memories are reachable; an unknown or not-shared id returns not-found.',
      inputSchema: { id: z.string().describe('The id of a memory returned by search') },
    },
    async ({ id }) => {
      const entryId = (id ?? '').trim();
      const hidden = new Set(await storage.listPendingForgets(accountHash));
      const stored = entryId && !hidden.has(entryId) ? await storage.getEntry(accountHash, entryId) : null;
      let row: SharedEntry | null;
      try {
        row = stored ? await decryptEntry(stored) : null;
      } catch (err) {
        if (err instanceof ConnectorCryptoError) return reencryptResult('fetch');
        throw err;
      }

      await storage.appendAudit({
        ts: new Date().toISOString(),
        accountHash,
        tool: 'fetch',
        params: {},
        ok: row !== null,
        resultCount: row ? 1 : 0,
        resultIds: row ? [entryId] : [],
      });

      if (!row) {
        return { content: [{ type: 'text', text: `No shared memory with id "${entryId}".` }], isError: true };
      }
      // scope/type are labels, not content — safe to return to the caller. The
      // audit above stays content-free (ids only).
      const record = {
        id: row.entryId,
        title: titleFor(row),
        text: row.content,
        metadata: { scope: row.scope, type: row.type },
      };
      return { structuredContent: record, content: [{ type: 'text', text: JSON.stringify(record) }] };
    },
  );

  return server;
}
