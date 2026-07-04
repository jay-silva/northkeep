import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  MEMORY_TYPES,
  Vault,
  VaultAuthError,
  defaultVaultPath,
  withFileLock,
  type MemoryEntry,
  type MemoryType,
} from '@northkeep/core';
import { LOCKED_MESSAGE, resolveMasterKey } from './key.js';
import { appendCallLog, type CallLogEntry } from './log.js';

/**
 * The MCP surface (M1). Stdio transport; stdout is protocol, so all
 * diagnostics go to stderr. Every tool call opens the vault fresh under the
 * file lock and closes it before returning — the decrypted database never
 * outlives a call, and CLI/server writes cannot clobber each other.
 */

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

async function run(
  tool: string,
  params: LogParams,
  vaultPath: string,
  fn: (vault: Vault) => { payload: unknown; result_count?: number; result_id?: string },
): Promise<ToolOk> {
  const base = { ts: new Date().toISOString(), tool, params };
  try {
    const outcome = await withVault(vaultPath, fn);
    appendCallLog({
      ...base,
      ok: true,
      result_count: outcome.result_count,
      result_id: outcome.result_id,
    });
    return ok(outcome.payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendCallLog({ ...base, ok: false, error: message.slice(0, 200) });
    return err(message);
  }
}

export function createServer(vaultPath: string = defaultVaultPath()): McpServer {
  const server = new McpServer({ name: 'northkeep', version: '0.2.0' });

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
        'memory_retrieve',
        { query_terms: query.split(/\s+/).filter(Boolean).length, type, scope, limit },
        vaultPath,
        (vault) => {
          const results = vault.retrieve(query, { type: type as MemoryType, scope, limit });
          return {
            payload: {
              results: results.map((r) => ({ ...publicEntry(r.entry), relevance: Number(r.score.toFixed(3)) })),
              note: results.length === 0 ? 'No matching memories. Retrieval is keyword-based; try different words.' : undefined,
            },
            result_count: results.length,
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
        'memory_remember',
        { content_chars: content.length, type, scope },
        vaultPath,
        (vault) => {
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
      run('memory_list', { type, scope, limit }, vaultPath, (vault) => {
        const entries = vault
          .list({ type: type as MemoryType, scope })
          .slice(-(limit ?? 50))
          .map(publicEntry);
        return { payload: { memories: entries }, result_count: entries.length };
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
      run('memory_forget', { id }, vaultPath, (vault) => {
        const tombstone = vault.forget(id);
        vault.save();
        return {
          payload: { forgotten: { id: tombstone.id, forgotten_at: tombstone.forgotten_at } },
          result_id: tombstone.id,
        };
      }),
  );

  return server;
}

export async function startServer(vaultPath?: string): Promise<void> {
  const server = createServer(vaultPath);
  await server.connect(new StdioServerTransport());
  console.error('northkeep MCP server ready (stdio)');
}
