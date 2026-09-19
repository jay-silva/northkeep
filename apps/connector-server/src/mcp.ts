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

import { createHash, randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  PROJECT_DOC_CAP_MESSAGE,
  PROJECT_SLUG_PATTERN,
  emptyProjectDoc,
  firstNonEmptyLine,
  getProjectSection,
  assertProjectDocSize,
  formatLogArchive,
  isProjectLogArchive,
  mergeProjectDoc,
  rollProjectLog,
  parseProjectDoc,
  parseProjectSlug,
  projectScope,
  serializeProjectDoc,
} from './project-doc.js';
import { z } from 'zod';
import type { ConnectorStorage, SharedEntry } from './storage.js';
import { ConnectorCryptoError, decryptRow, encryptRow, isEncryptedRow } from './crypto.js';
import { firstProjectTextError } from './project-text.js';
import { TOMBSTONE_USER_MESSAGE } from './tombstones.js';

const MAX_RESULTS = 20;
const MAX_REMEMBER_BYTES = 8 * 1024; // mirrors the ordinary push per-entry content cap
const MAX_SHARED_ENTRIES = 5000; // per-account row cap, mirrors create-server.ts push cap
/** Vault memory types, kept local. Project-doc helpers are the pure copy in ./project-doc.ts (no sqlite or sodium). */
const MEMORY_TYPES = new Set(['episodic', 'semantic', 'procedural', 'working', 'identity']);
const projectSlugSchema = z
  .string()
  .regex(PROJECT_SLUG_PATTERN, 'project slugs are 1-40 lowercase letters, digits, or hyphens');

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
 * Pick the live project document from already-decrypted rows in one scope.
 * Pending working-type first; else newest createdAt, then highest entryId.
 */
function selectProjectWorkingDoc(rows: SharedEntry[]): SharedEntry | null {
  const working = rows.filter((e) => e.type === 'working');
  const pending = working.filter((e) => e.pending === true);
  const pool = pending.length > 0 ? pending : working;
  if (pool.length === 0) return null;
  let best = pool[0]!;
  for (let i = 1; i < pool.length; i++) {
    const e = pool[i]!;
    if (e.createdAt > best.createdAt || (e.createdAt === best.createdAt && e.entryId > best.entryId)) {
      best = e;
    }
  }
  return best;
}

function statusFirstLine(content: string): string {
  return firstNonEmptyLine(getProjectSection(parseProjectDoc(content), 'Current Status'));
}

function toProjectUpdate(args: {
  what_why?: string;
  status?: string;
  next_actions?: string;
  log_entry?: string;
  decision?: string;
}) {
  return {
    whatWhy: args.what_why,
    status: args.status,
    nextActions: args.next_actions,
    logEntry: args.log_entry,
    decision: args.decision,
  };
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

  /**
   * Scopes the user unshared (ADR 0038). Read fresh per call so a tombstone
   * written during this request is seen. ADR 0050 Decision 3: the check never
   * honours CONNECTOR_TOMBSTONE_ENFORCE; unshare is the revoke.
   */
  async function tombstonedScopes(): Promise<Set<string>> {
    return new Set((await storage.listTombstones(accountHash)).map((t) => t.scope));
  }

  /**
   * The account's non-hidden entries, decrypted (legacy rows dropped unless
   * allowed). A row whose scope has a tombstone is excluded: a write that lost
   * the race to an unshare must never be shown (ADR 0050 Decision 3).
   */
  async function visibleEntries(): Promise<SharedEntry[]> {
    const hidden = new Set(await storage.listPendingForgets(accountHash));
    const unshared = await tombstonedScopes();
    const all = (await storage.listEntries(accountHash)).filter(
      (e) => !hidden.has(e.entryId) && !unshared.has(e.scope),
    );
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
      // Unshare is the revoke: a connected app must not write into a scope the
      // user revoked, even when a stale push left a non-pending row behind.
      if ((await tombstonedScopes()).has(targetScope)) {
        await auditFail();
        return { content: [{ type: 'text', text: TOMBSTONE_USER_MESSAGE }] };
      }
      const existing = await storage.listEntries(accountHash);
      const scopeRows = targetScope ? existing.filter((e) => e.scope === targetScope) : [];
      // ADR 0050 Decision 2: a scope is writable only when it holds a row the
      // user's device pushed or acked. `pending` is the one column both stores
      // maintain identically; `origin` survives an ack and would lie here.
      const writable = scopeRows.some((e) => e.pending !== true);
      if (!targetScope || scopeRows.length === 0) {
        await auditFail();
        return {
          content: [{ type: 'text', text: `Nothing was saved: "${targetScope}" is not a scope you have shared. Ask the user to share it in NorthKeep first.` }],
        };
      }
      if (!writable) {
        await auditFail();
        return {
          content: [
            {
              type: 'text',
              text: `Nothing was saved: "${targetScope}" has no memory from the vault yet. Ask the user to add a memory to it, or re-share it, in NorthKeep.`,
            },
          ],
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
      const found = entryId && !hidden.has(entryId) ? await storage.getEntry(accountHash, entryId) : null;
      // fetch reads by id, so it does not inherit the visibleEntries tombstone
      // filter. An unshared scope must be not-found here too (ADR 0050).
      const unshared = await tombstonedScopes();
      const stored = found && !unshared.has(found.scope) ? found : null;
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

  // ---- project tools (M14 / ADR 0040) -----------------------------------
  // Same three tools as local MCP. Cloud cannot create a project: update
  // requires a decryptable working base document. One pending row per
  // project scope, overwritten in place. Slug-exact validation; never a
  // prefix-only project: check.

  server.registerTool(
    'project_list',
    {
      title: 'List shared projects',
      description:
        "List the user's shared projects. Each row is a project slug plus the first line of Current " +
        'Status. This list is the project index; there is no separate index memory. Only scopes the ' +
        'user has shared are visible.',
      inputSchema: {},
    },
    async () => {
      let all: SharedEntry[];
      try {
        all = await visibleEntries();
      } catch (err) {
        if (err instanceof ConnectorCryptoError) return reencryptResult('project_list');
        throw err;
      }
      const byScope = new Map<string, SharedEntry[]>();
      for (const e of all) {
        if (parseProjectSlug(e.scope) === null) continue;
        const group = byScope.get(e.scope) ?? [];
        group.push(e);
        byScope.set(e.scope, group);
      }
      const docs: SharedEntry[] = [];
      for (const group of byScope.values()) {
        const picked = selectProjectWorkingDoc(group);
        if (picked) docs.push(picked);
      }
      docs.sort((a, b) => a.scope.localeCompare(b.scope));
      const projects = docs.flatMap((e) => {
        const slug = parseProjectSlug(e.scope);
        if (slug === null) return [];
        return [{ project: slug, scope: e.scope, status: statusFirstLine(e.content), id: e.entryId }];
      });
      await storage.appendAudit({
        ts: new Date().toISOString(),
        accountHash,
        tool: 'project_list',
        params: {},
        ok: true,
        resultCount: projects.length,
        resultIds: docs.map((e) => e.entryId),
      });
      return { content: [{ type: 'text', text: JSON.stringify({ projects }, null, 2) }] };
    },
  );

  server.registerTool(
    'project_get',
    {
      title: 'Read a shared project',
      description:
        'Read the live project document when the user names a project. Call this at session start so ' +
        'you pick up Current Status, Next Actions, and the Log. The ' +
        'live document keeps only its newest Log entries; pass history: true to also get the archive ' +
        'memories holding older entries, newest first.',
      inputSchema: {
        project: projectSlugSchema.describe('Project slug, e.g. "northkeep" for scope project:northkeep'),
        history: z.boolean().optional().describe('Also return the Log archives for this project (older entries), newest first'),
      },
    },
    async ({ project, history }) => {
      const auditFail = async (): Promise<void> => {
        await storage.appendAudit({
          ts: new Date().toISOString(),
          accountHash,
          tool: 'project_get',
          params: {},
          ok: false,
          resultCount: 0,
          resultIds: [],
        });
      };
      // Slug-exact: reject before any storage read. A prefix-only project: scope is not a project.
      if (!PROJECT_SLUG_PATTERN.test(project ?? '')) {
        await auditFail();
        return {
          content: [{ type: 'text', text: `Invalid project slug "${project ?? ''}".` }],
          isError: true,
        };
      }
      let all: SharedEntry[];
      try {
        all = await visibleEntries();
      } catch (err) {
        if (err instanceof ConnectorCryptoError) return reencryptResult('project_get');
        throw err;
      }
      const scope = projectScope(project);
      const picked = selectProjectWorkingDoc(all.filter((e) => e.scope === scope));
      if (!picked) {
        await auditFail();
        return {
          content: [{ type: 'text', text: `No live project document for "${project}".` }],
          isError: true,
        };
      }
      const archives = history
        ? all
            .filter((e) => e.scope === scope && e.type === 'episodic' && isProjectLogArchive(e.content))
            .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        : [];
      await storage.appendAudit({
        ts: new Date().toISOString(),
        accountHash,
        tool: 'project_get',
        params: {},
        ok: true,
        resultCount: 1 + archives.length,
        resultIds: [picked.entryId, ...archives.map((a) => a.entryId)],
      });
      const text = archives.length === 0
        ? picked.content
        : `${picked.content}\n\n---\n\n${archives.map((a) => a.content).join('\n\n---\n\n')}`;
      return { content: [{ type: 'text', text }] };
    },
  );

  // ---- project_create (ADR 0050) ----------------------------------------
  // Decision 3, in order, nothing stored unless every check passes: slug before
  // any storage read, then the unconditional tombstone check, then "no working
  // document in this scope", then the cap, then the document size.
  server.registerTool(
    'project_create',
    {
      title: 'Create a project',
      description:
        'Create a project with project_create only when the user asks for one; never create one to ' +
        'hold notes that belong in an existing project or in a memory. Give What & Why and the ' +
        'Current Status; Log and Decisions start empty. The project becomes Shared with this app ' +
        'when it lands in the user\u2019s vault, so everything later written into it is visible here. ' +
        'Use project_update to change a project that already exists.',
      inputSchema: {
        project: projectSlugSchema.describe('Project slug, e.g. "northkeep" for scope project:northkeep'),
        what_why: z.string().min(1).max(16384).describe('What this project is and why it exists'),
        status: z.string().min(1).max(16384).describe('Where the project stands right now'),
        next_actions: z.string().max(16384).optional().describe('The next concrete actions'),
      },
    },
    async ({ project, what_why, status, next_actions }) => {
      const auditFail = async (): Promise<void> => {
        await storage.appendAudit({
          ts: new Date().toISOString(),
          accountHash,
          tool: 'project_create',
          params: {},
          ok: false,
          resultCount: 0,
          resultIds: [],
        });
      };
      const refuse = async (text: string) => {
        await auditFail();
        return { content: [{ type: 'text' as const, text }], isError: true as const };
      };
      if (!PROJECT_SLUG_PATTERN.test(project ?? '')) {
        return refuse(`Invalid project slug "${project ?? ''}".`);
      }
      // Core's rule, before any storage read: text the vault would refuse must
      // never land as the first document in a scope.
      const textError = firstProjectTextError([
        ['what_why', what_why, false],
        ['status', status, false],
        ['next_actions', next_actions, true],
      ]);
      if (textError !== null) return refuse(textError);
      // An empty next_actions is the local tool's "omitted", not an empty body.
      const nextActions = next_actions === '' ? undefined : next_actions;
      const scope = projectScope(project);
      if ((await tombstonedScopes()).has(scope)) return refuse(TOMBSTONE_USER_MESSAGE);

      // Every stored row, including pending ones and rows with a queued forget:
      // visibleEntries() hides a forget-queued row, which would read as empty.
      const existing = await storage.listEntries(accountHash);
      const inScope = existing.filter((e) => e.scope === scope);
      let hasWorkingDoc: boolean;
      try {
        const types = await Promise.all(
          inScope.map(async (e) =>
            isEncryptedRow(e.content) ? (await decryptRow(e.content, accountHash, dek)).type : e.type,
          ),
        );
        hasWorkingDoc = types.includes('working');
      } catch (err) {
        if (err instanceof ConnectorCryptoError) return reencryptResult('project_create');
        throw err;
      }
      if (hasWorkingDoc) return refuse('Project already exists; use project_update.');

      if (existing.length + 1 > MAX_SHARED_ENTRIES) {
        return refuse(
          `Nothing was saved: this account is at the shared-memory cap (${MAX_SHARED_ENTRIES}). Ask the user to remove some shared memories in NorthKeep first.`,
        );
      }
      let markdown: string;
      try {
        markdown = serializeProjectDoc(
          mergeProjectDoc(emptyProjectDoc(), {
            whatWhy: what_why,
            status,
            nextActions,
          }),
        );
        assertProjectDocSize(markdown);
      } catch (err) {
        return refuse(err instanceof Error ? err.message : 'Nothing was saved: the document could not be built.');
      }
      // Deterministic per scope so two concurrent creates collapse into one row
      // on the (account, entry id) upsert, which no lock could do on Neon.
      const entryId = `conn_create_${createHash('sha256').update(scope).digest('hex').slice(0, 32)}`;
      await storage.putEntry(accountHash, {
        entryId,
        scope,
        type: '',
        content: await encryptRow({ accountHash, type: 'working', content: markdown }, dek),
        entryHash: '',
        origin: 'connector',
        pending: true,
        createdAt: new Date().toISOString(),
      });
      await storage.appendAudit({
        ts: new Date().toISOString(),
        accountHash,
        tool: 'project_create',
        params: {},
        ok: true,
        resultCount: 1,
        resultIds: [entryId],
      });
      return {
        content: [
          { type: 'text', text: `Created project "${project}". It will sync into the vault. (id: ${entryId})` },
        ],
      };
    },
  );

  server.registerTool(
    'project_update',
    {
      title: 'Update a shared project',
      description:
        'Update a shared project document. Call this when a working session ends, with the new ' +
        'Current Status, Next Actions, and a log entry describing what was done. Optional What & Why ' +
        'replacement and a dated decision. Updates merge into the existing sections; they do not ' +
        'replace the whole document. The live document keeps only its newest Log entries; older ones ' +
        'roll into an archive memory in the project scope (the result says so), so a log entry is ' +
        'never refused for size. Only hand-written sections over 16384 characters are refused. ' +
        'NorthKeep never truncates. This tool only updates a project that already has a live document; ' +
        'use project_create for a new project.',
      inputSchema: {
        project: projectSlugSchema.describe('Project slug, e.g. "northkeep"'),
        what_why: z.string().min(1).max(16384).optional().describe('Replacement What & Why section'),
        status: z.string().min(1).max(16384).optional().describe('Replacement Current Status section'),
        next_actions: z.string().min(1).max(16384).optional().describe('Replacement Next Actions section'),
        log_entry: z
          .string()
          .min(1)
          .max(4096)
          .optional()
          .describe('New Log entry (newest first), a few hundred characters at most; put detail in its own episodic memory in the project scope. Do not include a date; the tool prefixes YYYY-MM-DD.'),
        decision: z
          .string()
          .min(1)
          .max(4096)
          .optional()
          .describe('New Decisions entry (appended). Do not include a date; the tool prefixes YYYY-MM-DD.'),
      },
    },
    async ({ project, what_why, status, next_actions, log_entry, decision }) => {
      const auditFail = async (): Promise<void> => {
        await storage.appendAudit({
          ts: new Date().toISOString(),
          accountHash,
          tool: 'project_update',
          params: {},
          ok: false,
          resultCount: 0,
          resultIds: [],
        });
      };
      if (!PROJECT_SLUG_PATTERN.test(project ?? '')) {
        await auditFail();
        return {
          content: [{ type: 'text', text: `Invalid project slug "${project ?? ''}".` }],
          isError: true,
        };
      }
      if (
        what_why === undefined &&
        status === undefined &&
        next_actions === undefined &&
        log_entry === undefined &&
        decision === undefined
      ) {
        await auditFail();
        return {
          content: [
            {
              type: 'text',
              text: 'Nothing was saved: provide at least one of what_why, status, next_actions, log_entry, or decision.',
            },
          ],
          isError: true,
        };
      }
      const updateTextError = firstProjectTextError([
        ['what_why', what_why, false],
        ['status', status, false],
        ['next_actions', next_actions, true],
        ['log_entry', log_entry, false],
        ['decision', decision, false],
      ]);
      if (updateTextError !== null) {
        await auditFail();
        return { content: [{ type: 'text', text: updateTextError }], isError: true };
      }
      const scope = projectScope(project);
      // The revoke wins over a write that raced it, whatever the enforcement
      // flag says (ADR 0050 Decision 3). Only a re-share from NorthKeep reopens.
      if ((await tombstonedScopes()).has(scope)) {
        await auditFail();
        return { content: [{ type: 'text', text: TOMBSTONE_USER_MESSAGE }], isError: true };
      }
      let all: SharedEntry[];
      try {
        all = await visibleEntries();
      } catch (err) {
        if (err instanceof ConnectorCryptoError) return reencryptResult('project_update');
        throw err;
      }
      const base = selectProjectWorkingDoc(all.filter((e) => e.scope === scope));
      if (!base) {
        await auditFail();
        return {
          content: [
            {
              type: 'text',
              text: `Nothing was saved: no live project document for "${project}". Use project_create to start one, or ask the user to share the project from NorthKeep.`,
            },
          ],
          isError: true,
        };
      }
      let markdown: string;
      let archivedEntries: string[] = [];
      try {
        const merged = mergeProjectDoc(parseProjectDoc(base.content), toProjectUpdate({
          what_why,
          status,
          next_actions,
          log_entry,
          decision,
        }));
        // ADR 0045: roll the oldest Log entries into an archive memory rather
        // than refuse; only hand-written sections can still be too long.
        const rolled = rollProjectLog(merged);
        markdown = serializeProjectDoc(rolled.doc);
        assertProjectDocSize(markdown);
        archivedEntries = rolled.archived;
      } catch (err) {
        await auditFail();
        const text = err instanceof Error && err.message === PROJECT_DOC_CAP_MESSAGE
          ? PROJECT_DOC_CAP_MESSAGE
          : err instanceof Error
            ? err.message
            : 'Nothing was saved: the merge failed.';
        return { content: [{ type: 'text', text }], isError: true };
      }
      const overwrite = base.pending === true;
      const existing = await storage.listEntries(accountHash);
      const rowsNeeded = (overwrite ? 0 : 1) + (archivedEntries.length > 0 ? 1 : 0);
      if (rowsNeeded > 0 && existing.length + rowsNeeded > MAX_SHARED_ENTRIES) {
        await auditFail();
        return {
          content: [
            {
              type: 'text',
              text: `Nothing was saved: this account is at the shared-memory cap (${MAX_SHARED_ENTRIES}). Ask the user to remove some shared memories in NorthKeep first.`,
            },
          ],
          isError: true,
        };
      }
      const entryId = overwrite ? base.entryId : `conn_${randomUUID().replace(/-/g, '')}`;
      await storage.putEntry(accountHash, {
        entryId,
        scope,
        type: '',
        content: await encryptRow({ accountHash, type: 'working', content: markdown }, dek),
        entryHash: '',
        origin: 'connector',
        pending: true,
        createdAt: new Date().toISOString(),
      });
      let archiveId: string | null = null;
      if (archivedEntries.length > 0) {
        archiveId = `conn_${randomUUID().replace(/-/g, '')}`;
        await storage.putEntry(accountHash, {
          entryId: archiveId,
          scope,
          type: '',
          content: await encryptRow(
            { accountHash, type: 'episodic', content: formatLogArchive(project, archivedEntries) },
            dek,
          ),
          entryHash: '',
          origin: 'connector',
          pending: true,
          createdAt: new Date().toISOString(),
        });
      }
      await storage.appendAudit({
        ts: new Date().toISOString(),
        accountHash,
        tool: 'project_update',
        params: {},
        ok: true,
        resultCount: archiveId ? 2 : 1,
        resultIds: archiveId ? [entryId, archiveId] : [entryId],
      });
      const rolledNote = archiveId
        ? ` Archived ${archivedEntries.length} older log entries to ${archiveId}; project_get with history: true shows them.`
        : '';
      return {
        content: [
          {
            type: 'text',
            text: `Updated project "${project}". It will sync into the vault. (id: ${entryId})${rolledNote}`,
          },
        ],
      };
    },
  );

  return server;
}
