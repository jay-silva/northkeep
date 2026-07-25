import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition, ToolResult } from '../types.js';
import { riskOf, type McpServerConfig } from './config.js';
import { fingerprintLaunch, namespacedName, pinTools, type PinnableTool } from './identity.js';

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
export const MAX_DESCRIPTION_CHARS = 1024;

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
}

/** The slice of the SDK client this module uses, so tests can substitute it. */
export interface McpClientLike {
  listTools(): Promise<{ tools: PinnableTool[] }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
  setNotificationHandler?: (schema: unknown, handler: () => void) => void;
}

async function defaultClientFactory(server: McpServerConfig): Promise<McpClientLike> {
  const client = new Client({ name: 'northkeep', version: '1' }, { capabilities: {} });
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
  // Re-resolve the launch spec NOW. Symlinks are re-resolved on every connect
  // because a symlink is a redirection: resolving once at add-time would let
  // the link be re-pointed afterwards (ADR 0033 Decision 1).
  const current = fingerprintLaunch({
    command: server.command,
    args: server.args,
    ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
    ...(server.env !== undefined ? { env: server.env } : {}),
  });
  if (current !== server.fingerprint) throw new McpFingerprintChangedError(server.id);

  const factory = options.clientFactory ?? defaultClientFactory;
  const client = await factory(server);

  let listed: PinnableTool[];
  try {
    listed = (await client.listTools()).tools;
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

  const pin = pinTools(listed);
  if ((options.enforcePin ?? true) && server.toolsPin !== undefined && server.toolsPin !== pin) {
    await client.close().catch(() => {});
    throw new McpPinChangedError(server.id, server.toolsPin, pin);
  }

  // A server may change its tool list mid-connection, so a connect-time-only
  // pin would be theatre (ADR 0033 Decision 2). The notification marks the
  // connection stale; the loop refuses to execute anything from a stale
  // connection and the user is asked again.
  let stale = false;
  client.setNotificationHandler?.(ToolListChangedNotificationSchema, () => {
    stale = true;
  });

  const isStale = (): boolean => stale;
  const tools = listed.map((t) => adaptTool(server, t, client, isStale));

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
): ToolDefinition {
  const description = (tool.description ?? '').slice(0, MAX_DESCRIPTION_CHARS);
  return {
    name: namespacedName(server.id, tool.name),
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
    execute: async (args: unknown): Promise<ToolResult> => {
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
      const raw = await client.callTool({
        name: tool.name,
        arguments:
          args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : {},
      });
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
