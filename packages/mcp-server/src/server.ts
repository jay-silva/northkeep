import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  BOARD_DEFAULT_STALE_DAYS,
  BOARD_MAX_STALE_DAYS,
  MEMORY_TYPES,
  ProjectHandoffError,
  Vault,
  VaultAuthError,
  VaultSchemaError,
  defaultVaultPath,
  getProjectRevision,
  getProjectView,
  isValidProjectSlug,
  listProjectViews,
  northkeepHome,
  projectScope,
  setPlatform,
  withFileLock,
  type MemoryEntry,
  type MemoryType,
  type ProjectCheckpointRequest,
  type ProjectFileReference,
  type ProjectUpdateRequest,
  type ProjectWriter,
} from '@northkeep/core';
import { nodePlatform } from '@northkeep/platform-node';
import { createCachedEmbedder, createOllamaEmbedder } from '@northkeep/librarian';
import type { PseudonymMap } from '@northkeep/redact';
import {
  TIER2_FAILED_MESSAGE,
  TIER3_DEGRADED_NOTE,
  contentWriteRefusal,
  maskReturnPayload,
  parseReturnRedactionTier,
  type ReturnTier,
} from './return-mask.js';
import { LOCKED_MESSAGE, resolveMasterKey } from './key.js';
import { createStandaloneAutoSync, flushBounded, type StandaloneAutoSync } from './auto-sync.js';
import { appendCallLog, readCallLogStrict, type CallLogEntry } from './log.js';
import { tameOneLine } from './text-safe.js';
import { readMirrorSummary } from './project-export-run.js';
import { collectBoard } from './project-board-run.js';
import type { OpenSession } from './open-sessions.js';
import {
  OPEN_SESSIONS_NOTE,
  OPEN_SESSIONS_UNREADABLE_NOTE,
  openSessions,
} from './open-sessions.js';

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

/** The valid return tier for this call; an invalid value is refused in run() (ADR 0060 D4). */
function returnRedactionTier(): ReturnTier {
  const parsed = parseReturnRedactionTier();
  return parsed.ok ? parsed.tier : 0;
}

/** Pseudonyms for Tiers 2 and 3, consistent for this process, RAM only, never logged. */
const returnPseudonyms: PseudonymMap = {};
let degradedNoticeWritten = false;

/** Mutable connection context, filled from the MCP initialize handshake. */
interface ConnContext {
  provider: string;
  /** Handshake name and version apart, because provenance stores them apart. */
  host: string;
  host_version: string | null;
  /** Minted per server process; identifies this session in the call log. */
  session_id: string;
}

/**
 * The shared one-line class, and only that: host and host_version land in JSON
 * provenance, never a CSV cell, so they do not need provider's , and " strip.
 */
function tameHandshakeField(value: string, max: number): string {
  return tameOneLine(value, max);
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

function receivingProjectView(view: ReturnType<typeof getProjectView>) {
  // The document is already here as parsed sections and files, so carrying
  // content and files_text as well serialized it twice and pushed a busy
  // project past the 24 KB brief budget. project_get returns the full text.
  const { content: _content, files_text: _files_text, ...rest } = view;
  return {
    ...rest,
    files: view.files?.map((file) => file.access === 'reported_available'
      ? { type: file.type, label: file.label, locator: file.locator, access: 'unverified' as const }
      : file),
    file_access_note:
      'File availability is reported from earlier work and must be checked again in this receiving environment.',
  };
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

/**
 * Search by meaning for memory_retrieve (owner request 2026-09-13): the same
 * loopback Ollama embedder the app uses, memoized per process so a long-lived
 * server pays the embedding cost once. RAM only; nothing new leaves the machine
 * (the redaction tier already talks to the same loopback runtime).
 */
const searchEmbedder = createCachedEmbedder({
  model: createOllamaEmbedder().model,
  // Resolve the loopback URL per call, not at module load: the URL comes from
  // the environment and tests point it at a fake or a closed port after import.
  embed: (text) => createOllamaEmbedder().embed(text),
});
let preEmbedInFlight: Promise<void> | null = null;

/** Embed the live candidates for a retrieve OUTSIDE the vault lock; best effort, never throws. */
async function preEmbedForRetrieve(
  vaultPath: string,
  filter: { type?: MemoryType; scope?: string },
): Promise<void> {
  if (preEmbedInFlight) { await preEmbedInFlight; return; }
  preEmbedInFlight = (async () => {
    let contents: string[];
    try {
      contents = await withVault(vaultPath, (vault) =>
        vault.list({ type: filter.type, scope: filter.scope, allowedScopes: grantedScopes() })
          .filter((entry) => entry.superseded_at === null)
          .map((entry) => entry.content));
    } catch { return; }
    for (const text of contents) {
      try { await searchEmbedder.embed(text); } catch { return; }
    }
  })().finally(() => { preEmbedInFlight = null; });
  await preEmbedInFlight;
}

async function withVault<T>(
  vaultPath: string,
  fn: (vault: Vault) => T | Promise<T>,
): Promise<T> {
  const resolved = resolveMasterKey(vaultPath);
  if (resolved === null) throw new LockedError();
  // The callback may be async (semantic retrieval awaits the loopback
  // embedder); await it BEFORE close, and hold the file lock across the await,
  // exactly as the web session does.
  return withFileLock(vaultPath, async () => {
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
      return await fn(vault);
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

/**
 * How run() treats a tool (ADR 0060 Decision 5). `kind` is declared at each
 * registration, never guessed from the name; `mask` picks which return walk
 * applies; `pre` runs inside the log envelope, after the pending row.
 */
interface RunOptions {
  kind: 'read' | 'write';
  mask: 'memory' | 'project' | 'none';
  pre?: () => Promise<void>;
}

const LOG_UNWRITABLE = 'NorthKeep could not write its call log, so nothing was done.';
const LOG_INCOMPLETE_READ = 'NorthKeep could not complete its call log, so nothing was returned.';
const LOG_INCOMPLETE_WRITE = 'The change was saved, but its log entry could not be completed.';

function tryAppend(entry: CallLogEntry): boolean {
  try {
    appendCallLog(entry);
    return true;
  } catch {
    return false;
  }
}

async function run(
  ctx: ConnContext,
  tool: string,
  params: LogParams,
  vaultPath: string,
  options: RunOptions,
  fn: (vault: Vault, granted: string[] | undefined) => RunOutcome | Promise<RunOutcome>,
): Promise<ToolOk> {
  const granted = grantedScopes();
  const parsedTier = parseReturnRedactionTier();
  const tier: ReturnTier = parsedTier.ok ? parsedTier.tier : 0;
  const base = {
    ts: new Date().toISOString(),
    tool,
    provider: ctx.provider,
    session_id: ctx.session_id,
    host: ctx.host,
    granted_scopes: granted,
    redaction_tier: tier,
    params,
    call_id: randomUUID(),
  };
  const done = (fields: Partial<CallLogEntry> & { ok: boolean }): boolean =>
    tryAppend({ ...base, phase: 'done', completed_at: new Date().toISOString(), ...fields });

  // A mistyped tier is refused, naming the value (Jay decision 2).
  if (!parsedTier.ok) {
    done({ ok: false, error: 'invalid_tier' });
    return err(parsedTier.message);
  }
  // Log before acting (ADR 0060 D7, Jay decision): no row, no call.
  if (!tryAppend({ ...base, phase: 'pending', ok: false, error: 'pending' })) {
    return err(LOG_UNWRITABLE);
  }

  let outcome: RunOutcome;
  try {
    if (options.pre) await options.pre();
    outcome = await withVault(vaultPath, (vault) => fn(vault, granted));
  } catch (error) {
    const denied = error instanceof ScopeDeniedError ||
      (error instanceof ProjectHandoffError && error.code === 'scope_denied');
    const message = error instanceof Error ? error.message : String(error);
    done({
      ok: false,
      denied,
      error: tool.startsWith('project_')
        ? (error instanceof ProjectHandoffError ? error.code : denied ? 'scope_denied' : 'project_error')
        : message.slice(0, 200),
    });
    if (error instanceof ProjectHandoffError) {
      const payload = {
        error: {
          code: error.code,
          message: error.message,
          ...(error.current ? { current: error.current } : {}),
        },
      };
      const masked = await maskReturnPayload(payload, 'project', tier, returnPseudonyms);
      if (masked.failed) return err(`${error.code}: ${TIER2_FAILED_MESSAGE}`);
      return { ...ok(masked.payload), isError: true };
    }
    return err(message);
  }

  // Masking runs after the vault closed and before the completion row, so the
  // row records the true outcome (a Tier-2 refusal is never logged as ok).
  let payload = outcome.payload;
  let degraded = false;
  if (options.mask !== 'none') {
    const masked = await maskReturnPayload(payload, options.mask, tier, returnPseudonyms);
    if (masked.failed) {
      done({ ok: false, error: 'tier2-unavailable' });
      return err(TIER2_FAILED_MESSAGE);
    }
    payload = masked.payload;
    degraded = masked.degraded;
    if (degraded) {
      payload = { ...(payload as Record<string, unknown>), redaction_note: TIER3_DEGRADED_NOTE };
      if (!degradedNoticeWritten) {
        degradedNoticeWritten = true;
        console.error(`northkeep MCP server: ${TIER3_DEGRADED_NOTE}`);
      }
    }
  }

  const logged = done({
    ok: true,
    result_count: outcome.result_count,
    result_id: outcome.result_id,
    result_ids: outcome.result_ids,
    disclosed_scopes: outcome.disclosed_scopes,
    ...(degraded ? { redaction_degraded: true } : {}),
  });
  if (!logged) {
    // A saved write says so, with no content: an error would invite a retry
    // of a write that landed, and content would be a disclosure with no
    // ledger row. A read discloses nothing (Jay decision 5).
    if (options.kind === 'write') {
      return ok({
        saved: true,
        ...(outcome.result_id !== undefined ? { id: outcome.result_id } : {}),
        log_warning: LOG_INCOMPLETE_WRITE,
      });
    }
    return err(LOG_INCOMPLETE_READ);
  }
  return ok(payload);
}

/**
 * Content writes while returns are masked (ADR 0060 Decision 2, F5, Jay
 * decision 1): the app only saw masked text, so text it saves could overwrite
 * a real value with a placeholder, or store a name nobody can recover.
 */
function refuseProjectWriteUnderMasking(): void {
  const tier = returnRedactionTier();
  if (tier >= 1) throw new ProjectHandoffError('invalid_request', contentWriteRefusal(tier));
}

function refuseMemoryWriteUnderMasking(minTier: 1 | 2): void {
  const tier = returnRedactionTier();
  if (tier >= minTier) throw new Error(contentWriteRefusal(tier));
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

function assertProjectGranted(scope: string, granted: string[] | undefined): void {
  if (granted !== undefined && !granted.includes(scope)) {
    throw new ProjectHandoffError('scope_denied', 'Project scope is outside this connection grant.');
  }
}

/** Host-reported, never guessed: the handshake is all the server knows. */
function writerFor(ctx: ConnContext): ProjectWriter {
  return { host: ctx.host ?? 'unknown', host_version: ctx.host_version ?? null, session_id: ctx.session_id };
}

export function createServer(vaultPath: string = defaultVaultPath()): McpServer {
  const server = new McpServer({ name: 'northkeep', version: '0.5.0' });
  const ctx: ConnContext = {
    provider: 'unknown',
    host: 'unknown',
    host_version: null,
    session_id: randomUUID(),
  };
  // Capture the calling client's name once it completes the MCP handshake.
  server.server.oninitialized = () => {
    const info = server.server.getClientVersion();
    if (info?.name) {
      // Bound and tame the client-supplied name before it reaches the audit
      // log (defense-in-depth alongside the CSV formula guard).
      const raw = `${info.name}${info.version ? `@${info.version}` : ''}`;
      // Composed, not replaced: the CSV formula guard on , and " stays, and
      // the shared class then takes the format characters it never covered.
      ctx.provider = tameOneLine(raw.replace(/[\x00-\x1f,"]/g, ' '), 80);
      // Built from the raw parts, not by splitting provider: provider's own
      // bytes must not shift for the consumers that already read it.
      ctx.host = tameHandshakeField(info.name, 80);
      ctx.host_version = info.version ? tameHandshakeField(info.version, 40) : null;
    }
  };

  server.registerTool(
    'memory_retrieve',
    {
      title: 'Retrieve memories',
      description:
        "Search the user's personal memory vault for facts, preferences, past events, and " +
        'how they like things done. Call this at the start of a conversation and whenever ' +
        'personal context would help. Returns entries ranked by meaning when the local search ' +
        'model is available (search_mode "semantic"), otherwise by keyword + recency ' +
        '(search_mode "keyword"); the response says which.',
      inputSchema: {
        query: z.string().max(1024).describe('What you want to know about the user'),
        type: typeEnum.optional().describe('Restrict to one memory type'),
        scope: scopeSchema.optional().describe('Restrict to one scope, e.g. "personal" or "work"'),
        limit: z.number().int().min(1).max(25).optional().describe('Max results (default 8)'),
      },
    },
    async ({ query, type, scope, limit }) => {
      return run(
        ctx,
        'memory_retrieve',
        { query_terms: query.split(/\s+/).filter(Boolean).length, type, scope, limit },
        vaultPath,
        {
          kind: 'read',
          mask: 'memory',
          // Embed the candidates OUTSIDE the vault lock first (memoized per
          // process), so the ranking inside the lock is cache hits (ADR 0044).
          // Inside the log envelope, after the pending row (ADR 0060 D7).
          pre: () => preEmbedForRetrieve(vaultPath, { type: type as MemoryType | undefined, scope }),
        },
        async (vault, granted) => {
          const r = await vault.retrieveSemantic(query, searchEmbedder, {
            type: type as MemoryType,
            scope,
            limit,
            allowedScopes: granted,
          });
          const results = r.results;
          const entries = results.map((s) => ({ ...publicEntry(s.entry), relevance: Number(s.score.toFixed(3)) }));
          const note = results.length === 0
            ? (r.mode === 'semantic'
              ? 'No matching memories. Ranked by meaning; try describing it differently.'
              : `No matching memories. Search by meaning was unavailable (${r.reason ?? 'unknown'}); retrieval was keyword-based, try different words.`)
            : (r.mode === 'keyword' ? `Search by meaning was unavailable (${r.reason ?? 'unknown'}); results are keyword-ranked.` : undefined);
          return {
            payload: { results: entries, search_mode: r.mode, note },
            result_count: results.length,
            result_ids: results.map((s) => s.entry.id),
            disclosed_scopes: distinctScopes(results.map((s) => s.entry.scope)),
          };
        },
      );
    },
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
        { kind: 'write', mask: 'memory' },
        (vault, granted) => {
          // Tiers 2 and 3 only: the app read Person-N pseudonyms whose map lives
          // in this process's RAM (ADR 0060 F5). Tier 1 stays allowed (O1).
          refuseMemoryWriteUnderMasking(2);
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
        "Browse the user's memory vault without a search query; newest last. " +
        'Useful for "what do you know about me?" style questions.',
      inputSchema: {
        type: typeEnum.optional().describe('Filter by memory type'),
        scope: scopeSchema.optional().describe('Filter by scope'),
        limit: z.number().int().min(1).max(100).optional().describe('Max results (default 50)'),
      },
    },
    async ({ type, scope, limit }) =>
      run(ctx, 'memory_list', { type, scope, limit }, vaultPath, { kind: 'read', mask: 'memory' }, (vault, granted) => {
        const rows = vault
          .list({ type: type as MemoryType, scope, allowedScopes: granted })
          .slice(-(limit ?? 50));
        const entries = rows.map(publicEntry);
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
      run(ctx, 'memory_forget', { id }, vaultPath, { kind: 'write', mask: 'memory' }, (vault, granted) => {
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
        { kind: 'write', mask: 'memory' },
        (vault, granted) => {
          if (content === undefined && type === undefined) {
            throw new Error('Provide content and/or type to edit.');
          }
          // Jay decision 1: a content edit while masking is on could overwrite
          // a real value with a placeholder the app saw. Type-only edits stay.
          if (content !== undefined) refuseMemoryWriteUnderMasking(1);
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

  // ADR 0053 Decision 7. Settings and state files only, never git. An error
  // other than an unreadable settings file drops the line, because a backup
  // status must never cost the caller the list or the resume it asked for.
  function mirrorStatus(vault: Vault, granted: string[] | undefined): string | null {
    try {
      return readMirrorSummary(vault, granted, northkeepHome());
    } catch {
      return null;
    }
  }

  server.registerTool(
    'project_list',
    {
      title: 'List projects',
      description:
        "List the user's live projects. Each row is a project scope plus the first line of Current " +
        'Status. This list is the project index; there is no separate index memory. Call this to see ' +
        'what is in flight. When the user keeps a local git backup of their projects, mirror_status is ' +
        'one line saying when that backup was last updated and how many of these projects changed since.',
      inputSchema: {},
    },
    async () =>
      run(ctx, 'project_list', {}, vaultPath, { kind: 'read', mask: 'project' }, (vault, granted) => {
        const projects = listProjectViews(vault, granted).map((project) => ({
          ...project,
          id: project.revision,
        }));
        const mirror = mirrorStatus(vault, granted);
        return {
          payload: { projects, ...(mirror === null ? {} : { mirror_status: mirror }) },
          result_count: projects.length,
          result_ids: projects.flatMap((project) => project.revision ? [project.revision] : []),
          disclosed_scopes: distinctScopes(projects.map((project) => project.scope)),
        };
      }),
  );

  server.registerTool(
    'project_board',
    {
      title: 'Project board',
      description:
        'A read-only weekly review across the projects this connection can see: projects gone quiet ' +
        '(no activity for more than stale_days, default 14, excluding Done), dated lines in Next Actions ' +
        'and Open Questions, sessions on this machine that read a project and did not write back, draft ' +
        'projects, and projects that need repair. Returns one-line excerpts only, never a whole document; ' +
        'call project_resume for the project you will work on. Calling this does not count as reading ' +
        'any project.',
      inputSchema: {
        stale_days: z.number().int().min(0).max(BOARD_MAX_STALE_DAYS).optional()
          .describe(`Days without activity before a project counts as stale (0 to ${BOARD_MAX_STALE_DAYS}, default ${BOARD_DEFAULT_STALE_DAYS})`),
      },
    },
    async ({ stale_days }) => {
      const staleDays = stale_days ?? BOARD_DEFAULT_STALE_DAYS;
      return run(ctx, 'project_board', { stale_days: staleDays }, vaultPath, { kind: 'read', mask: 'project' }, (vault, granted) => {
        const result = collectBoard(vault, {
          granted, now: new Date(), staleDays, currentSessionId: ctx.session_id, readLog: readCallLogStrict,
        });
        return {
          payload: result.board,
          result_count: result.disclosed_scopes.length,
          result_ids: result.result_ids,
          disclosed_scopes: result.disclosed_scopes,
        };
      });
    },
  );

  server.registerTool(
    'project_get',
    {
      title: 'Read a project',
      description:
        'Read the current project document when the user names a project. Call this at session start so ' +
        'you pick up Current Status, Next Actions, and the Log. Conflicting current documents are refused. ' +
        'The live document keeps only its newest Log entries; ' +
        'pass history: true to also get the archive memories holding older entries, newest first. ' +
        'Pass a revision id from the resume brief to read that one earlier revision in full instead.',
      inputSchema: {
        project: projectSlugSchema.describe('Project slug, e.g. "northkeep" for scope project:northkeep'),
        history: z.boolean().optional().describe('Also return the Log archives for this project (older entries), newest first'),
        revision: idSchema.optional().describe('Read this one earlier revision of the project in full, instead of the current document. Ids come from the revisions list in project_get or project_resume.'),
      },
    },
    async ({ project, history, revision }) =>
      run(ctx, 'project_get', { scope: `project:${project}`, id: revision }, vaultPath, { kind: 'read', mask: 'project' }, (vault, granted) => {
        if (!isValidProjectSlug(project)) {
          throw new Error(`Invalid project slug "${project}".`);
        }
        if (revision !== undefined) {
          // The grant is asserted here as well as in core, so a revision read
          // cannot reach the vault on a scope this connection was never given.
          const scope = projectScope(project);
          assertProjectGranted(scope, granted);
          const prior = getProjectRevision(vault, project, revision, granted);
          return {
            // history is ignored for a single revision: the archives belong to
            // the project, not to the revision being read.
            payload: {
              project, scope, id: prior.id, revision: prior.id, type: 'working',
              created_at: prior.updated_at, updated_at: prior.updated_at,
              content: prior.content, ...(prior.mode ? { mode: prior.mode } : {}),
            },
            result_id: prior.id,
            disclosed_scopes: [scope],
          };
        }
        const view = getProjectView(vault, project, granted, { history });
        return {
          payload: {
            ...view,
            id: view.revision,
            type: 'working',
            created_at: view.updated_at,
            ...(history ? {
              archives: view.archives.map((archive) => ({
                ...archive, type: 'episodic', scope: view.scope, created_at: archive.updated_at,
              })),
            } : { archives: undefined }),
          },
          result_id: view.revision,
          disclosed_scopes: [view.scope],
        };
      }),
  );

  server.registerTool(
    'project_resume',
    {
      title: 'Resume a project',
      description:
        'Read a revision-bound project handoff view. Call this at session start. It returns the current ' +
        'document as parsed sections, the files reported by earlier work, the host and session that ' +
        'wrote it last, whether it is still a draft, a content-free list of the newest prior revisions, ' +
        'a count of the Log archives, and any sessions that read this project on this machine and did ' +
        'not write back. The document is not repeated as one block of text: project_get returns the ' +
        'full document text. The text of prior revisions and archives is not included either: pass ' +
        'history: true for all of it, or project_get with one revision id for one of them. When the user ' +
        'keeps a local git backup of their projects, mirror_status is one line saying when that backup was ' +
        'last updated and how many projects changed since, so a stale backup is visible.',
      inputSchema: {
        project: projectSlugSchema.describe('Project slug, e.g. "northkeep"'),
        history: z
          .boolean()
          .optional()
          .default(false)
          .describe('Also return prior working revisions and the Log archives for this project'),
      },
    },
    async ({ project, history }) => {
      const scope = `project:${project}`;
      return run(ctx, 'project_resume', { scope }, vaultPath, { kind: 'read', mask: 'project' }, (vault, granted) => {
        const view = getProjectView(vault, project, granted, { history });
        // After the view, so a denied or missing project never reads the mirror files.
        const mirror = mirrorStatus(vault, granted);
        // Derived inside the call, so a log this machine cannot read costs the
        // session list and not the resume. This session's own rows (its pending
        // row is already written) are excluded by its session id.
        const writers = [
          ...(view.last_writer ? [{ session_id: view.last_writer.session_id, at: view.last_writer.recorded_at }] : []),
          ...view.revisions.flatMap((r) => (r.writer ? [{ session_id: r.writer.session_id, at: r.updated_at }] : [])),
        ];
        let open: OpenSession[] | null;
        try {
          open = openSessions(readCallLogStrict(), scope, ctx.session_id, new Date(), 30, writers);
        } catch {
          open = null;
        }
        return {
          payload: {
            ...receivingProjectView(view),
            ...(open === null
              ? { open_sessions_note: OPEN_SESSIONS_UNREADABLE_NOTE }
              : {
                ...{ open_sessions: open },
                ...(open.length > 0 ? { open_sessions_note: OPEN_SESSIONS_NOTE } : {}),
              }),
            ...(mirror === null ? {} : { mirror_status: mirror }),
          },
          result_id: view.revision,
          disclosed_scopes: [view.scope],
        };
      });
    },
  );

  server.registerTool(
    'project_update',
    {
      title: 'Update a project',
      description:
        'Create or update a project document. Call this when a working session ends, with the new ' +
        'Current Status, Next Actions, and a log entry describing what was done. Optional What & Why ' +
        'replacement and a dated decision. Updates merge into the existing sections; they do not ' +
        'replace the whole document. The live document keeps only its newest Log entries; older ones ' +
        "roll into an archive memory in the project scope (the result's archive_summary counts them), so " +
        "the Log's history never makes an update fail. An update is refused only when the document is " +
        'still over 16384 characters with just the newest Log entry kept: long hand-written sections, or a ' +
        'long new entry on a nearly full document. NorthKeep never truncates.',
      inputSchema: {
        project: projectSlugSchema.describe('Project slug, e.g. "northkeep"'),
        expected_revision: idSchema.nullable().describe('Revision returned by project_get/resume, or null only when creating'),
        title: z.string().max(120).optional().describe('Display title shown in the app (single line, up to 120 characters). Empty string removes it and the slug is shown instead.'),
        what_why: z.string().min(1).max(16384).optional().describe('Replacement What & Why section'),
        status: z.string().min(1).max(16384).optional().describe('Replacement Current Status section'),
        next_actions: z.string().max(16384).optional().describe('Replacement Next Actions section; empty clears it'),
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
        open_questions: z.string().max(16384).optional(),
        draft: z
          .boolean()
          .optional()
          .describe('Only false is meaningful on a project that already exists: it clears the draft line. Passing true is refused; a draft can only be marked when the project is created.'),
        files: z.array(z.object({
          type: z.string().min(1).max(32),
          label: z.string().min(1).max(512),
          locator: z.string().min(1).max(4096),
          access: z.enum(['reported_available', 'unavailable', 'unverified']),
          checked_at: z.string().max(64).optional(),
          context: z.string().max(2048).optional(),
        })).max(40).optional(),
      },
    },
    async ({ project, expected_revision, title, what_why, status, next_actions, log_entry, decision, open_questions, draft, files }) =>
      run(
        ctx,
        'project_update',
        {
          scope: `project:${project}`,
          content_chars:
            (title?.length ?? 0) +
            (what_why?.length ?? 0) +
            (status?.length ?? 0) +
            (next_actions?.length ?? 0) +
            (log_entry?.length ?? 0) +
            (decision?.length ?? 0),
        },
        vaultPath,
        { kind: 'write', mask: 'project' },
        (vault, granted) => {
          refuseProjectWriteUnderMasking();
          if (!isValidProjectSlug(project)) {
            throw new Error(`Invalid project slug "${project}".`);
          }
          if (
            title === undefined &&
            what_why === undefined &&
            status === undefined &&
            next_actions === undefined &&
            log_entry === undefined &&
            decision === undefined &&
            open_questions === undefined &&
            draft === undefined &&
            files === undefined
          ) {
            throw new Error(
              'Provide at least one project field to update.',
            );
          }
          const scope = projectScope(project);
          assertProjectGranted(scope, granted);
          const request: ProjectUpdateRequest = {
            project, expected_revision, title, what_why, status, next_actions, log_entry, decision,
            open_questions, files: files as ProjectFileReference[] | undefined, writer: writerFor(ctx),
            ...(draft !== undefined ? { draft } : {}),
          };
          const current = vault.updateProject(request, granted);
          vault.save();
          return {
            payload: {
              ...current, id: current.revision, type: 'working', created_at: current.updated_at,
              created: expected_revision === null,
            },
            result_id: current.revision,
            disclosed_scopes: [scope],
          };
        },
      ),
  );

  server.registerTool(
    'project_create',
    {
      title: 'Create a project',
      description:
        'Create a project only when the user asks for one; never to hold notes that belong in an existing ' +
        'project or in a memory. What & Why and Current Status are required: a project with neither is not ' +
        'a project. Log and Decisions start empty, because the first log entry belongs to the first session ' +
        'that does work. Use project_update to change a project that already exists.',
      inputSchema: {
        project: projectSlugSchema.describe('Project slug, e.g. "northkeep" for scope project:northkeep'),
        title: z.string().max(120).optional().describe('Display title shown in the app (single line, up to 120 characters).'),
        what_why: z.string().min(1).max(16384).describe('What & Why section: what this project is and why it exists'),
        status: z.string().min(1).max(16384).describe('Current Status section: where the project stands right now'),
        next_actions: z.string().max(16384).optional().describe('Next Actions section'),
        draft: z
          .boolean()
          .optional()
          .describe('Mark the document a draft: it opens with a line saying it was bootstrapped by this host on this date and is unverified. Use it when you built the document from a codebase rather than from the user. project_wrap clears the line.'),
      },
    },
    async ({ project, title, what_why, status, next_actions, draft }) =>
      run(
        ctx,
        'project_create',
        {
          scope: `project:${project}`,
          content_chars:
            (title?.length ?? 0) + what_why.length + status.length + (next_actions?.length ?? 0),
        },
        vaultPath,
        { kind: 'write', mask: 'project' },
        (vault, granted) => {
          refuseProjectWriteUnderMasking();
          if (!isValidProjectSlug(project)) {
            throw new Error(`Invalid project slug "${project}".`);
          }
          const scope = projectScope(project);
          assertProjectGranted(scope, granted);
          const request: ProjectUpdateRequest = {
            project, expected_revision: null, title, what_why, status, next_actions,
            writer: writerFor(ctx), ...(draft !== undefined ? { draft } : {}),
          };
          let current;
          try {
            current = vault.updateProject(request, granted);
          } catch (error) {
            // Core reads an existing head as a stale revision. A create says so in its
            // own words, and carries no current view, so a refusal returns no document.
            if (error instanceof ProjectHandoffError && error.code === 'stale_project') {
              throw new ProjectHandoffError('stale_project', 'Project already exists; use project_update.');
            }
            throw error;
          }
          vault.save();
          return {
            payload: {
              ...current, id: current.revision, type: 'working', created_at: current.updated_at,
              created: true,
            },
            result_id: current.revision,
            disclosed_scopes: [scope],
          };
        },
      ),
  );

  const checkpointSchema = {
    vault_id: idSchema,
    project: projectSlugSchema,
    operation_id: z.string().uuid(),
    expected_revision: idSchema,
    status: z.string().min(1).max(16384),
    completed: z.string().min(1).max(4096),
    next_actions: z.string().max(16384),
    decision: z.string().min(1).max(4096).optional(),
    open_questions: z.string().max(16384).optional(),
    files: z.array(z.object({
      type: z.string().min(1).max(32), label: z.string().min(1).max(512),
      locator: z.string().min(1).max(4096),
      access: z.enum(['reported_available', 'unavailable', 'unverified']),
      checked_at: z.string().max(64).optional(), context: z.string().max(2048).optional(),
    })).max(40).optional(),
  };
  const registerHandoff = (name: 'project_checkpoint' | 'project_wrap', mode: 'checkpoint' | 'wrap') => {
    server.registerTool(name, {
      title: mode === 'checkpoint' ? 'Checkpoint project' : 'Wrap up project',
      description: 'Atomically save a revision-bound project handoff. Retrying the same operation id is safe.',
      inputSchema: checkpointSchema,
    }, async (args) => run(ctx, name, {
      scope: `project:${args.project}`, id: args.operation_id,
      content_chars: args.status.length + args.completed.length + args.next_actions.length,
    }, vaultPath, { kind: 'write', mask: 'project' }, (vault, granted) => {
      refuseProjectWriteUnderMasking();
      const scope = projectScope(args.project);
      assertProjectGranted(scope, granted);
      const request: ProjectCheckpointRequest = {
        ...args, mode, files: args.files as ProjectFileReference[] | undefined, writer: writerFor(ctx),
      };
      const result = vault.checkpointProject(request, granted);
      if (!result.replayed) vault.save();
      return {
        payload: result, result_id: result.receipt.result_revision,
        disclosed_scopes: [scope],
      };
    }));
  };
  registerHandoff('project_checkpoint', 'checkpoint');
  registerHandoff('project_wrap', 'wrap');

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
  // Warm search by meaning for the first memory_retrieve (owner decision
  // 2026-09-12: loading the local model on open is allowed). Embeds outside
  // the vault lock; a stopped runtime or locked vault just means "not now".
  void preEmbedForRetrieve(resolvedVaultPath, {}).catch(() => {});
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
const SHUTDOWN_FLUSH_BUDGET_MS = 10_000; // an upload of a few MB finishes well inside this; a hung server still cannot hold exit past it
/** Hard exit backstop: the flush budget plus the transport close, with room to spare. */
const SHUTDOWN_HARD_EXIT_MS = 12_000;

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
      .then(() => {
        // 'failed' and 'timeout' both log their own line inside flushBounded,
        // which is the only place that knows whether a push was pending.
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
