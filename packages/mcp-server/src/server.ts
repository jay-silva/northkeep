import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  MEMORY_TYPES,
  Vault,
  VaultAuthError,
  VaultSchemaError,
  defaultVaultPath,
  setPlatform,
  withFileLock,
  type MemoryEntry,
  type MemoryType,
} from '@northkeep/core';
import { nodePlatform } from '@northkeep/platform-node';
import { applyTier1 } from '@northkeep/redact';
import { LOCKED_MESSAGE, resolveMasterKey } from './key.js';
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

  return server;
}

export async function startServer(vaultPath?: string): Promise<void> {
  // Register the Node platform adapters before any vault/crypto op (ADR 0018).
  // This is the standalone server's entry (Claude Desktop launches it); when
  // web/cli import this package they call setPlatform in their own startup.
  setPlatform(nodePlatform());
  const server = createServer(vaultPath);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  isStandaloneStdioServer = true;
  installShutdownOnClientExit(server);
  console.error('northkeep MCP server ready (stdio)');
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

function installShutdownOnClientExit(server: { close: () => Promise<void> }): void {
  let shuttingDown = false;
  const shutdown = (reason: string, code = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`northkeep MCP server exiting (${reason})`);
    // Close the transport, then leave regardless: a hung close must not be the
    // thing that recreates the orphan this function exists to prevent.
    const done = (): never => process.exit(code);
    server.close().then(done, done);
    setTimeout(done, 2000).unref();
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
