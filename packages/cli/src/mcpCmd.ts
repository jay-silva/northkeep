import path from 'node:path';
import {
  addServer,
  collectMcpTools,
  connectServer,
  getServer,
  loadMcpConfig,
  McpFingerprintChangedError,
  McpPinChangedError,
  pinTools,
  removeServer,
  riskOf,
  sanitizeServerText,
  setSafeRead,
  setToolsPin,
} from '@northkeep/converse';
import { DIM, GREEN, RED, RESET, YELLOW } from './ui.js';

/**
 * `northkeep mcp` — the MCP server switchboard (M11, ADR 0033).
 *
 * Servers are configured HERE and nowhere else: there is no path from a model
 * turn to this file (Decision 6), the same rule that governs routing rules and
 * grants. Adding a server is a deliberate act with a printed consequence, and
 * the printed consequence is honest about what the fingerprint does and does
 * not protect (Decision 1).
 */

export function mcpList(): void {
  const { servers } = loadMcpConfig();
  if (servers.length === 0) {
    console.log('No MCP servers configured.');
    console.log(
      `${DIM}Add one with: northkeep mcp add <id> --command <absolute path> [--arg ...]${RESET}`,
    );
    return;
  }
  for (const s of servers) {
    const pinned = s.toolsPin !== undefined ? `${GREEN}pinned${RESET}` : `${DIM}not yet pinned${RESET}`;
    console.log(`  ${s.id.padEnd(16)} ${s.command} ${s.args.join(' ')}`);
    console.log(
      `  ${''.padEnd(16)} ${DIM}trust:${RESET} ${s.trust} · ${DIM}read-only tools:${RESET} ` +
        `${s.safeRead.length > 0 ? s.safeRead.join(', ') : 'none declared'} · ${pinned}`,
    );
  }
  console.log(`\n${DIM}Tools appear to the model as <server>__<tool>. Inspect: northkeep mcp tools <id>${RESET}`);
}

export function mcpAdd(
  id: string,
  options: { command?: string; arg?: string[]; cwd?: string; env?: string[]; safeRead?: string },
  fail: (m: string) => never,
): void {
  if (options.command === undefined) fail('An MCP server needs --command <absolute path>.');
  const env: Record<string, string> = {};
  for (const pair of options.env ?? []) {
    const eq = pair.indexOf('=');
    if (eq <= 0) fail(`--env expects NAME=VALUE, got "${pair}"`);
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  try {
    const server = addServer({
      id,
      command: path.resolve(options.command),
      args: options.arg ?? [],
      ...(options.cwd !== undefined ? { cwd: path.resolve(options.cwd) } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(options.safeRead !== undefined
        ? { safeRead: options.safeRead.split(',').map((t) => t.trim()).filter(Boolean) }
        : {}),
    });
    console.log(`✓ Added MCP server ${GREEN}${server.id}${RESET}.`);
    console.log(`  Its tools will appear to the model as ${server.id}__<tool>.`);
    console.log(
      `  ${DIM}Every call asks for your approval. Tools you have not marked read-only ask EVERY time${RESET}\n` +
        `  ${DIM}and can never be remembered with "always" — see: northkeep mcp safe-read ${server.id} <tools>${RESET}`,
    );
    // Say plainly what the fingerprint does and does not cover (ADR 0033 D1).
    console.log(
      `${YELLOW}  Note:${RESET} approvals are bound to this server's launch configuration. Changing the\n` +
        '        command, arguments, working directory or environment makes it ask again.\n' +
        '        It does NOT detect the program itself being changed at that path: an MCP\n' +
        '        server is a local program running with your privileges, like any other.',
    );
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

export function mcpRemove(id: string, fail: (m: string) => never): void {
  if (!removeServer(id)) fail(`No such MCP server: ${id}. See: northkeep mcp list`);
  console.log(`✓ Removed MCP server ${id}. Its tools are no longer offered.`);
  console.log(`${DIM}Any remembered approvals for it stay listed until revoked: northkeep tools grants${RESET}`);
}

export function mcpSafeRead(id: string, tools: string, fail: (m: string) => never): void {
  const list = tools.split(',').map((t) => t.trim()).filter(Boolean);
  try {
    setSafeRead(id, list);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  console.log(
    list.length > 0
      ? `✓ Marked read-only on ${id}: ${list.join(', ')}. Those may be remembered with "always".`
      : `✓ Cleared read-only tools on ${id}. Every tool now asks every time.`,
  );
}

/**
 * Connect and show what the server actually advertises. This is the review
 * surface Decision 2 depends on: a user cannot sensibly approve definitions
 * they have never read, and a pin they accept is a pin they should have seen.
 */
export async function mcpTools(id: string, accept: boolean, fail: (m: string) => never): Promise<void> {
  const server = getServer(id);
  if (server === undefined) fail(`No such MCP server: ${id}. See: northkeep mcp list`);
  let conn;
  try {
    // Show what is there even when the pin has moved; accepting is a separate,
    // explicit act below.
    conn = await connectServer(server, {
      enforcePin: false,
      onSkipped: (_id, reasons) => {
        console.log(`${YELLOW}⚠ ${reasons.length} definition(s) will be IGNORED:${RESET}`);
        for (const r of reasons) console.log(`    ${r}`);
      },
    });
  } catch (err) {
    if (err instanceof McpFingerprintChangedError) {
      fail(
        `${err.message}\nRe-add it if you meant to change it: northkeep mcp remove ${id} && northkeep mcp add ${id} ...`,
      );
    }
    fail(err instanceof Error ? err.message : String(err));
  }
  try {
    for (const t of conn.tools) {
      const bare = t.name.slice(id.length + 2);
      const risk = riskOf(server, bare);
      const label =
        risk === 'safe-read' ? `${GREEN}read-only${RESET}` : `${YELLOW}consequential${RESET}`;
      // Server-supplied text reaches a terminal here, and THIS is the only
      // human review of what a server advertises. adaptTool already stripped
      // control characters; collapsing whitespace keeps one tool to one line.
      console.log(`  ${t.name.padEnd(30)} ${label}`);
      if (t.description.length > 0) {
        console.log(`  ${DIM}${sanitizeServerText(t.description).replace(/\s+/g, ' ')}${RESET}`);
      }
    }
    const changed = server.toolsPin !== undefined && server.toolsPin !== conn.pin;
    if (server.toolsPin === undefined) {
      console.log(`\n${DIM}These definitions are not pinned yet.${RESET}`);
    } else if (changed) {
      console.log(
        `\n${RED}These definitions have CHANGED since you approved them.${RESET} Calls will refuse until you accept.`,
      );
    } else {
      console.log(`\n${GREEN}Matches the definitions you approved.${RESET}`);
    }
    if (accept) {
      setToolsPin(id, conn.pin);
      console.log(`✓ Pinned. Calls will refuse again if these definitions change.`);
    } else if (server.toolsPin === undefined || changed) {
      console.log(`${DIM}Accept them with: northkeep mcp tools ${id} --accept${RESET}`);
    }
  } finally {
    await conn.close().catch(() => {});
  }
}

/**
 * CLI rendering of the shared collector. The collector itself prints nothing
 * (the GUI needs the same facts as transcript notices), so the dim lines a
 * terminal user expects are produced here.
 */
export async function collectMcpToolsForCli(): Promise<{
  tools: Awaited<ReturnType<typeof collectMcpTools>>['tools'];
  close: () => Promise<void>;
}> {
  const collected = await collectMcpTools();
  for (const u of collected.unavailable) {
    console.log(`${YELLOW}⚠ MCP server "${u.serverId}" is not available:${RESET} ${u.reason}`);
    // The server's own words are LABELLED as its own. Unlabelled, a hostile
    // server writes sentences that read as NorthKeep speaking.
    if (u.detail !== undefined) console.log(`  ${DIM}the server said: ${u.detail}${RESET}`);
    if (u.needsReview) {
      console.log(`  ${DIM}Review it with: northkeep mcp tools ${u.serverId} --accept${RESET}`);
    }
  }
  for (const s of collected.skipped) {
    console.log(`${YELLOW}⚠ Ignored ${s.reasons.length} definition(s) from "${s.serverId}":${RESET}`);
    for (const r of s.reasons) console.log(`    ${r}`);
  }
  return { tools: collected.tools, close: collected.close };
}
