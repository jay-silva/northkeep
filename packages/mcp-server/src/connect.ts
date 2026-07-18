import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';

/**
 * M8 "Connect" (ADR 0013, extended for ChatGPT in ADR 0021) — register the MCP
 * server that ships *inside* NorthKeep with the consumer AI apps (Claude
 * Desktop, Claude Code, ChatGPT desktop), so a user who only downloaded the app
 * gets one-click memory portability. No repo, no terminal, no separate Node
 * install required.
 *
 * The crown-jewel invariant (ADR Decision 2): we are editing files NorthKeep
 * does not own. The writer MERGES — it reads the existing config, touches ONLY
 * our `mcpServers.northkeep` key, backs up the original before the first write,
 * and REFUSES to touch a config it cannot parse. Everything else is preserved
 * byte-faithfully. (ChatGPT's config is TOML that can carry hand-written
 * comments and other servers' secrets, so its writer preserves the file text
 * verbatim and rewrites ONLY our own table — see the Codex/ChatGPT section.)
 */

export type ConnectTarget = 'claude-desktop' | 'claude-code' | 'chatgpt';

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
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode });
    fs.chmodSync(tmp, mode); // writeFileSync mode is subject to umask; force it
    fs.renameSync(tmp, file); // atomic on the same filesystem
  } finally {
    // Never leave a stray temp behind if the rename didn't happen.
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
  }
}

/**
 * Trim + drop empties. NOTE (deliberate asymmetry, adversarial review): when
 * the result is empty we OMIT `NORTHKEEP_SCOPES` entirely → owner/full access
 * ("no restriction requested"), whereas the server treats a *present-but-empty*
 * `NORTHKEEP_SCOPES=` as deny-all (fail-closed). No UI path reaches this — the
 * GUI's "Everything" sends `[]` intentionally and a real preset is never empty —
 * and the resulting access is surfaced honestly ("full access") in both the CLI
 * and GUI. So connect fails OPEN on empty only for an explicit "no scopes" ask.
 */
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
// ChatGPT desktop (ADR 0021) — the consumer ChatGPT app reads local stdio MCP
// servers from Codex's shared config at ~/.codex/config.toml (also used by the
// Codex CLI and IDE extension). It is TOML, not JSON, and — unlike Claude
// Desktop's machine-managed JSON — it is routinely hand-edited with comments and
// can hold OTHER MCP servers' secrets in their `env` tables. So we NEVER
// round-trip the whole file (that would drop comments and reorder keys).
// Instead we preserve the file text verbatim and rewrite ONLY our own
// `[mcp_servers.northkeep]` table (and its `.env` subtable), by:
//   1. parsing with a real TOML reader to REFUSE an unparseable file,
//   2. text-stripping our canonical table block(s) — leaving everything else
//      byte-for-byte,
//   3. refusing if `mcp_servers.northkeep` was declared in an inline/dotted form
//      we can't rewrite safely (fail closed, never mangle),
//   4. appending our freshly-built table, then
//   5. re-parsing the result and verifying our entry decoded to exactly what we
//      intended before any bytes hit disk.
// ---------------------------------------------------------------------------

/**
 * Path to Codex's config (shared by the ChatGPT desktop app). `override` /
 * `NORTHKEEP_CODEX_CONFIG` mirror the Claude Desktop hooks so the e2e never
 * touches a real config and power users with a non-standard install can point us
 * at theirs.
 */
export function codexConfigPath(override?: string): string {
  if (override) return override;
  const fromEnv = process.env.NORTHKEEP_CODEX_CONFIG;
  if (fromEnv) return fromEnv;
  return path.join(os.homedir(), '.codex', 'config.toml');
}

function readText(file: string): string {
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

/** Parse TOML to a plain object, `{}` for empty, THROWING a friendly refusal on
 * an unparseable file (same posture as the JSON `readConfig`). */
function parseTomlOrThrow(file: string, text: string): Record<string, unknown> {
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch {
    throw unparseable(file);
  }
  if (!isObject(parsed)) throw unparseable(file);
  return parsed;
}

/** True when the parsed config declares an `mcp_servers.northkeep` entry. */
function hasNorthkeepServer(parsed: Record<string, unknown>): boolean {
  const servers = isObject(parsed.mcp_servers) ? parsed.mcp_servers : undefined;
  return !!servers && SERVER_NAME in servers;
}

/**
 * Remove our canonical `[mcp_servers.northkeep]` table and any
 * `[mcp_servers.northkeep.<sub>]` subtables (e.g. `.env`) from the file TEXT,
 * leaving every other line — including other servers' tables, root keys, blank
 * lines, and comments — exactly as found. A single-bracket table header sets the
 * "current table" context; lines belong to it until the next header. We drop the
 * header and body of any table whose dotted path is `mcp_servers.northkeep` or a
 * child of it. Array-of-tables headers (`[[...]]`) and non-header lines never match.
 */
function stripNorthkeepTables(text: string): string {
  const headerRe = /^\s*\[\s*([^[\]]+?)\s*\]\s*(#.*)?$/;
  const arrayHeaderRe = /^\s*\[\[/;
  const kept: string[] = [];
  let inNorthkeep = false;
  for (const line of text.split('\n')) {
    if (arrayHeaderRe.test(line)) {
      inNorthkeep = false;
      kept.push(line);
      continue;
    }
    const m = headerRe.exec(line);
    if (m) {
      const dotted = m[1]!
        .split('.')
        .map((seg) => seg.trim().replace(/^["']|["']$/g, ''))
        .join('.');
      inNorthkeep = dotted === `mcp_servers.${SERVER_NAME}` || dotted.startsWith(`mcp_servers.${SERVER_NAME}.`);
      if (inNorthkeep) continue; // drop our header
      kept.push(line);
      continue;
    }
    if (inNorthkeep) continue; // drop our table body
    kept.push(line);
  }
  return kept.join('\n');
}

const tstr = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Render our table as canonical TOML text. */
function northkeepTomlBlock(command: string, args: string[], scopes: string[]): string {
  let block =
    `[mcp_servers.${SERVER_NAME}]\n` +
    `command = ${tstr(command)}\n` +
    `args = [${args.map(tstr).join(', ')}]\n`;
  if (scopes.length) {
    block += `\n[mcp_servers.${SERVER_NAME}.env]\nNORTHKEEP_SCOPES = ${tstr(scopes.join(','))}\n`;
  }
  return block;
}

/** Refusal used when northkeep is present but not as a canonical header table. */
function inlineFormRefusal(file: string): Error {
  return new Error(
    `Refusing to modify ${file}: a "mcp_servers.${SERVER_NAME}" entry is defined in an ` +
      `inline or dotted-key form NorthKeep does not rewrite. Remove that entry from your ` +
      `Codex config (it is the one named "${SERVER_NAME}"), then reconnect.`,
  );
}

/** Re-parse text we're about to write; throw if it broke or our strip left a
 * stray northkeep entry we can't account for. */
function reparseStripped(file: string, stripped: string): Record<string, unknown> {
  try {
    return parseTomlOrThrow(file, stripped);
  } catch {
    // Our strip produced invalid TOML from a file that originally parsed — do not
    // write. This only happens for pathological hand-written layouts; fail closed.
    throw new Error(
      `Refusing to modify ${file}: NorthKeep could not safely edit it. Remove the ` +
        `"mcp_servers.${SERVER_NAME}" entry manually, then reconnect.`,
    );
  }
}

/** Stable, key-sorted stringify so two parses compare equal regardless of object
 * key ordering. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** Snapshot of every `mcp_servers` entry EXCEPT our own — used to prove the text
 * strip touched nothing but `northkeep`. */
function otherServersSnapshot(parsed: Record<string, unknown>): string {
  const servers = isObject(parsed.mcp_servers) ? parsed.mcp_servers : {};
  const others: Record<string, unknown> = {};
  for (const k of Object.keys(servers)) if (k !== SERVER_NAME) others[k] = servers[k];
  return stableStringify(others);
}

/**
 * Restore the JSON writer's *structural* "touch ONLY our key" guarantee that a
 * line-level text strip can only approximate: assert every non-northkeep
 * `mcp_servers` entry is byte-identical before and after the strip. This closes
 * the one case where the strip's regex path-identity diverges from the TOML
 * parser's — a quoted, dotted sibling name like `[mcp_servers."northkeep.backup"]`,
 * which the parser reads as a SIBLING but the naive path-join would treat as our
 * child and delete (taking its `env` secrets with it). We refuse rather than
 * silently destroy another server's config.
 */
function assertOnlyOursTouched(
  file: string,
  origParsed: Record<string, unknown>,
  strippedParsed: Record<string, unknown>,
): void {
  if (otherServersSnapshot(origParsed) !== otherServersSnapshot(strippedParsed)) {
    throw new Error(
      `Refusing to modify ${file}: editing NorthKeep's entry would have changed another ` +
        `MCP server's configuration (this happens when another server's name begins with ` +
        `"${SERVER_NAME}."). Rename or remove that entry, then reconnect.`,
    );
  }
}

/** Atomic, mode-preserving TEXT writer (Codex config can hold other servers'
 * secrets, so new files get 0600 and existing files keep their mode). */
function writeText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = 0o600;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    /* new file — keep 0600 */
  }
  const tmp = `${file}.northkeep-tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
  }
}

export function chatgptStatus(configPathOverride?: string): ConnectStatus {
  const file = codexConfigPath(configPathOverride);
  let parsed: Record<string, unknown>;
  try {
    parsed = parseTomlOrThrow(file, readText(file));
  } catch {
    return { connected: false }; // status never throws; connect/disconnect still refuse loudly
  }
  const servers = isObject(parsed.mcp_servers) ? parsed.mcp_servers : undefined;
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
 * Register the bundled MCP server in Codex/ChatGPT's config.toml. Rewrites ONLY
 * our own table, preserving the rest of the file verbatim, and verifies the
 * result before writing (see the section header for the full procedure).
 */
export function connectChatgpt(
  opts: { scopes?: string[] } = {},
  configPathOverride?: string,
): ConnectResult {
  const file = codexConfigPath(configPathOverride);
  const text = readText(file);
  const origParsed = parseTomlOrThrow(file, text); // refuse an unparseable config before touching anything
  const { command, args } = resolveMcpCommand();
  const scopes = normalizeScopes(opts.scopes);

  const stripped = stripNorthkeepTables(text);
  const strippedParsed = reparseStripped(file, stripped);
  if (hasNorthkeepServer(strippedParsed)) throw inlineFormRefusal(file);
  assertOnlyOursTouched(file, origParsed, strippedParsed);

  const base = stripped.replace(/\s*$/, '');
  const finalText = (base === '' ? '' : `${base}\n\n`) + northkeepTomlBlock(command, args, scopes);

  // Verify OUR entry decodes to exactly what we intended before any write.
  const verify = parseTomlOrThrow(file, finalText);
  const vServers = isObject(verify.mcp_servers) ? verify.mcp_servers : {};
  const vEntry = isObject(vServers[SERVER_NAME]) ? vServers[SERVER_NAME] : undefined;
  const argsMatch =
    !!vEntry &&
    Array.isArray(vEntry.args) &&
    (vEntry.args as unknown[]).length === args.length &&
    (vEntry.args as unknown[]).every((a, i) => a === args[i]);
  if (!vEntry || vEntry.command !== command || !argsMatch) {
    throw new Error(`Internal error writing ${file}: NorthKeep entry verification failed; nothing was written.`);
  }
  if (scopes.length) {
    const vEnv = isObject(vEntry.env) ? vEntry.env : undefined;
    if (!vEnv || vEnv.NORTHKEEP_SCOPES !== scopes.join(',')) {
      throw new Error(`Internal error writing ${file}: scope verification failed; nothing was written.`);
    }
  }

  backupOnce(file);
  writeText(file, finalText);
  return { restartNeeded: true, command, args };
}

/** Remove ONLY our `[mcp_servers.northkeep]` table(s) from Codex/ChatGPT's
 * config, preserving everything else verbatim. Refuses an unparseable config or
 * an inline-form northkeep entry (never mangles). */
export function disconnectChatgpt(configPathOverride?: string): { removed: boolean } {
  const file = codexConfigPath(configPathOverride);
  if (!fs.existsSync(file)) return { removed: false };
  const text = readText(file);
  const origParsed = parseTomlOrThrow(file, text);
  if (!hasNorthkeepServer(origParsed)) return { removed: false };

  const stripped = stripNorthkeepTables(text);
  const strippedParsed = reparseStripped(file, stripped);
  if (hasNorthkeepServer(strippedParsed)) throw inlineFormRefusal(file);
  assertOnlyOursTouched(file, origParsed, strippedParsed);

  const base = stripped.replace(/\s*$/, '');
  backupOnce(file);
  writeText(file, base === '' ? '' : `${base}\n`);
  return { removed: true };
}

// ---------------------------------------------------------------------------
// Umbrella dispatch (each app's writer stays explicit above).
// ---------------------------------------------------------------------------

export function connect(
  target: ConnectTarget,
  opts: { scopes?: string[] } = {},
): ConnectResult {
  switch (target) {
    case 'claude-desktop':
      return connectClaudeDesktop(opts);
    case 'claude-code':
      return connectClaudeCode(opts);
    case 'chatgpt':
      return connectChatgpt(opts);
  }
}

export function disconnect(target: ConnectTarget): { removed: boolean } {
  switch (target) {
    case 'claude-desktop':
      return disconnectClaudeDesktop();
    case 'claude-code':
      return disconnectClaudeCode();
    case 'chatgpt':
      return disconnectChatgpt();
  }
}

export function connectStatus(target: ConnectTarget): ConnectStatus {
  switch (target) {
    case 'claude-desktop':
      return claudeDesktopStatus();
    case 'claude-code':
      return claudeCodeStatus();
    case 'chatgpt':
      return chatgptStatus();
  }
}
