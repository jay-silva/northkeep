import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * M8 "Connect" (ADR 0013) — register the MCP server that ships *inside*
 * NorthKeep with the consumer AI apps (Claude Desktop, Claude Code), so a user
 * who only downloaded the app gets one-click memory portability. No repo, no
 * terminal, no separate Node install required.
 *
 * The crown-jewel invariant (ADR Decision 2): we are editing files NorthKeep
 * does not own. The writer MERGES — it reads the existing config, touches ONLY
 * our `mcpServers.northkeep` key, backs up the original before the first write,
 * and REFUSES to touch a config it cannot parse. Everything else is preserved
 * byte-faithfully.
 */

export type ConnectTarget = 'claude-desktop' | 'claude-code';

/** The MCP server name key we own in every target's config. We touch no other. */
export const SERVER_NAME = 'northkeep';

export interface McpCommand {
  command: string;
  args: string[];
}

export interface ConnectResult {
  restartNeeded: true;
  command: string;
  args: string[];
}

export interface ConnectStatus {
  connected: boolean;
  scopes?: string[];
}

/**
 * Derive the command that launches the bundled MCP server, from the *currently
 * running* process. `command` is this process's own binary (the bundled Node in
 * `NorthKeep.app`, or system `node` in a dev checkout). `args[0]` is the sibling
 * `index.js` of THIS module — because `connect.js` ships alongside `index.js` in
 * `mcp-server/dist/`, this resolves correctly in BOTH the signed .app and a dev
 * checkout without assuming any layout.
 *
 * Sanity note: the resolved entry must end with `mcp-server/dist/index.js` — the
 * self-start guard in index.ts keys off exactly that suffix. If it doesn't, we
 * still return it (Connect should not silently fail) but warn on stderr.
 */
export function resolveMcpCommand(): McpCommand {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const entry = path.join(here, 'index.js');
  if (!mcpEntryLooksValid(entry)) {
    console.error(
      `⚠  NorthKeep Connect: the MCP entry resolved to "${entry}", which does not end with ` +
        `"mcp-server/dist/index.js". The server self-start guard keys off that suffix, so the ` +
        `connected app may fail to launch it. Registering it anyway.`,
    );
  }
  return { command: process.execPath, args: [entry] };
}

/** True when the entry path ends with the self-start suffix the server guards on. */
export function mcpEntryLooksValid(entry: string): boolean {
  return entry.split(path.sep).join('/').endsWith('mcp-server/dist/index.js');
}

// ---------------------------------------------------------------------------
// Claude Desktop — we hand-edit its JSON config, so the surgical rules apply.
// ---------------------------------------------------------------------------

/**
 * Path to Claude Desktop's config. `override` lets callers inject a path;
 * `NORTHKEEP_CLAUDE_DESKTOP_CONFIG` does the same via the environment (used by
 * the e2e so a full CLI round-trip never touches the real config, and available
 * to power users with a non-standard install).
 */
export function claudeDesktopConfigPath(override?: string): string {
  if (override) return override;
  const fromEnv = process.env.NORTHKEEP_CLAUDE_DESKTOP_CONFIG;
  if (fromEnv) return fromEnv;
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Claude',
    'claude_desktop_config.json',
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read an app config as a plain object, or `{}` if the file is absent/empty.
 * THROWS on a present-but-unparseable file — we must never clobber a config we
 * can't understand (ADR Decision 2).
 */
function readConfig(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw unparseable(file);
  }
  if (!isObject(parsed)) throw unparseable(file);
  return parsed;
}

function unparseable(file: string): Error {
  return new Error(
    `Refusing to modify ${file}: it exists but is not a valid JSON object. ` +
      `NorthKeep never overwrites a config it cannot parse — fix or move that file, then reconnect.`,
  );
}

/**
 * Copy the config to `<file>.northkeep-bak` before the first write, so the
 * pristine pre-NorthKeep config is always recoverable. Only backs up when the
 * file exists and no backup exists yet (so we never overwrite the original
 * backup with a config that already carries our edits).
 */
function backupOnce(file: string): void {
  const bak = `${file}.northkeep-bak`;
  if (fs.existsSync(file) && !fs.existsSync(bak)) {
    fs.copyFileSync(file, bak);
  }
}

/**
 * Write pretty (2-space) JSON with a trailing newline; mkdir -p the parent.
 * ATOMIC (temp file + rename) so a mid-write crash can never leave the user's
 * real Claude config truncated, and MODE-PRESERVING — the config can carry
 * other MCP servers' secrets in `env`, so a rewrite must not loosen its
 * permissions. New files get 0600 (safer default for a file that may hold
 * secrets); existing files keep their own mode.
 */
function writeConfig(file: string, config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = 0o600;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    /* new file — keep the 0600 default */
  }
  const tmp = `${file}.northkeep-tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode });
  fs.chmodSync(tmp, mode); // writeFileSync mode is subject to umask; force it
  fs.renameSync(tmp, file); // atomic on the same filesystem
}

function normalizeScopes(scopes?: string[]): string[] {
  return (scopes ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
}

export function claudeDesktopStatus(configPathOverride?: string): ConnectStatus {
  const file = claudeDesktopConfigPath(configPathOverride);
  let config: Record<string, unknown>;
  try {
    config = readConfig(file);
  } catch {
    // An unparseable config is not "connected" for status purposes, and status
    // must never throw. (Connect/disconnect still refuse it loudly.)
    return { connected: false };
  }
  const servers = isObject(config.mcpServers) ? config.mcpServers : undefined;
  const entry = servers && isObject(servers[SERVER_NAME]) ? servers[SERVER_NAME] : undefined;
  if (!isObject(entry)) return { connected: false };
  const env = isObject(entry.env) ? entry.env : undefined;
  const raw = env && typeof env.NORTHKEEP_SCOPES === 'string' ? env.NORTHKEEP_SCOPES : undefined;
  const scopes = raw
    ? raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    : undefined;
  return scopes ? { connected: true, scopes } : { connected: true };
}

/**
 * Register the bundled MCP server in Claude Desktop's config. MERGES: reads the
 * existing config (refusing an unparseable one), backs it up once, and sets ONLY
 * `mcpServers.northkeep`, preserving every other key. Scopes, when given, become
 * the `env.NORTHKEEP_SCOPES` allowlist the M4 server enforces fail-closed.
 */
export function connectClaudeDesktop(
  opts: { scopes?: string[] } = {},
  configPathOverride?: string,
): ConnectResult {
  const file = claudeDesktopConfigPath(configPathOverride);
  const config = readConfig(file); // throws on unparseable — never clobber
  const { command, args } = resolveMcpCommand();
  const scopes = normalizeScopes(opts.scopes);

  backupOnce(file);

  const servers = isObject(config.mcpServers) ? config.mcpServers : {};
  servers[SERVER_NAME] = {
    command,
    args,
    ...(scopes.length ? { env: { NORTHKEEP_SCOPES: scopes.join(',') } } : {}),
  };
  config.mcpServers = servers;
  writeConfig(file, config);

  return { restartNeeded: true, command, args };
}

/** Remove ONLY `mcpServers.northkeep`; leave every other key (and an empty
 * `mcpServers` object) exactly as found. Refuses an unparseable config. */
export function disconnectClaudeDesktop(configPathOverride?: string): { removed: boolean } {
  const file = claudeDesktopConfigPath(configPathOverride);
  if (!fs.existsSync(file)) return { removed: false };
  const config = readConfig(file); // throws on unparseable — never clobber
  const servers = isObject(config.mcpServers) ? config.mcpServers : undefined;
  if (!servers || !(SERVER_NAME in servers)) return { removed: false };
  backupOnce(file);
  delete servers[SERVER_NAME];
  writeConfig(file, config);
  return { removed: true };
}

// ---------------------------------------------------------------------------
// Claude Code — registered through its own supported CLI, never hand-edited
// (ADR Decision 2). No shell string; execFileSync with an args array = no
// injection. NORTHKEEP_SCOPES is a capability allowlist, not a secret.
// ---------------------------------------------------------------------------

/** Is the `claude` CLI on PATH? */
export function claudeCodeAvailable(): boolean {
  try {
    execFileSync('which', ['claude'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function claude(args: string[]): string {
  return execFileSync('claude', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Best-effort: is `northkeep` registered in Claude Code? `claude mcp get`
 * exits non-zero when the server is absent. Per-connection scopes are not
 * reliably reported by the CLI, so `scopes` is left undefined here. */
export function claudeCodeStatus(): ConnectStatus {
  if (!claudeCodeAvailable()) return { connected: false };
  try {
    execFileSync('claude', ['mcp', 'get', SERVER_NAME], { stdio: 'ignore' });
    return { connected: true };
  } catch {
    return { connected: false };
  }
}

/**
 * Register the bundled server via `claude mcp add northkeep --scope user
 * [--env NORTHKEEP_SCOPES=…] -- <command> <args…>`. Removes any prior
 * user-scope registration first so reconnect is idempotent (add rejects a
 * duplicate name). The `--` separates our subprocess argv from claude's flags.
 */
export function connectClaudeCode(opts: { scopes?: string[] } = {}): ConnectResult {
  if (!claudeCodeAvailable()) {
    throw new Error(
      'The `claude` CLI was not found on your PATH. Install Claude Code, or connect Claude Desktop instead.',
    );
  }
  const { command, args } = resolveMcpCommand();
  const scopes = normalizeScopes(opts.scopes);

  // Idempotent: clear a prior user-scope entry (ignore "not found").
  try {
    claude(['mcp', 'remove', SERVER_NAME, '--scope', 'user']);
  } catch {
    /* not previously registered — fine */
  }

  const addArgs = ['mcp', 'add', SERVER_NAME, '--scope', 'user'];
  if (scopes.length) addArgs.push('--env', `NORTHKEEP_SCOPES=${scopes.join(',')}`);
  addArgs.push('--', command, ...args);
  claude(addArgs);

  return { restartNeeded: true, command, args };
}

/** Remove the user-scope `northkeep` registration from Claude Code. */
export function disconnectClaudeCode(): { removed: boolean } {
  if (!claudeCodeAvailable()) return { removed: false };
  try {
    claude(['mcp', 'remove', SERVER_NAME, '--scope', 'user']);
    return { removed: true };
  } catch {
    return { removed: false };
  }
}

// ---------------------------------------------------------------------------
// Umbrella dispatch (each app's writer stays explicit above).
// ---------------------------------------------------------------------------

export function connect(
  target: ConnectTarget,
  opts: { scopes?: string[] } = {},
): ConnectResult {
  return target === 'claude-desktop' ? connectClaudeDesktop(opts) : connectClaudeCode(opts);
}

export function disconnect(target: ConnectTarget): { removed: boolean } {
  return target === 'claude-desktop' ? disconnectClaudeDesktop() : disconnectClaudeCode();
}

export function connectStatus(target: ConnectTarget): ConnectStatus {
  return target === 'claude-desktop' ? claudeDesktopStatus() : claudeCodeStatus();
}
