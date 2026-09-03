import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  MEMORY_TYPES,
  Vault,
  VaultAuthError,
  VaultSchemaError,
  assertProjectDocSize,
  defaultVaultPath,
  emptyProjectDoc,
  firstNonEmptyLine,
  getProjectSection,
  isProjectScope,
  isValidProjectSlug,
  mergeProjectDoc,
  parseProjectDoc,
  projectScope,
  serializeProjectDoc,
  setPlatform,
  withFileLock,
  type MemoryEntry,
  type MemoryType,
} from '@northkeep/core';
import { nodePlatform } from '@northkeep/platform-node';
import { applyTier1 } from '@northkeep/redact';
import { LOCKED_MESSAGE, resolveMasterKey } from './key.js';
import { createStandaloneAutoSync, flushBounded, type StandaloneAutoSync } from './auto-sync.js';
import { appendCallLog, type CallLogEntry } from './log.js';

/**
 * The MCP surface. Stdio transport; stdout is protocol, so all diagnostics go
 * to stderr. Every tool call opens the vault fresh under the file lock and
 * closes it before returning — the decrypted database never outlives a call,
 * and CLI/server writes cannot clobber each other.
 *
 * M4 adds capability enforcement: a connection is granted a set of scopes
 * (NORTHKEEP_SCOPES; unset = full owner access), and the server physically
 * cannot return or mutate entries outside the grant. Every call — including
 * denials — is written to the content-free audit log.
 */

/**
 * Scopes granted to this server instance, or undefined for full owner access.
 * Fail-CLOSED: only an *unset* variable means full access. A present-but-empty
 * value (`NORTHKEEP_SCOPES=`, whitespace, stray commas) means the operator
 * intended to restrict but the grant didn't parse — deny everything rather
 * than silently opening the whole vault.
 */
export function grantedScopes(): string[] | undefined {
  const raw = process.env.NORTHKEEP_SCOPES;
  if (raw === undefined) return undefined; // unset ⇒ full owner access
  const scopes = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return scopes; // present ⇒ exactly these (empty array ⇒ deny-all)
}

/** Optional Tier-1 masking of secrets in returned content (NORTHKEEP_REDACT_TIER=1). */
function returnRedactionTier(): 0 | 1 {
  return process.env.NORTHKEEP_REDACT_TIER === '1' ? 1 : 0;
}

/** Mutable connection context, filled from the MCP initialize handshake. */
interface ConnContext {
  provider: string;
}

const typeEnum = z.enum(MEMORY_TYPES);

// Bounded, tame-charset params. This is load-bearing for the content-free
// call log: id and scope get logged verbatim, so a prompt-injected client
// must not be able to smuggle vault content into them (or wildcard-match
// ids with LIKE metacharacters).
const idSchema = z
  .string()
  .regex(/^[0-9a-f-]{8,36}$/i, 'must be a memory id (hex characters and dashes)');
const scopeSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9:_.-]+$/i, 'scopes are short tags like "personal" or "client:acme"');
const projectSlugSchema = z
  .string()
  .regex(/^[a-z0-9-]{1,40}$/, 'project slugs are 1-40 lowercase letters, digits, or hyphens');

interface ToolOk {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function ok(payload: unknown): ToolOk {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function err(message: string): ToolOk {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function publicEntry(entry: MemoryEntry) {
  return {
    id: entry.id,
    type: entry.type,
    content: entry.content,
    scope: entry.scope,
    source: entry.source,
    confidence: entry.confidence,
    created_at: entry.created_at,
  };
}

async function withVault<T>(
  vaultPath: string,
  fn: (vault: Vault) => T,
): Promise<T> {
  const resolved = resolveMasterKey(vaultPath);
  if (resolved === null) throw new LockedError();
  return withFileLock(vaultPath, () => {
    let vault: Vault;
    try {
      vault = Vault.openWithKey(vaultPath, resolved.key);
    } catch (err) {
      if (err instanceof VaultAuthError && resolved.source === 'keychain') {
        throw new VaultAuthError(
          'Stored key no longer matches the vault. Ask the user to run "northkeep unlock" again.',
        );
      }
      // This process is older than the vault: it was spawned before a schema
      // migration and cannot read it, and never will. Sitting here failing every
      // call is the worst option, because the build on disk is already current
      // and only this long-lived process is behind. Answer this call honestly,
      // then exit so the client's next request spawns a server on current code.
      if (err instanceof VaultSchemaError) scheduleObsoleteExit(err.message);
      throw err;
    }
    try {
      return fn(vault);
    } finally {
      vault.close();
    }
  });
}

class LockedError extends Error {
  constructor() {
    super(LOCKED_MESSAGE);
    this.name = 'LockedError';
  }
}

type LogParams = CallLogEntry['params'];

class ScopeDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeDeniedError';
  }
}

interface RunOutcome {
  payload: unknown;
  result_count?: number;
  result_id?: string;
  result_ids?: string[];
  disclosed_scopes?: string[];
}

async function run(
  ctx: ConnContext,
  tool: string,
  params: LogParams,
  vaultPath: string,
  fn: (vault: Vault, granted: string[] | undefined) => RunOutcome,
): Promise<ToolOk> {
  const granted = grantedScopes();
  const base = {
    ts: new Date().toISOString(),
    tool,
    provider: ctx.provider,
    granted_scopes: granted,
    redaction_tier: returnRedactionTier(),
    params,
  };
  try {
    const outcome = await withVault(vaultPath, (vault) => fn(vault, granted));
    appendCallLog({
      ...base,
      ok: true,
      result_count: outcome.result_count,
      result_id: outcome.result_id,
      result_ids: outcome.result_ids,
      disclosed_scopes: outcome.disclosed_scopes,
    });
    return ok(outcome.payload);
  } catch (error) {
    const denied = error instanceof ScopeDeniedError;
    const message = error instanceof Error ? error.message : String(error);
    appendCallLog({ ...base, ok: false, denied, error: message.slice(0, 200) });
    return err(message);
  }
}

/**
 * Opt-in Tier-1 secret masking of content before it leaves the vault toward
 * the model. Synchronous (Tier-1 is pure regex — no Ollama), so it's safe to
 * run while the vault is open. Tier-2 pseudonymization is NOT applied over MCP
 * because there's no response hook to restore names — that needs a proxy
 * (parked decision).
 */
function maskContent<T extends { content: string }>(entries: T[]): T[] {
  if (returnRedactionTier() === 0) return entries;
  return entries.map((e) => ({ ...e, content: applyTier1(e.content).text }));
}

function distinctScopes(scopes: string[]): string[] {
  return [...new Set(scopes)].sort();
}

function assertGrantedScope(scope: string, granted: string[] | undefined): void {
  if (granted !== undefined && !granted.includes(scope)) {
    throw new ScopeDeniedError(
      `This connection is not granted the "${scope}" scope (granted: ${granted.join(', ') || '(none)'}).`,
    );
  }
}

/** Newest live `working` entry in a scope. `list` is insertion order, so last wins. */
function newestLiveWorking(
  vault: Vault,
  scope: string,
  granted: string[] | undefined,
): MemoryEntry | undefined {
  const rows = vault.list({ type: 'working', scope, allowedScopes: granted });
  return rows.length === 0 ? undefined : rows[rows.length - 1];
}

function liveProjectIndex(vault: Vault, granted: string[] | undefined): MemoryEntry[] {
  const rows = vault.list({ type: 'working', allowedScopes: granted }).filter((e) => isProjectScope(e.scope));
  const byScope = new Map<string, MemoryEntry>();
  for (const row of rows) byScope.set(row.scope, row);
  return [...byScope.values()].sort((a, b) => a.scope.localeCompare(b.scope));
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

export function createServer(vaultPath: string = defaultVaultPath()): McpServer {
  const server = new McpServer({ name: 'northkeep', version: '0.5.0' });
  const ctx: ConnContext = { provider: 'unknown' };
  // Capture the calling client's name once it completes the MCP handshake.
  server.server.oninitialized = () => {
    const info = server.server.getClientVersion();
    if (info?.name) {
      // Bound and tame the client-supplied name before it reaches the audit
      // log (defense-in-depth alongside the CSV formula guard).
      const raw = `${info.name}${info.version ? `@${info.version}` : ''}`;
      ctx.provider = raw.replace(/[\x00-\x1f,"]/g, ' ').slice(0, 80);
    }
  };

  server.registerTool(
    'memory_retrieve',
    {
      title: 'Retrieve memories',
      description:
        "Search the user's personal memory vault for facts, preferences, past events, and " +
        'how they like things done. Call this at the start of a conversation and whenever ' +
        'personal context would help. Returns entries ranked by relevance (keyword + recency).',
      inputSchema: {
        query: z.string().max(1024).describe('What you want to know about the user'),
        type: typeEnum.optional().describe('Restrict to one memory type'),
        scope: scopeSchema.optional().describe('Restrict to one scope, e.g. "personal" or "work"'),
        limit: z.number().int().min(1).max(25).optional().describe('Max results (default 8)'),
      },
    },
    async ({ query, type, scope, limit }) =>
      run(
        ctx,
        'memory_retrieve',
        { query_terms: query.split(/\s+/).filter(Boolean).length, type, scope, limit },
        vaultPath,
        (vault, granted) => {
          const results = vault.retrieve(query, {
            type: type as MemoryType,
            scope,
            limit,
            allowedScopes: granted,
          });
          const entries = maskContent(
            results.map((r) => ({ ...publicEntry(r.entry), relevance: Number(r.score.toFixed(3)) })),
          );
          return {
            payload: {
              results: entries,
              note: results.length === 0 ? 'No matching memories. Retrieval is keyword-based; try different words.' : undefined,
            },
            result_count: results.length,
            result_ids: results.map((r) => r.entry.id),
            disclosed_scopes: distinctScopes(results.map((r) => r.entry.scope)),
          };
        },
      ),
  );

  server.registerTool(
    'memory_remember',
    {
      title: 'Store a memory',
      description:
        "Save a durable fact, preference, event, or procedure to the user's memory vault. " +
        'Store single, self-contained statements (one fact per call). Types: episodic (things ' +
        'that happened), semantic (durable facts), procedural (how the user likes things done), ' +
        'working (current context, ages out), identity (stable profile).',
      inputSchema: {
        content: z
          .string()
          .min(1)
          .max(8192)
          .describe('The memory, one self-contained natural-language statement'),
        type: typeEnum.describe('Memory type'),
        scope: scopeSchema.optional().describe('Scope tag (default "personal")'),
        confidence: z.number().min(0).max(1).optional().describe('Confidence 0-1 (default 0.9 for model-stored)'),
      },
    },
    async ({ content, type, scope, confidence }) =>
      run(
        ctx,
        'memory_remember',
        { content_chars: content.length, type, scope },
        vaultPath,
        (vault, granted) => {
          const targetScope = scope ?? 'personal';
          // Capability enforcement: can't write outside the granted scopes.
          if (granted !== undefined && !granted.includes(targetScope)) {
            throw new ScopeDeniedError(
              `This connection is not granted the "${targetScope}" scope (granted: ${granted.join(', ')}).`,
            );
          }
          const entry = vault.remember({
            content,
            type: type as MemoryType,
            scope,
            source: 'mcp',
            sourceModel: 'mcp-client',
            confidence: confidence ?? 0.9,
          });
          vault.save();
          return {
            payload: { stored: publicEntry(entry) },
            result_id: entry.id,
            disclosed_scopes: [entry.scope],
          };
        },
      ),
  );

  server.registerTool(
    'memory_list',
    {
      title: 'List memories',
      description:
        "Browse the user's memory vault without a search query — newest last. " +
        'Useful for "what do you know about me?" style questions.',
      inputSchema: {
        type: typeEnum.optional().describe('Filter by memory type'),
        scope: scopeSchema.optional().describe('Filter by scope'),
        limit: z.number().int().min(1).max(100).optional().describe('Max results (default 50)'),
      },
    },
    async ({ type, scope, limit }) =>
      run(ctx, 'memory_list', { type, scope, limit }, vaultPath, (vault, granted) => {
        const rows = vault
          .list({ type: type as MemoryType, scope, allowedScopes: granted })
          .slice(-(limit ?? 50));
        const entries = maskContent(rows.map(publicEntry));
        return {
          payload: { memories: entries },
          result_count: entries.length,
          result_ids: rows.map((e) => e.id),
          disclosed_scopes: distinctScopes(rows.map((e) => e.scope)),
        };
      }),
  );

  server.registerTool(
    'memory_forget',
    {
      title: 'Forget a memory',
      description:
        'Permanently remove the content of one memory from the vault, by id (from ' +
        'memory_retrieve or memory_list). Only call this when the user asks you to forget something.',
      inputSchema: {
        id: idSchema.describe('The id of the memory to forget'),
      },
    },
    async ({ id }) =>
      run(ctx, 'memory_forget', { id }, vaultPath, (vault, granted) => {
        const tombstone = vault.forget(id, granted); // enforces scope: unseeable = unforgettable
        vault.save();
        return {
          payload: { forgotten: { id: tombstone.id, forgotten_at: tombstone.forgotten_at } },
          result_id: tombstone.id,
          disclosed_scopes: [tombstone.scope],
        };
      }),
  );

  server.registerTool(
    'memory_edit',
    {
      title: 'Edit a memory',
      description:
        'Correct or update an existing memory instead of storing a near-duplicate. Pass the id from ' +
        'memory_retrieve or memory_list. Optional new content and/or type. This tool cannot change a ' +
        "memory's scope; moving a memory between scopes stays in the NorthKeep app and CLI.",
      inputSchema: {
        id: idSchema.describe('The id of the memory to edit'),
        content: z
          .string()
          .min(1)
          .max(16384)
          .optional()
          .describe('Replacement content (omit to leave content unchanged)'),
        type: typeEnum.optional().describe('Replacement memory type (omit to leave type unchanged)'),
      },
    },
    async ({ id, content, type }) =>
      run(
        ctx,
        'memory_edit',
        { id, content_chars: content?.length, type },
        vaultPath,
        (vault, granted) => {
          if (content === undefined && type === undefined) {
            throw new Error('Provide content and/or type to edit.');
          }
          // Scope is intentionally omitted from the patch (ADR 0039). Do not
          // forward extra request keys even if a future SDK starts passing them.
          const patch: { content?: string; type?: MemoryType } = {};
          if (content !== undefined) patch.content = content;
          if (type !== undefined) patch.type = type as MemoryType;
          const edited = vault.editMemory(id, patch, granted);
          vault.save();
          return {
            payload: { edited: publicEntry(edited) },
            result_id: edited.id,
            disclosed_scopes: [edited.scope],
          };
        },
      ),
  );

  server.registerTool(
    'project_list',
    {
      title: 'List projects',
      description:
        "List the user's live projects. Each row is a project scope plus the first line of Current " +
        'Status. This list is the project index; there is no separate index memory. Call this to see ' +
        'what is in flight.',
      inputSchema: {},
    },
    async () =>
      run(ctx, 'project_list', {}, vaultPath, (vault, granted) => {
        const docs = liveProjectIndex(vault, granted);
        const projects = docs.map((entry) => ({
          project: entry.scope.slice('project:'.length),
          scope: entry.scope,
          status: statusFirstLine(entry.content),
          id: entry.id,
          updated_at: entry.created_at,
        }));
        return {
          payload: { projects },
          result_count: projects.length,
          result_ids: docs.map((e) => e.id),
          disclosed_scopes: distinctScopes(docs.map((e) => e.scope)),
        };
      }),
  );

  server.registerTool(
    'project_get',
    {
      title: 'Read a project',
      description:
        'Read the live project document when the user names a project. Call this at session start so ' +
        'you pick up Current Status, Next Actions, and the Log. If more than one live working memory ' +
        'exists in the scope, the newest wins.',
      inputSchema: {
        project: projectSlugSchema.describe('Project slug, e.g. "northkeep" for scope project:northkeep'),
      },
    },
    async ({ project }) =>
      run(ctx, 'project_get', { scope: `project:${project}` }, vaultPath, (vault, granted) => {
        if (!isValidProjectSlug(project)) {
          throw new Error(`Invalid project slug "${project}".`);
        }
        const scope = projectScope(project);
        assertGrantedScope(scope, granted);
        const live = newestLiveWorking(vault, scope, granted);
        if (!live) {
          throw new Error(`No live project document for "${project}".`);
        }
        return {
          payload: { project, ...publicEntry(live) },
          result_id: live.id,
          disclosed_scopes: [live.scope],
        };
      }),
  );

  server.registerTool(
    'project_update',
    {
      title: 'Update a project',
      description:
        'Create or update a project document. Call this when a working session ends, with the new ' +
        'Current Status, Next Actions, and a log entry describing what was done. Optional What & Why ' +
        'replacement and a dated decision. Updates merge into the existing sections; they do not ' +
        'replace the whole document. Documents over 16384 characters are refused: prune the Log and ' +
        'try again. NorthKeep will not silently truncate.',
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
          .describe('New Log entry (newest first). Do not include a date; the tool prefixes YYYY-MM-DD.'),
        decision: z
          .string()
          .min(1)
          .max(4096)
          .optional()
          .describe('New Decisions entry (appended). Do not include a date; the tool prefixes YYYY-MM-DD.'),
      },
    },
    async ({ project, what_why, status, next_actions, log_entry, decision }) =>
      run(
        ctx,
        'project_update',
        {
          scope: `project:${project}`,
          content_chars:
            (what_why?.length ?? 0) +
            (status?.length ?? 0) +
            (next_actions?.length ?? 0) +
            (log_entry?.length ?? 0) +
            (decision?.length ?? 0),
        },
        vaultPath,
        (vault, granted) => {
          if (!isValidProjectSlug(project)) {
            throw new Error(`Invalid project slug "${project}".`);
          }
          if (
            what_why === undefined &&
            status === undefined &&
            next_actions === undefined &&
            log_entry === undefined &&
            decision === undefined
          ) {
            throw new Error(
              'Provide at least one of what_why, status, next_actions, log_entry, or decision.',
            );
          }
          const scope = projectScope(project);
          assertGrantedScope(scope, granted);
          const update = toProjectUpdate({ what_why, status, next_actions, log_entry, decision });
          const live = newestLiveWorking(vault, scope, granted);
          const merged = mergeProjectDoc(live ? parseProjectDoc(live.content) : emptyProjectDoc(), update);
          const content = serializeProjectDoc(merged);
          assertProjectDocSize(content);
          if (!live) {
            const entry = vault.remember({
              content,
              type: 'working',
              scope,
              source: 'mcp',
              sourceModel: 'mcp-client',
              confidence: 0.9,
            });
            vault.save();
            return {
              payload: { created: true, project, ...publicEntry(entry) },
              result_id: entry.id,
              disclosed_scopes: [entry.scope],
            };
          }
          const edited = vault.editMemory(live.id, { content }, granted);
          vault.save();
          return {
            payload: { created: false, project, ...publicEntry(edited) },
            result_id: edited.id,
            disclosed_scopes: [edited.scope],
          };
        },
      ),
  );

  return server;
}

export async function startServer(vaultPath?: string): Promise<void> {
  // Register the Node platform adapters before any vault/crypto op (ADR 0018).
  // This is the standalone server's entry (Claude Desktop launches it); when
  // web/cli import this package they call setPlatform in their own startup.
  setPlatform(nodePlatform());
  const resolvedVaultPath = vaultPath ?? defaultVaultPath();
  const server = createServer(resolvedVaultPath);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  isStandaloneStdioServer = true;
  // ADR 0044: only the standalone process owns an engine. When these tools are
  // embedded (web/CLI import createServer), the host runs its own.
  const sync = createStandaloneAutoSync(resolvedVaultPath);
  installShutdownOnClientExit(server, sync);
  console.error('northkeep MCP server ready (stdio)');
  // A session starting is a wake: one status request, then a fast-forward
  // pull if the server is ahead and this vault is untouched. Never blocks
  // readiness, and failures only log.
  void sync.auto.wake().catch(() => {});
}

/**
 * Exit when the client goes away.
 *
 * The SDK's StdioServerTransport.start() subscribes to stdin 'data' and 'error'
 * ONLY. It never listens for 'end' or 'close', and its onclose fires only from
 * an explicit close() call. So when a client quits, or its process dies, or the
 * pipe is closed, this process just sits there: stdin at EOF, nothing left to
 * read, still running.
 *
 * That is not merely untidy. Observed 2026-07-30: 25 orphaned servers across
 * several days of finished Claude and Codex sessions, some over a week old.
 * Each one keeps whatever code it was started with, so when the vault migrated
 * to schema 0.3 they carried on holding 0.2 and every write through them failed
 * — in three different apps at once, silently, while the on-disk build was
 * perfectly current. An orphan is a landmine, not a leak.
 *
 * EOF on stdin is the signal, and it is reliable here because the transport's
 * own 'data' listener puts stdin in flowing mode. An interactive run (stdin a
 * TTY) still waits for a real Ctrl-D, which is what you want.
 */
/**
 * Exit shortly after answering a call that proved this build is obsolete.
 *
 * Deliberately NOT immediate: the caller still needs the error written to
 * stdout, and killing the process first would turn a clear "update NorthKeep"
 * into a silent transport failure. The delay is long enough to flush and short
 * enough that the next request gets a fresh process.
 *
 * Only meaningful for the standalone stdio server, so it no-ops when the server
 * is embedded (web/CLI import these tools in-process, and exiting there would
 * take the whole app down).
 */
let obsoleteExitScheduled = false;
function scheduleObsoleteExit(detail: string): void {
  if (obsoleteExitScheduled || !isStandaloneStdioServer) return;
  obsoleteExitScheduled = true;
  console.error(`northkeep MCP server is out of date and exiting so a current one starts: ${detail}`);
  setTimeout(() => process.exit(0), 250).unref();
}

/** Set by startServer(); false when these tools are imported in-process. */
let isStandaloneStdioServer = false;

/** Longest a pending push may hold up shutdown (ADR 0044); the write stays on disk if it runs out. */
const SHUTDOWN_FLUSH_BUDGET_MS = 1500;
/** Hard exit backstop: the flush budget plus the transport close, with room to spare. */
const SHUTDOWN_HARD_EXIT_MS = 3500;

function installShutdownOnClientExit(
  server: { close: () => Promise<void> },
  sync: StandaloneAutoSync | null = null,
): void {
  let shuttingDown = false;
  const shutdown = (reason: string, code = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`northkeep MCP server exiting (${reason})`);
    // Close the transport, then leave regardless: a hung close must not be the
    // thing that recreates the orphan this function exists to prevent. A
    // pending push gets a bounded chance first (ADR 0044) so a memory written
    // at the end of a session reaches the other devices.
    const done = (): never => process.exit(code);
    const flushed = sync ? flushBounded(sync.auto, SHUTDOWN_FLUSH_BUDGET_MS) : Promise.resolve('flushed' as const);
    flushed
      .then((outcome) => {
        // 'failed' already logged its own line inside flushBounded.
        if (outcome === 'timeout') {
          console.error('northkeep MCP server exiting with a push still pending (the next wake sends it)');
        }
        sync?.dispose();
      })
      .then(() => server.close())
      .then(done, done);
    setTimeout(done, SHUTDOWN_HARD_EXIT_MS).unref();
  };

  // The client disconnected, or its process died and closed the pipe.
  process.stdin.once('end', () => shutdown('client closed stdin'));
  process.stdin.once('close', () => shutdown('stdin closed'));
  // A read error on stdin means the pipe is gone too.
  process.stdin.once('error', () => shutdown('stdin error', 1));
  // Ordinary termination: still close the transport rather than dying mid-write.
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}
