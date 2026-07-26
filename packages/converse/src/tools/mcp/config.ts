import fs from 'node:fs';
import path from 'node:path';
import { northkeepHome } from '@northkeep/core';
import net from 'node:net';
import { classifyEndpoint } from '../../provider.js';
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

/**
 * Transport. A stdio server is a local program identified by a launch
 * fingerprint; a remote server is an HTTPS origin identified by TLS (ADR 0035
 * Decision 2). They share the pin, the risk model and the grant machinery, and
 * differ in identity and in whether anything leaves the machine — so the config
 * is a discriminated union rather than one shape with optional halves.
 *
 * The `transport` field is OPTIONAL on read and defaults to 'stdio', so every
 * entry written before M12 loads unchanged. Extending version 1 is deliberate:
 * loadMcpConfig returns ZERO servers for a version it did not write, so bumping
 * would make an older build silently see no servers at all.
 */
export type McpTransport = 'stdio' | 'http';

interface McpServerCommon {
  id: string;
  trust: McpTrust;
  /** Tool names the user declared read-only. Everything else is consequential. */
  safeRead: string[];
  /** Definitions pin recorded once the user reviews and accepts; absent until then. */
  toolsPin?: string;
  addedAt: string;
}

export interface McpStdioServer extends McpServerCommon {
  transport: 'stdio';
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Launch fingerprint recorded when the server was added (identity.ts). */
  fingerprint: string;
}

export interface McpHttpServer extends McpServerCommon {
  transport: 'http';
  /**
   * The endpoint to POST to: scheme, host, port and PATH. Query and fragment
   * are dropped — a query string is where a token gets pasted by accident, and
   * nothing about an MCP endpoint needs one.
   *
   * IDENTITY is `new URL(url).origin`, not this whole string (Decision 2), and
   * that is what the stored credentials are bound to. Keeping the path here is
   * not a weakening: a real endpoint is `https://host/mcp/v1`, and storing the
   * bare origin would have produced a config that cannot connect at all.
   */
  url: string;
  /**
   * OAuth client id, when the provider requires a pre-registered client.
   * Google's remote MCP servers do not support dynamic registration, so this is
   * the primary path rather than a fallback. The SECRET is never stored here —
   * it lives in the Keychain beside the tokens.
   */
  clientId?: string;
}

export type McpServerConfig = McpStdioServer | McpHttpServer;

export const isHttpServer = (s: McpServerConfig): s is McpHttpServer => s.transport === 'http';
/** For raw loader entries, where `transport` may be absent (pre-M12 = stdio). */
const rawIsHttp = (e: { transport?: unknown }): boolean => e.transport === 'http';
export const isStdioServer = (s: McpServerConfig): s is McpStdioServer => s.transport === 'stdio';

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
  if (s.trust !== 'strict' && s.trust !== 'trusted') return false;
  if (!isStringArray(s.safeRead)) return false;
  if (s.toolsPin !== undefined && (typeof s.toolsPin !== 'string' || !/^[0-9a-f]{64}$/.test(s.toolsPin)))
    return false;
  if (typeof s.addedAt !== 'string') return false;

  // Absent transport means an entry written before M12, which was always stdio.
  const transport = s.transport ?? 'stdio';
  if (transport === 'stdio') {
    if (typeof s.command !== 'string' || s.command.length === 0) return false;
    if (!isStringArray(s.args)) return false;
    if (s.cwd !== undefined && typeof s.cwd !== 'string') return false;
    if (s.env !== undefined && !isStringRecord(s.env)) return false;
    return typeof s.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(s.fingerprint);
  }
  if (transport === 'http') {
    // A remote entry is only as good as its URL. Validate it the same way the
    // add path does, so a hand-edited file cannot smuggle in an origin the add
    // route would have refused (ADR 0035 Decision 1).
    if (typeof s.url !== 'string') return false;
    if (!remoteUrlRefusal(s.url).ok) return false;
    if (s.clientId !== undefined && typeof s.clientId !== 'string') return false;
    // A remote server must NEVER be 'trusted': it sends data off the machine by
    // definition, and that setting exists for a local server the user owns.
    if (s.trust !== 'strict') return false;
    return true;
  }
  return false;
}

/**
 * The positive check a remote MCP origin must pass, at add time AND at every
 * connect (ADR 0035 Decision 1). A blocklist of "http and localhost" does not
 * hold: `https://192.168.1.1` classifies private, and `https://127.0.0.1.nip.io`
 * is a public name resolving to loopback for which anyone owning the domain can
 * obtain a valid certificate. So this asks whether the origin is positively
 * BOUNDED, rather than whether it looks local.
 */
export function remoteUrlRefusal(
  rawUrl: string,
): { ok: true; endpoint: string; origin: string } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'That is not a valid URL.' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'A remote MCP server must be https. A server on this machine should be added as a local command instead, where its identity is the program it runs.' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'A URL with embedded credentials is refused.' };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) !== 0) {
    return { ok: false, reason: 'A bare IP address is refused: an origin is identified by its name and certificate.' };
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, reason: `${host} is a local name. Add a server on this machine as a local command instead.` };
  }
  let tier: string;
  try {
    tier = classifyEndpoint(url.origin).tier;
  } catch {
    return { ok: false, reason: 'That origin could not be classified.' };
  }
  if (tier !== 'bounded') {
    return { ok: false, reason: `That origin classifies as ${tier}, not a remote service. Add a server on this machine as a local command instead.` };
  }
  // Keep the path, drop query and fragment. A trailing slash is normalized away
  // so the same endpoint typed two ways is one entry.
  const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return { ok: true, endpoint: `${url.origin}${pathname}`, origin: url.origin };
}

/** The identity half of a stored endpoint: scheme, host, port. */
export function endpointOrigin(url: string): string {
  return new URL(url).origin;
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
    // Normalize to exactly the known fields, per transport. Extra keys in a
    // hand-edited file are never carried through to disk.
    const common = {
      id: entry.id,
      trust: entry.trust,
      safeRead: [...entry.safeRead],
      ...(entry.toolsPin !== undefined ? { toolsPin: entry.toolsPin } : {}),
      addedAt: entry.addedAt,
    };
    // isServer has already validated each shape; these casts read the fields it
    // proved present, per transport.
    if (rawIsHttp(entry as { transport?: unknown })) {
      const h = entry as unknown as McpHttpServer;
      out.servers.push({
        ...common,
        transport: 'http',
        url: h.url,
        ...(h.clientId !== undefined ? { clientId: h.clientId } : {}),
      });
    } else {
      const d = entry as unknown as McpStdioServer;
      out.servers.push({
        ...common,
        transport: 'stdio',
        command: d.command,
        args: [...d.args],
        ...(d.cwd !== undefined ? { cwd: d.cwd } : {}),
        ...(d.env !== undefined ? { env: { ...d.env } } : {}),
        fingerprint: d.fingerprint,
      });
    }
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
  const server: McpStdioServer = {
    id: input.id,
    transport: 'stdio',
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

export interface AddRemoteServerInput {
  id: string;
  url: string;
  clientId?: string;
  safeRead?: string[];
}

/**
 * Add a remote (HTTPS) MCP server — ADR 0035.
 *
 * Three things differ from addServer and each is a decision, not an omission:
 *  - the URL must pass `remoteUrlRefusal` (Decision 1), the same check the
 *    loader applies, so a refused origin cannot arrive by either route;
 *  - the ENDPOINT is stored — scheme, host, port and path — with query and
 *    fragment dropped, since a query string is where a token gets pasted by
 *    accident. IDENTITY is `endpointOrigin()` of that (Decision 2); the path is
 *    how you reach the origin, not part of who it is. Storing the bare origin,
 *    as an earlier draft said, produces a config that cannot connect at all;
 *  - there is no `trust` parameter. A remote server is always `strict`: 'trusted'
 *    means "a local consumer I own", and this one is by definition not.
 */
export function addRemoteServer(
  input: AddRemoteServerInput,
  now: () => Date = () => new Date(),
): McpHttpServer {
  if (!isValidServerId(input.id)) {
    throw new Error(
      `Invalid server id "${String(input.id)}". Use lowercase letters, digits and hyphens ` +
        '(the id is part of the tool namespace the model sees).',
    );
  }
  const checked = remoteUrlRefusal(input.url);
  if (!checked.ok) throw new Error(checked.reason);
  const config = loadMcpConfig();
  if (config.servers.some((s) => s.id === input.id)) {
    throw new Error(`An MCP server named "${input.id}" already exists. Remove it before adding another with that name.`);
  }
  const server: McpHttpServer = {
    id: input.id,
    transport: 'http',
    url: checked.endpoint,
    ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
    trust: 'strict',
    safeRead: [...(input.safeRead ?? [])],
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
