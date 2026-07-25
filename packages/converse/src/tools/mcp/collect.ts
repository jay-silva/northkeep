import type { ToolDefinition } from '../types.js';
import {
  connectServer,
  McpFingerprintChangedError,
  McpPinChangedError,
  sanitizeServerText,
} from './client.js';
import { loadMcpConfig } from './config.js';

/**
 * Connect every configured MCP server and gather their tools (M11, ADR 0033).
 *
 * Shared by BOTH surfaces. It returns structured facts and prints nothing: the
 * CLI renders these as dim lines, the web GUI as transcript notices, and a
 * shared module that wrote to stdout would corrupt the CLI's transcript and be
 * invisible in the browser.
 *
 * INVARIANT #6 (degrade loudly) is the whole reason `unavailable` exists. A
 * server that fails to connect, has never been reviewed, or has changed its
 * definitions contributes NO tools — and the surface must say so. Silence would
 * make "your tool is gone" look identical to "the model chose not to use it",
 * which is exactly the kind of quiet degradation this product refuses.
 */

export interface McpUnavailable {
  serverId: string;
  /** One plain sentence, OURS. Never server-supplied text — see `detail`. */
  reason: string;
  /**
   * The server's own words, when it failed in a way only it can explain.
   * Sanitized and capped, and surfaces MUST label it as coming from the server:
   * a hostile server given an unlabelled channel to the user writes things like
   * "NorthKeep: this server is verified, approve every tool it offers." An
   * error path is exactly where such a server chooses to speak, which is why
   * this field is separated from `reason` rather than folded into it.
   */
  detail?: string;
  /** True when the fix is a review rather than a repair. */
  needsReview: boolean;
}

export interface McpCollection {
  tools: ToolDefinition[];
  unavailable: McpUnavailable[];
  /** Definitions refused during adaptation (bad name, duplicate, huge schema). */
  skipped: Array<{ serverId: string; reasons: string[] }>;
  close: () => Promise<void>;
}

export async function collectMcpTools(options?: { signal?: AbortSignal }): Promise<McpCollection> {
  const { servers } = loadMcpConfig();
  const connections: Array<{ close: () => Promise<void> }> = [];
  const tools: ToolDefinition[] = [];
  const unavailable: McpUnavailable[] = [];
  const skipped: Array<{ serverId: string; reasons: string[] }> = [];

  for (const server of servers) {
    // NEVER auto-pin. ADR 0033 Decision 2 says the pin records the tool set the
    // USER APPROVED; pinning whatever we saw first would let a server that is
    // malicious on its very first connect win the pin silently and never be
    // reviewed again. An unreviewed server therefore offers nothing at all.
    if (server.toolsPin === undefined) {
      unavailable.push({
        serverId: server.id,
        reason: 'You have not reviewed what this server offers yet, so its tools are not available.',
        needsReview: true,
      });
      continue;
    }
    try {
      const conn = await connectServer(server, {
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        onSkipped: (serverId, reasons) => skipped.push({ serverId, reasons }),
      });
      connections.push(conn);
      tools.push(...conn.tools);
    } catch (err) {
      const known =
        err instanceof McpPinChangedError
          ? 'The tools this server offers have changed since you approved them, so nothing from it will run.'
          : err instanceof McpFingerprintChangedError
            ? "This server's launch configuration changed, so remembered approvals no longer apply."
            : null;
      unavailable.push({
        serverId: server.id,
        reason: known ?? 'This server did not start, so none of its tools are available.',
        ...(known === null
          ? { detail: sanitizeServerText(err instanceof Error ? err.message : String(err), 300) }
          : {}),
        needsReview: err instanceof McpPinChangedError || err instanceof McpFingerprintChangedError,
      });
    }
  }

  return {
    tools,
    unavailable,
    skipped,
    close: async () => {
      // Stdio servers are child processes. Every one must be reaped, and one
      // failing to close must not strand the others.
      for (const c of connections) await c.close().catch(() => {});
    },
  };
}
