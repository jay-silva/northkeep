import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition, ToolResult } from '../types.js';
import { endpointOrigin, isHttpServer, remoteUrlRefusal, riskOf, type McpServerConfig } from './config.js';
import {
  fingerprintLaunch,
  MAX_DESCRIPTION_CHARS,
  namespacedName,
  pinTools,
  sanitizeServerText,
  type PinnableTool,
} from './identity.js';
import { credentialsOriginMatches, hasRemoteTokens } from './tokens.js';
import { KeychainOAuthProvider } from './oauth.js';
import { guardedFetch } from '../net.js';
// Re-exported so every existing importer of this module is unaffected by the
// move; the function itself lives in identity.js because oauth.js needs it and
// importing this module from there would be a cycle.
export { sanitizeServerText };

/**
 * The MCP client (M11, ADR 0033). Connects to a user-configured server, checks
 * its identity, pins its advertised definitions, and adapts its tools into the
 * harness's own ToolDefinition shape so the ENTIRE M10 machine — the permission
 * gate, the exfiltration screens, the approval protocol, the untrusted-content
 * fence and the content-free audit — applies to them unchanged in shape.
 *
 * Two caps exist because a server's advertised text lands in the model's
 * context and is read WHILE IT DECIDES WHAT TO DO (ADR 0033 Decision 2). A
 * server cannot be allowed to buy unlimited context or unlimited attention.
 */

/** A server may advertise at most this many tools. */
export const MAX_TOOLS_PER_SERVER = 64;
/** Each description is truncated to this many characters before the model sees it. */
// Defined in identity.js beside the sanitizer that uses it as a default.
export { MAX_DESCRIPTION_CHARS };
/** A tool's whole input schema, serialized, may not exceed this. */
export const MAX_SCHEMA_CHARS = 8192;
/** No single request to a server may hang the loop longer than this. */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The grammar a server-supplied tool name must satisfy.
 *
 * This is load-bearing three times over, and each was a real defect before it
 * existed. A name of `""` produced the offered name `server__`, which parses to
 * nothing — so the argument floor, the grant subject and the audit attribution
 * all silently vanished for that tool. A name carrying ESC could rewrite the
 * CLI approval prompt with terminal control codes, so the user reads one
 * question and answers another. And a name is interpolated into the
 * untrusted-content fence header, where `]` and a newline can close the fence
 * early and put server text OUTSIDE it. One grammar closes all three, and it
 * matches what hosted providers accept anyway.
 */
export const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,48}$/;

export class McpPinChangedError extends Error {
  constructor(
    readonly serverId: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `The tools offered by MCP server "${serverId}" have CHANGED since you approved them. ` +
        'Nothing was run. Review them with: northkeep mcp tools ' +
        serverId,
    );
    this.name = 'McpPinChangedError';
  }
}

export class McpFingerprintChangedError extends Error {
  constructor(readonly serverId: string) {
    super(
      `The launch configuration for MCP server "${serverId}" has changed since it was added. ` +
        'Nothing was run, and remembered approvals no longer apply.',
    );
    this.name = 'McpFingerprintChangedError';
  }
}

export interface McpConnection {
  serverId: string;
  /** The adapted tools, namespaced and ready to offer to the model. */
  tools: ToolDefinition[];
  /** The pin observed on THIS connection. */
  pin: string;
  /** True when a `tools/list_changed` notification invalidated the pin. */
  isStale: () => boolean;
  close: () => Promise<void>;
}

export interface ConnectOptions {
  /** Injected in tests; production always spawns a real stdio child. */
  clientFactory?: (server: McpServerConfig) => Promise<McpClientLike>;
  /** Reject a pin that differs from the stored one. Default true. */
  enforcePin?: boolean;
  /** Called with definitions we refused to offer, so a surface can say so. */
  onSkipped?: (serverId: string, reasons: string[]) => void;
  /** Cancels in-flight requests to the server. */
  signal?: AbortSignal;
}

/** The slice of the SDK client this module uses, so tests can substitute it. */
export interface McpClientLike {
  listTools(options?: { timeout?: number; signal?: AbortSignal }): Promise<{ tools: PinnableTool[] }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<unknown>;
  close(): Promise<void>;
  setNotificationHandler?: (schema: unknown, handler: () => void) => void;
}

export class McpOriginChangedError extends Error {
  constructor(readonly serverId: string) {
    super(
      `MCP server "${serverId}" now points at a different host than the one you signed in to. ` +
        'Remembered approvals do not carry across a change of host, so NorthKeep will not use the ' +
        'stored sign-in. Remove the server and add it again if the new address is what you intended.',
    );
    this.name = 'McpOriginChangedError';
  }
}

export class McpNotConnectedError extends Error {
  constructor(readonly serverId: string) {
    super(
      `MCP server "${serverId}" has not been connected yet. A remote server does nothing — ` +
        'not even list its tools — until you sign in to it, so that nobody holding this ' +
        "window's address can put an unknown server's tools in front of the model.",
    );
    this.name = 'McpNotConnectedError';
  }
}

async function defaultClientFactory(server: McpServerConfig): Promise<McpClientLike> {
  const client = new Client({ name: 'northkeep', version: '1' }, { capabilities: {} });

  if (isHttpServer(server)) {
    // ADR 0035 Decision 7: nothing happens until a completed OAuth token
    // exists. Listing tools is not harmless — a tool DESCRIPTION is read by the
    // model while it decides what to do — so an unauthenticated listing is the
    // very thing the gate exists to prevent.
    if (!hasRemoteTokens(server.id)) throw new McpNotConnectedError(server.id);
    // Decision 6: grants key on the server LABEL, so a URL edit would otherwise
    // carry an `always` grant to a different host. The credentials remember the
    // origin they were issued for; a mismatch is a changed server, not a
    // reconnect, and is refused with the same force as a changed fingerprint.
    if (!credentialsOriginMatches(server.id, endpointOrigin(server.url))) {
      throw new McpOriginChangedError(server.id);
    }
    const provider = new KeychainOAuthProvider({
      serverId: server.id,
      origin: endpointOrigin(server.url),
      ...(server.clientId !== undefined ? { clientId: server.clientId } : {}),
    });
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      authProvider: provider,
      // Decision 5: the SDK transport calls bare `fetch`, which would be a
      // SECOND, UNGUARDED egress path beside web_fetch. Every byte — the
      // JSON-RPC POST, the SSE stream, and the OAuth discovery fetches the SDK
      // makes on this same fetch — goes through our resolve-refuse-pin guard
      // instead.
      fetch: guardedFetch as unknown as typeof fetch,
    });
    await client.connect(transport);
    return client as unknown as McpClientLike;
  }

  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
    // The SDK's SAFE SUBSET (PATH, HOME, and the platform equivalents) plus
    // whatever the config sets. Passing the whole ambient environment would
    // hand a third-party child process every secret this shell happens to
    // carry; passing nothing at all breaks any server that needs PATH. Only
    // the config-set half is fingerprinted, because only that half is ours to
    // pin — the safe subset is the same for every server on the machine.
    env: { ...getDefaultEnvironment(), ...(server.env ?? {}) },
    // The child's stderr must not interleave with our own stdout, which for the
    // CLI is the user's transcript.
    stderr: 'pipe',
  });
  await client.connect(transport);
  return client as unknown as McpClientLike;
}

/**
 * Connect, verify identity, pin definitions, and adapt tools.
 *
 * Order matters and is fail-closed at every step: the fingerprint is re-checked
 * BEFORE spawning (a changed launch spec must not run at all), and the pin is
 * checked before a single tool is offered to the model.
 */
export async function connectServer(
  server: McpServerConfig,
  options: ConnectOptions = {},
): Promise<McpConnection> {
  // Identity, re-checked at every connect. The two transports answer different
  // questions (ADR 0035 Decision 2): a fingerprint asks "has this launch
  // configuration changed since you approved it"; an origin asks "is this still
  // the host you approved". Neither substitutes for the other, and both are
  // re-checked here rather than trusted from add-time.
  if (isHttpServer(server)) {
    const check = remoteUrlRefusal(server.url);
    if (!check.ok) throw new McpFingerprintChangedError(server.id);
  } else {
    // Symlinks are re-resolved every time because a symlink is a redirection:
    // resolving once at add-time would let the link be re-pointed afterwards.
    const current = fingerprintLaunch({
      command: server.command,
      args: server.args,
      ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
      ...(server.env !== undefined ? { env: server.env } : {}),
    });
    if (current !== server.fingerprint) throw new McpFingerprintChangedError(server.id);
  }

  const factory = options.clientFactory ?? defaultClientFactory;
  const client = await factory(server);

  // Subscribe BEFORE listing. A tools/list_changed arriving while we are still
  // reading the list would otherwise be lost, and we would pin a set the server
  // had already replaced.
  if (typeof client.setNotificationHandler !== 'function') {
    // Without this, the pin would be connect-time only — the exact "theatre"
    // ADR 0033 Decision 2 forbids. Refuse rather than silently degrade.
    await client.close().catch(() => {});
    throw new Error(
      'This MCP client cannot subscribe to tools/list_changed, so definition pinning ' +
        'would only hold at connect time. Refusing to connect.',
    );
  }
  let stale = false;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    stale = true;
  });

  let listed: PinnableTool[];
  try {
    listed = (await client.listTools({ timeout: REQUEST_TIMEOUT_MS, signal: options.signal })).tools;
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }

  if (listed.length > MAX_TOOLS_PER_SERVER) {
    await client.close().catch(() => {});
    throw new Error(
      `MCP server "${server.id}" advertises ${listed.length} tools, over the ${MAX_TOOLS_PER_SERVER} limit.`,
    );
  }

  // Reject unusable definitions BEFORE anything is pinned or offered. Skipping
  // loudly (never silently) keeps invariant #6: a tool that vanished must not
  // look like a model that chose not to use it.
  const skipped: string[] = [];
  const seenNames = new Set<string>();
  const usable = listed.filter((t) => {
    if (typeof t.name !== 'string' || !TOOL_NAME_RE.test(t.name)) {
      // The rejected NAME is server-authored and ends up on a terminal and in
      // the browser, so it is sanitized and short-capped here.
      skipped.push(`${JSON.stringify(sanitizeServerText(String(t.name), 80))} (name must match ${String(TOOL_NAME_RE)})`);
      return false;
    }
    // A duplicate name would let a server show one description and run a
    // differently-described twin, since a later definition wins the lookup.
    if (seenNames.has(t.name)) {
      skipped.push(`${sanitizeServerText(t.name, 80)} (duplicate name)`);
      return false;
    }
    seenNames.add(t.name);
    if (JSON.stringify(t.inputSchema ?? null).length > MAX_SCHEMA_CHARS) {
      skipped.push(`${sanitizeServerText(t.name, 80)} (input schema over ${MAX_SCHEMA_CHARS} chars)`);
      return false;
    }
    return true;
  });
  if (skipped.length > 0) {
    options.onSkipped?.(server.id, skipped);
  }

  const pin = pinTools(usable);
  if ((options.enforcePin ?? true) && server.toolsPin !== undefined && server.toolsPin !== pin) {
    await client.close().catch(() => {});
    throw new McpPinChangedError(server.id, server.toolsPin, pin);
  }

  // A server may change its tool list mid-connection, so a connect-time-only
  // pin would be theatre (ADR 0033 Decision 2). The notification marks the
  // connection stale; the loop refuses to execute anything from a stale
  // connection and the user is asked again.
  const isStale = (): boolean => stale;
  const tools = usable.map((t) => adaptTool(server, t, client, isStale, options.signal));

  return {
    serverId: server.id,
    tools,
    pin,
    isStale,
    close: () => client.close(),
  };
}

/** Flatten an MCP CallToolResult into text for the model. */
function resultToText(raw: unknown): { text: string; isError: boolean } {
  if (raw === null || typeof raw !== 'object') return { text: String(raw), isError: false };
  const r = raw as { content?: unknown; isError?: unknown };
  const isError = r.isError === true;
  if (!Array.isArray(r.content)) return { text: JSON.stringify(raw), isError };
  const parts: string[] = [];
  for (const block of r.content) {
    if (block !== null && typeof block === 'object') {
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') {
        parts.push(b.text);
        continue;
      }
      // Non-text blocks (images, embedded resources) are NOT rendered into the
      // transcript: they are another content channel we have not screened, and
      // silently flattening one would be a privacy claim we cannot support.
      parts.push(`[${typeof b.type === 'string' ? b.type : 'unknown'} content omitted]`);
    }
  }
  return { text: parts.join('\n'), isError };
}

/**
 * Adapt one MCP tool into a harness ToolDefinition.
 *
 * `egress()` returns null: we genuinely cannot see where a server sends things
 * (ADR 0033 Decision 3). That is why the loop's untrusted-content fence keys on
 * "a tool produced this" rather than "it has an egress URL" — otherwise every
 * result here would arrive unfenced.
 */
function adaptTool(
  server: McpServerConfig,
  tool: PinnableTool,
  client: McpClientLike,
  isStale: () => boolean,
  signal?: AbortSignal,
): ToolDefinition {
  const description = sanitizeServerText(tool.description ?? '').slice(0, MAX_DESCRIPTION_CHARS);
  return {
    name: namespacedName(server.id, tool.name),
    // Identity travels STRUCTURALLY, so nothing downstream has to parse a
    // server-supplied name to learn which server this is (ADR 0033 D1).
    serverId: server.id,
    // The description is server-supplied text. It is passed through to the
    // model as CONTEXT ONLY: nothing in it may influence gating, tiering,
    // budgets or audit, all of which key on our own config.
    description,
    inputSchema:
      tool.inputSchema !== null && typeof tool.inputSchema === 'object'
        ? (tool.inputSchema as Record<string, unknown>)
        : { type: 'object' },
    risk: riskOf(server, tool.name),
    egress: () => null,
    execute: async (args: unknown, ctx): Promise<ToolResult> => {
      if (isStale()) {
        return {
          content: JSON.stringify({
            error: 'tool_definitions_changed',
            guidance:
              'This server changed the tools it offers mid-conversation. Nothing was run; the user must review it again.',
          }),
          meta: { bytes: 0, truncated: false, ok: false },
        };
      }
      const raw = await client.callTool(
        {
          name: tool.name,
          arguments:
            args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : {},
        },
        undefined,
        // A server that never answers must not hold the loop open forever, and
        // Ctrl-C has to reach an in-flight call — the CLI promises it does.
        {
          timeout: REQUEST_TIMEOUT_MS,
          // The loop's per-task signal wins; the connect-time one is the fallback.
          ...(ctx.signal ?? signal ? { signal: ctx.signal ?? signal } : {}),
        },
      );
      const { text, isError } = resultToText(raw);
      return {
        content: isError
          ? JSON.stringify({ error: 'tool_failed', detail: text, guidance: 'The tool reported an error.' })
          : text,
        meta: { bytes: Buffer.byteLength(text, 'utf8'), truncated: false, ok: !isError },
      };
    },
  };
}
