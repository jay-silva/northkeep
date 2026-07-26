import fs from 'node:fs';
import path from 'node:path';
import { northkeepHome } from '@northkeep/core';
import { fingerprintLaunch, isValidServerId, type LaunchSpec } from './identity.js';

/**
 * MCP server configuration (M11, ADR 0033 Decision 6).
 *
 * Servers are CONFIGURED BY THE USER, never discovered, auto-installed, or
 * added by a model turn — the same rule routing rules (ADR 0011) and grants
 * (ADR 0029) follow. There is deliberately no code path from a model turn to
 * this file, exactly as there is no CLI `grant` command.
 *
 * Storage: ~/.northkeep/mcp.json, the same idiom as tools.json, permissions.json
 * and budget.json — version field, 0600 writes with a chmod on EVERY write,
 * tolerant loader, strict writer.
 *
 * FAIL-CLOSED DIRECTION: like policy.ts and unlike budget.ts, an entry this
 * loader cannot fully validate simply DOES NOT EXIST. A malformed server is not
 * a server, so its tools are never offered to the model and nothing it would
 * have run can run. Degrading to "no MCP tools" is always safe; degrading to
 * "a server we could not fully parse" is not.
 */

/**
 * Per-tool risk. ADR 0033 Decision 4: MCP gives no reliable risk signal, so
 * risk is USER-DECLARED, and anything unclassified is treated as
 * `consequential` — which means it asks every single time and can never hold
 * an `always` grant. Users mark the read-only tools explicitly.
 */
export type McpToolRisk = 'safe-read' | 'consequential';

/**
 * How much the user trusts this server with argument content (ADR 0033
 * Decision 3). We cannot see where a server sends things, so:
 *  - 'strict'  (default): arguments get the deterministic Tier-1 mask before the
 *    server sees them. ADR 0033 originally specified Tier 3 here and was amended
 *    to Tier 1, because Tier 3 needs the local NER model and would break every
 *    MCP call whenever Ollama is stopped. Tier 1 is always available, so there is
 *    no unavailable case to refuse on.
 *  - 'trusted': the user has declared this server a local consumer, so
 *    arguments pass at the conversation's own tier. Never inferred, and
 *    "local" or "ours" does not earn it — the vault's own server can read
 *    every memory.
 */
export type McpTrust = 'strict' | 'trusted';

export interface McpServerConfig {
  id: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  trust: McpTrust;
  /** Tool names the user declared read-only. Everything else is consequential. */
  safeRead: string[];
  /** Launch fingerprint recorded when the server was added (identity.ts). */
  fingerprint: string;
  /** Definitions pin recorded at first successful connect; absent until then. */
  toolsPin?: string;
  addedAt: string;
}

export interface McpConfig {
  version: 1;
  servers: McpServerConfig[];
}

export function mcpConfigPath(): string {
  return path.join(northkeepHome(), 'mcp.json');
}

const EMPTY: McpConfig = { version: 1, servers: [] };

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

const isStringRecord = (v: unknown): v is Record<string, string> =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string');

/** Every field must be well-formed or the whole server entry is dropped. */
function isServer(entry: unknown): entry is McpServerConfig {
  if (entry === null || typeof entry !== 'object') return false;
  const s = entry as Record<string, unknown>;
  if (!isValidServerId(s.id)) return false;
  if (typeof s.command !== 'string' || s.command.length === 0) return false;
  if (!isStringArray(s.args)) return false;
  if (s.cwd !== undefined && typeof s.cwd !== 'string') return false;
  if (s.env !== undefined && !isStringRecord(s.env)) return false;
  if (s.trust !== 'strict' && s.trust !== 'trusted') return false;
  if (!isStringArray(s.safeRead)) return false;
  if (typeof s.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(s.fingerprint)) return false;
  if (s.toolsPin !== undefined && (typeof s.toolsPin !== 'string' || !/^[0-9a-f]{64}$/.test(s.toolsPin)))
    return false;
  if (typeof s.addedAt !== 'string') return false;
  return true;
}

export function loadMcpConfig(): McpConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(mcpConfigPath(), 'utf8')) as unknown;
  } catch {
    return structuredClone(EMPTY); // missing or corrupt → no servers
  }
  if (parsed === null || typeof parsed !== 'object') return structuredClone(EMPTY);
  const raw = parsed as Record<string, unknown>;
  // Never honor a version we did not write: a schema we do not understand could
  // misencode a fingerprint or a risk class, and guessing is how a
  // 'consequential' tool gets read as 'safe-read'.
  if (raw.version !== 1) return structuredClone(EMPTY);
  if (!Array.isArray(raw.servers)) return structuredClone(EMPTY);

  const out = structuredClone(EMPTY);
  const seen = new Set<string>();
  for (const entry of raw.servers) {
    if (!isServer(entry)) continue;
    if (seen.has(entry.id)) continue; // duplicate ids would make the namespace ambiguous
    seen.add(entry.id);
    out.servers.push({
      id: entry.id,
      command: entry.command,
      args: [...entry.args],
      ...(entry.cwd !== undefined ? { cwd: entry.cwd } : {}),
      ...(entry.env !== undefined ? { env: { ...entry.env } } : {}),
      trust: entry.trust,
      safeRead: [...entry.safeRead],
      fingerprint: entry.fingerprint,
      ...(entry.toolsPin !== undefined ? { toolsPin: entry.toolsPin } : {}),
      addedAt: entry.addedAt,
    });
  }
  return out;
}

function save(config: McpConfig): void {
  const target = mcpConfigPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // `mode` applies only on CREATE, so chmod every write — a pre-existing file
  // (older version, loose umask, or an attacker pre-creating it world-readable)
  // would otherwise keep its old perms. Same reasoning as policy.ts.
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // best effort: a filesystem without POSIX perms is not a reason to fail.
  }
}

export function getServer(id: string): McpServerConfig | undefined {
  return loadMcpConfig().servers.find((s) => s.id === id);
}

export interface AddServerInput extends LaunchSpec {
  id: string;
  trust?: McpTrust;
  safeRead?: string[];
}

/**
 * Add a server. Computes the launch fingerprint now (which also validates that
 * the command is an absolute, resolvable path — resolveCommand throws
 * otherwise). Refuses to overwrite an existing id: silently rebinding a label
 * to a different program is precisely the swap Decision 1 guards against, so
 * replacing one is an explicit remove-then-add.
 */
export function addServer(input: AddServerInput, now: () => Date = () => new Date()): McpServerConfig {
  if (!isValidServerId(input.id)) {
    throw new Error(
      `Invalid server id "${String(input.id)}". Use lowercase letters, digits and hyphens ` +
        '(the id is part of the tool namespace the model sees).',
    );
  }
  const config = loadMcpConfig();
  if (config.servers.some((s) => s.id === input.id)) {
    // Surface-neutral on purpose: addServer is shared, and telling a GUI user
    // to run a terminal command (while a Remove button sits on their screen) is
    // exactly the gap ADR 0034 set out to close. Each surface adds its own hint.
    throw new Error(`An MCP server named "${input.id}" already exists. Remove it before adding another with that name.`);
  }
  const server: McpServerConfig = {
    id: input.id,
    command: input.command,
    args: [...input.args],
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.env !== undefined ? { env: { ...input.env } } : {}),
    trust: input.trust ?? 'strict',
    safeRead: [...(input.safeRead ?? [])],
    fingerprint: fingerprintLaunch(input),
    addedAt: now().toISOString(),
  };
  config.servers.push(server);
  save(config);
  return server;
}

export function removeServer(id: string): boolean {
  const config = loadMcpConfig();
  const before = config.servers.length;
  config.servers = config.servers.filter((s) => s.id !== id);
  if (config.servers.length === before) return false;
  save(config);
  return true;
}

/**
 * Record the definitions pin for a server (first connect, or after the user
 * accepts a change). Kept separate from addServer because a pin is an
 * observation about the server, not user configuration.
 */
export function setToolsPin(id: string, pin: string): void {
  if (!/^[0-9a-f]{64}$/.test(pin)) throw new Error('A tools pin must be a sha256 hex digest.');
  const config = loadMcpConfig();
  const server = config.servers.find((s) => s.id === id);
  if (server === undefined) throw new Error(`No such MCP server: ${id}`);
  server.toolsPin = pin;
  save(config);
}

/** Declare a tool read-only, so it may hold an `always` grant (Decision 4). */
export function setSafeRead(id: string, tools: string[]): void {
  const config = loadMcpConfig();
  const server = config.servers.find((s) => s.id === id);
  if (server === undefined) throw new Error(`No such MCP server: ${id}`);
  server.safeRead = [...new Set(tools)];
  save(config);
}

/** A tool's risk: user-declared read-only, else consequential (fail closed). */
export function riskOf(server: McpServerConfig, tool: string): McpToolRisk {
  return server.safeRead.includes(tool) ? 'safe-read' : 'consequential';
}
