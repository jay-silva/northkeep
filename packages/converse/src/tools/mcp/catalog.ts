import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServerConfig, McpTrust } from './config.js';

/**
 * The MCP server catalog (ADR 0034 Decision 1).
 *
 * The point of a catalog is that **the request carries a catalog id, never a
 * path**. Commands come from these templates, so the add route cannot be talked
 * into spawning something of the caller's choosing — which is what lets the
 * common case skip re-authentication entirely and stay one click.
 *
 * It never downloads anything. An entry describes something already on the
 * machine, and `available` reports honestly when it is not there.
 *
 * Mirrors the KNOWN_PROVIDERS pattern (M9) deliberately: same shape, same
 * reasoning, one fewer thing for a reader to learn.
 */

export interface McpCatalogEntry {
  id: string;
  label: string;
  /** One plain sentence: what this server lets the chat do. */
  description: string;
  /** Tools that only READ, pre-declared so the common case is not all-asks. */
  safeRead: string[];
  /** Why you might want it, and what it can see. Shown before adding. */
  caution: string;
  /**
   * Trust the add route records (ADR 0060 Decision 4). Only the bundled vault
   * server is `trusted`: its arguments go into the vault on this machine.
   */
  trust: McpTrust;
}

export interface ResolvedMcpCatalogEntry extends McpCatalogEntry {
  available: boolean;
  /** Absent when unavailable; this is what would actually be spawned. */
  command?: string;
  args?: string[];
  /** Why it is unavailable, when it is. */
  unavailableReason?: string;
}

/**
 * NorthKeep's own MCP server, resolved from THIS installation.
 *
 * We know where it is because we are running from the same tree (dev) or the
 * same app bundle (packaged), so the user never types a path and no request
 * body ever names one. `process.execPath` is the Node that is already running
 * us, which in the desktop app is the pinned sidecar binary.
 */
function resolveVaultServer(): { command: string; args: string[] } | { reason: string } {
  // packages/converse/dist/tools/mcp/ → up to packages/, then mcp-server/dist.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '..', '..', '..', '..', 'mcp-server', 'dist', 'index.js'),
    // Packaged layout: the server tree sits beside converse under Resources.
    path.resolve(here, '..', '..', '..', '..', '..', 'mcp-server', 'dist', 'index.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { command: process.execPath, args: [candidate] };
  }
  return { reason: 'The bundled vault server was not found next to this installation.' };
}

const ENTRIES: Array<McpCatalogEntry & { resolve: () => { command: string; args: string[] } | { reason: string } }> = [
  {
    id: 'vault',
    label: 'Your NorthKeep vault',
    description:
      'Lets your chat search and add to your own memories while it is answering, instead of only at the start of a turn.',
    // Reading is declared safe; remembering and forgetting are not, so they ask
    // every time and can never be remembered with "always" (ADR 0033 D4).
    safeRead: ['memory_retrieve', 'memory_list'],
    caution:
      'This server can read every memory in your vault. It runs on this Mac and sends nothing anywhere by itself.',
    // What you ask it to remember is saved exactly, not Tier-1 masked: it is
    // the vault on this machine (ADR 0060 Decision 4, amending ADR 0033 D3).
    trust: 'trusted',
    resolve: resolveVaultServer,
  },
];

export function listMcpCatalog(): ResolvedMcpCatalogEntry[] {
  return ENTRIES.map((entry) => {
    const { resolve, ...rest } = entry;
    const resolved = resolve();
    if ('reason' in resolved) {
      return { ...rest, available: false, unavailableReason: resolved.reason };
    }
    return { ...rest, available: true, command: resolved.command, args: resolved.args };
  });
}

export function getMcpCatalogEntry(id: string): ResolvedMcpCatalogEntry | undefined {
  return listMcpCatalog().find((e) => e.id === id);
}

/**
 * Whether an existing entry is exactly the bundled vault server's launch, so
 * the "This is my NorthKeep vault" button may be OFFERED (ADR 0060 Decision 4,
 * F8). It never sets trust by itself: only the user's confirm does. An entry
 * with any env or cwd override is refused, because NORTHKEEP_HOME or a working
 * directory can point this same program at a different vault.
 */
export function isBundledVaultLaunch(server: McpServerConfig): boolean {
  if (server.transport !== 'stdio') return false;
  if (server.env !== undefined && Object.keys(server.env).length > 0) return false;
  if (server.cwd !== undefined) return false;
  const entry = getMcpCatalogEntry('vault');
  if (entry === undefined || !entry.available || entry.command === undefined || entry.args === undefined) return false;
  return server.command === entry.command &&
    server.args.length === entry.args.length &&
    server.args.every((arg, i) => arg === entry.args![i]);
}
