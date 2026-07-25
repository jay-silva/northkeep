import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Server identity for the MCP client (M11, ADR 0033 Decision 1).
 *
 * A server `id` is a USER-CHOSEN LABEL, not an identity: a label can point at a
 * different program tomorrow. So every grant is additionally bound to a LAUNCH
 * FINGERPRINT over the things the user's config controls — the fully-resolved
 * command path, the argument vector, the working directory, and the
 * names-and-values of any environment variables the config sets for this
 * server. If that fingerprint does not match at connect time, remembered grants
 * do not apply and every call asks again (fail closed, exactly like policy.ts).
 *
 * WHAT THIS DOES NOT DO, and the ADR says so in these words: it detects
 * CONFIGURATION changes, not PROGRAM changes. Replace the file at the
 * fingerprinted path and the fingerprint is identical. For the usual
 * `node server.js` shape the pinned thing is an interpreter plus a script whose
 * contents and imports can change freely. That is deliberate — solving it means
 * content-hashing a transitive dependency tree on every launch, which is both
 * expensive and defeated by any server that loads code at runtime. An MCP
 * server you install is a local program running with your privileges, exactly
 * like any other program you install, and no permission prompt substitutes for
 * ordinary software trust.
 */

/** Server ids are constrained so the `server__tool` namespace join stays
 * unambiguous (ADR 0033 Decision 2): without this, server `a__b` + tool `c`
 * collides with server `a` + tool `b__c`, and the namespace meant to PREVENT
 * shadowing becomes a way to achieve it. */
export const SERVER_ID_RE = /^[a-z0-9-]+$/;

export function isValidServerId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 64 && SERVER_ID_RE.test(id);
}

/** The namespaced name the MODEL sees. Assigned by us from the user's config,
 * never by the server, which is what makes shadowing impossible. */
export function namespacedName(serverId: string, tool: string): string {
  return `${serverId}__${tool}`;
}

/** Split a namespaced name back into its parts. Returns null when the name is
 * not one of ours — the loop must never guess a server from model-supplied text. */
export function splitNamespaced(name: string): { serverId: string; tool: string } | null {
  const i = name.indexOf('__');
  if (i <= 0) return null;
  const serverId = name.slice(0, i);
  const tool = name.slice(i + 2);
  if (!isValidServerId(serverId) || tool.length === 0) return null;
  return { serverId, tool };
}

/** What the fingerprint covers. Only fields the USER's config controls. */
export interface LaunchSpec {
  command: string;
  args: string[];
  cwd?: string;
  /** Environment variables the CONFIG sets for this server (not the ambient env). */
  env?: Record<string, string>;
}

/**
 * Recursively key-sorted JSON. A pin or fingerprint whose input ordering can
 * vary is not an identity at all, so every hash in this file goes through here.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

const sha256 = (text: string): string =>
  crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Resolve the command to an absolute, symlink-free path.
 *
 * PATH IS NEVER CONSULTED: the config must store an absolute path, so a
 * `PATH` entry cannot be used to swap the target between approval and launch.
 * Symlinks are resolved here AND again at launch, because a symlink is a
 * redirection — resolving once would let the link be re-pointed afterwards.
 * Throws (fail closed) rather than returning a best guess.
 */
export function resolveCommand(command: string): string {
  if (typeof command !== 'string' || command.length === 0) {
    throw new Error('An MCP server command is required.');
  }
  if (!path.isAbsolute(command)) {
    throw new Error(
      `An MCP server command must be an absolute path (got "${command}"). ` +
        'A bare name would be resolved through PATH at launch, which is exactly ' +
        'the swap the launch fingerprint exists to prevent.',
    );
  }
  let resolved: string;
  try {
    resolved = fs.realpathSync(command);
  } catch {
    throw new Error(`MCP server command not found or unreadable: ${command}`);
  }
  return resolved;
}

/**
 * The launch fingerprint. Covers the resolved command, the argument vector, the
 * working directory, and config-set environment. Argument PATHS are resolved
 * too where they exist on disk, so `node ./s.js` and `node /abs/s.js` are the
 * same launch and a re-pointed symlinked script is a different one.
 */
export function fingerprintLaunch(spec: LaunchSpec): string {
  const resolvedArgs = spec.args.map((a) => {
    if (!path.isAbsolute(a)) return a;
    try {
      return fs.realpathSync(a);
    } catch {
      return a; // not a path on disk (or gone) — hash it verbatim
    }
  });
  return sha256(
    canonicalJson({
      command: resolveCommand(spec.command),
      args: resolvedArgs,
      cwd: spec.cwd ?? null,
      env: spec.env ?? {},
    }),
  );
}

/** One advertised tool, reduced to the fields a pin must cover. */
export interface PinnableTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * The definitions pin (ADR 0033 Decision 2): sha256 over canonical JSON of the
 * FULL advertised tool list — every tool's name, description and inputSchema,
 * sorted by name.
 *
 * Names alone are deliberately NOT enough. A names-only pin re-opens exactly
 * the silent-redefinition attack the pin exists to stop: descriptions are read
 * by the model while it decides what to do, so a server that keeps its names
 * and rewrites its descriptions has changed what it can talk the model into.
 */
export function pinTools(tools: readonly PinnableTool[]): string {
  const reduced = [...tools]
    .map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? null,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sha256(canonicalJson(reduced));
}
