import fs from 'node:fs';
import path from 'node:path';
import { northkeepHome } from '@northkeep/core';
import type { PermissionGate, PermissionRequest } from './gate.js';
import { isValidServerId } from './mcp/identity.js';

/**
 * The ADR-0029 permission engine (M10c). Replaces placeholderGate ("every
 * call asks") with remembered per-(tool, host) decisions, while keeping the
 * placeholder's fail-closed spirit: anything this engine does not positively
 * recognize as an allow decision ASKS. A grant here can only ever remove a
 * prompt the user has already answered for the same tool and the same exact
 * host — it can never widen what a tool may do.
 *
 * Storage: ~/.northkeep/permissions.json, same file idiom as tools.json
 * (registry.ts) and routing.json (route.ts): version field, 0600 writes,
 * tolerant loader, strict writer. Grants are settings — no secrets, no
 * content — but they ARE security policy, so the tolerant loader fails
 * CLOSED: a grant it cannot fully validate simply does not exist, and a
 * missing grant means "ask", which always puts a human back in the loop.
 *
 * Host matching is EXACT (case-insensitive), no wildcards, no subdomain
 * inheritance: a grant for example.com does NOT cover api.example.com.
 * Subdomain trust is not transitive (api.example.com may be run by a
 * different team, a different vendor, or an attacker squatting a dangling
 * CNAME), and a wildcard grant is exactly the kind of quiet blanket
 * permission this product refuses (invariant #1: sharing is explicit,
 * per-thing, loudly confirmed).
 */

export type GrantScope = 'always' | 'never';

/**
 * WHAT a grant is remembered against (M11, ADR 0033 Decision 1).
 *
 * Web tools key on a HOST. MCP tools have no host at all — a stdio server is a
 * local process — so they key on the SERVER id, and the grant is only honored
 * while that server's launch fingerprint still matches (checked at connect, in
 * mcp/client.ts). Modelling this as a discriminated subject rather than
 * smuggling `mcp:vault` into the `host` field keeps permissions.json readable
 * as what it is: a file the owner of this vault should be able to audit by eye.
 */
export type GrantSubject = { host: string } | { server: string };

export const hostSubject = (host: string): GrantSubject => ({ host });
export const serverSubject = (server: string): GrantSubject => ({ server });

/** Defensive on purpose: `record` reaches this through a STRUCTURAL type in the
 * loop (task.ts deliberately does not import policy.ts — ADR 0029 Decision 1),
 * so a caller could hand us something that is not a subject at all. A bare
 * `'server' in s` throws on a string, and a throw inside the permission path is
 * the one failure mode this file must never have. */
export const isServerSubject = (s: GrantSubject): s is { server: string } =>
  typeof s === 'object' && s !== null && 'server' in s;

/** Human label for a subject, used by the CLI and the audit surface. */
export const subjectLabel = (s: GrantSubject): string =>
  isServerSubject(s) ? `mcp server "${s.server}"` : s.host;

export interface PermissionGrant {
  tool: string;
  /** Exactly one of `host` / `server` is present — see GrantSubject. */
  host?: string;
  server?: string;
  scope: GrantScope;
  createdAt: string;
}

/** The subject a stored grant refers to, or null if the record is malformed. */
export function grantSubject(g: PermissionGrant): GrantSubject | null {
  if (typeof g.host === 'string' && g.host.length > 0) return { host: g.host };
  if (typeof g.server === 'string' && g.server.length > 0) return { server: g.server };
  return null;
}

export interface PermissionsConfig {
  version: 1;
  grants: PermissionGrant[];
}

export function permissionsPath(): string {
  return path.join(northkeepHome(), 'permissions.json');
}

const EMPTY: PermissionsConfig = { version: 1, grants: [] };

const GRANT_SCOPES: ReadonlySet<string> = new Set(['always', 'never']);

/**
 * One (tool, subject) key. Hosts compare case-insensitively (DNS is); server
 * ids are already lowercase-constrained by identity.ts. An explicit
 * discriminator keeps the namespaces apart, so an MCP server that a user named
 * `example.com` can never match a host grant for example.com.
 *
 * Computed from stored fields at read time and never itself stored, so
 * changing its format needs no migration of existing grants.
 */
const grantKey = (tool: string, subject: GrantSubject): string =>
  isServerSubject(subject)
    ? `${tool}\u0000server\u0000${subject.server}`
    : `${tool}\u0000host\u0000${subject.host.toLowerCase()}`;


/**
 * Per-entry validation for the tolerant loader. Unknown scopes ('session'
 * must never appear in the file — see record()), wrong types, and empty
 * strings all make the entry not-a-grant. Fail closed: no grant → ask.
 */
function isGrant(entry: unknown): entry is PermissionGrant {
  if (entry === null || typeof entry !== 'object') return false;
  const g = entry as Record<string, unknown>;
  const hasHost = typeof g.host === 'string' && g.host.length > 0;
  const hasServer = typeof g.server === 'string' && g.server.length > 0;
  // EXACTLY one subject. A record carrying both is ambiguous about what was
  // actually approved, and an ambiguous grant must not be honored at all.
  if (hasHost === hasServer) return false;
  if (hasServer && !isValidServerId(g.server)) return false;
  return (
    typeof g.tool === 'string' &&
    g.tool.length > 0 &&
    typeof g.scope === 'string' &&
    GRANT_SCOPES.has(g.scope) &&
    typeof g.createdAt === 'string'
  );
}

export function loadPermissions(): PermissionsConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(permissionsPath(), 'utf8')) as unknown;
  } catch {
    return structuredClone(EMPTY); // missing or corrupt file → no grants
  }
  if (parsed === null || typeof parsed !== 'object') return structuredClone(EMPTY);
  const raw = parsed as Record<string, unknown>;
  // A version we did not write is a format we do not understand; honoring a
  // guess about someone else's schema is how a "never" grant gets misread.
  // Dropping everything is safe here: no grant means ask, never allow.
  if (raw.version !== 1) return structuredClone(EMPTY);
  if (!Array.isArray(raw.grants)) return structuredClone(EMPTY);
  const grants: PermissionGrant[] = [];
  const seen = new Set<string>();
  // Last entry wins per (tool, host): the strict writer upserts, so
  // duplicates only occur in a hand-edited file, where the later line is
  // the later decision. Hosts normalize to lowercase on the way in.
  for (const entry of raw.grants) {
    if (!isGrant(entry)) continue; // tolerant read: bad entry = no grant
    const subject = grantSubject(entry);
    if (subject === null) continue;
    const key = grantKey(entry.tool, subject);
    if (seen.has(key)) {
      const idx = grants.findIndex((g) => {
        const s = grantSubject(g);
        return s !== null && grantKey(g.tool, s) === key;
      });
      grants.splice(idx, 1);
    }
    seen.add(key);
    grants.push({
      tool: entry.tool,
      ...(isServerSubject(subject)
        ? { server: subject.server }
        : { host: subject.host.toLowerCase() }),
      scope: entry.scope,
      createdAt: entry.createdAt,
    });
  }
  return { version: 1, grants };
}

function savePermissions(config: PermissionsConfig): void {
  const file = permissionsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync's `mode` applies only when it CREATES the file; a
  // pre-existing permissions.json (older version, a loose umask, or an
  // attacker pre-creating it world-readable) would keep its old perms
  // (G1 review). chmod every write so 0600 is guaranteed, not incidental.
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best-effort: a filesystem without POSIX perms (some mounts) is not a
    // reason to fail the write; the grants file holds no secrets, only policy.
  }
}

export function listGrants(): PermissionGrant[] {
  return loadPermissions().grants;
}

/** Upsert on the (tool, subject) key — one remembered decision per pair. */
export function addGrant(tool: string, subject: GrantSubject, scope: GrantScope): void {
  const key = grantKey(tool, subject);
  const config = loadPermissions();
  config.grants = config.grants.filter((g) => {
    const s = grantSubject(g);
    return s === null || grantKey(g.tool, s) !== key;
  });
  config.grants.push({
    tool,
    ...(isServerSubject(subject)
      ? { server: subject.server }
      : { host: subject.host.toLowerCase() }),
    scope,
    createdAt: new Date().toISOString(),
  });
  savePermissions(config);
}

/** Remove one grant. True if something was actually removed. */
export function removeGrant(tool: string, subject: GrantSubject): boolean {
  const key = grantKey(tool, subject);
  const config = loadPermissions();
  const before = config.grants.length;
  config.grants = config.grants.filter((g) => {
    const s = grantSubject(g);
    return s === null || grantKey(g.tool, s) !== key;
  });
  if (config.grants.length === before) return false;
  savePermissions(config);
  return true;
}

/** Remove every grant. Returns how many were removed. */
export function clearGrants(): number {
  const config = loadPermissions();
  const removed = config.grants.length;
  savePermissions({ version: 1, grants: [] });
  return removed;
}

export interface PermissionEngine extends PermissionGate {
  /** Record a user decision's scope. 'session' lives in this engine instance only. */
  record(tool: string, subject: GrantSubject, scope: 'session' | 'always' | 'never'): void;
}

/**
 * The engine. `persist: false` (the DEFAULT) never touches the filesystem —
 * a library call must not write config files as a side effect; only a
 * surface that explicitly opts in (the CLI approval prompt) persists. In a
 * non-persisting engine, 'always' and 'never' recordings live in-process
 * only, which deliberately degrades 'always' to session semantics on
 * restart: forgetting a convenience is safe, silently persisting one is not.
 *
 * evaluate() decision order — the order IS the security argument:
 *
 *   1. 'never' grant for (tool, host)        → deny        (a standing "no"
 *      outranks everything, including a session "yes" given later; the user
 *      un-says "never" explicitly, via `northkeep tools revoke`, not by
 *      accident mid-conversation)
 *   2. risk === 'consequential'              → ask         (state-changing
 *      calls NEVER auto-allow in v1, grants notwithstanding — a remembered
 *      "yes" to reading a site must not become a remembered "yes" to
 *      changing something)
 *   3. screened === true                     → ask         (the loop's
 *      exfiltration screens flagged this call; a screened call must reach
 *      human eyes — the whole point of the screen is a human looking at the
 *      exact arguments, and a grant must not bypass it)
 *   4. session grant or persisted 'always'   → auto-allow  (the only allow
 *      path: the user answered this exact (tool, host) question before)
 *   5. otherwise                             → ask         (fail closed,
 *      invariant #6: the unknown case is a prompt, never a pass)
 *
 * No-egress calls (toolEgress === null) have no host, so steps 1 and 4
 * cannot match — they always ask in v1.
 *
 * SECURITY REQUIREMENT — one engine instance per CONVERSATION. `sessionAllows`
 * (and `memGrants` under persist:false) are keyed on (tool, host) only, with no
 * conversation identity, because a "this session" grant is DEFINED as lasting
 * this conversation. The CLI honors this (one engine per REPL process). A
 * surface that serves multiple conversations (M10e's web GUI) MUST create a
 * fresh engine per conversation, or a "this session" yes in conversation A
 * would auto-allow in conversation B (G1 review). Do not share one engine
 * across conversations.
 */
export function createPermissionEngine(options?: { persist?: boolean }): PermissionEngine {
  const persist = options?.persist === true;
  /** 'session' allows for this engine instance. Never written anywhere. */
  const sessionAllows = new Set<string>();
  /** 'always'/'never' recordings when persist:false — in-process only. */
  const memGrants = new Map<string, GrantScope>();

  const persistedScope = (key: string): GrantScope | undefined => {
    if (!persist) return undefined; // persist:false never reads the file
    // Re-read per evaluation, never cached: `northkeep tools revoke` must
    // take effect immediately (consent is reversible — invariant #1), and a
    // stale cache honoring a revoked grant would be a silent allow.
    return loadPermissions().grants.find((g) => {
      const s = grantSubject(g);
      return s !== null && grantKey(g.tool, s) === key;
    })?.scope;
  };

  return {
    record(tool, subject, scope): void {
      const key = grantKey(tool, subject);
      if (scope === 'session') {
        // Session scope is defined as this-instance-only; it must never be
        // persisted regardless of the persist option.
        sessionAllows.add(key);
        return;
      }
      if (persist) addGrant(tool, subject, scope);
      else memGrants.set(key, scope);
    },

    evaluate(req: PermissionRequest): Promise<'auto-allow' | 'ask' | 'deny'> {
      // An MCP call names its SERVER; a web call names its host. Neither is
      // model-supplied: the loop derives both from our own config (ADR 0033
      // Decision 1), so a model cannot talk its way onto someone else's grant.
      const subject: GrantSubject | null =
        req.server !== undefined
          ? { server: req.server }
          : req.toolEgress?.host !== undefined
            ? { host: req.toolEgress.host }
            : null;
      if (subject === null) return Promise.resolve('ask'); // no subject → no grant can match
      const key = grantKey(req.tool, subject);
      const remembered = persistedScope(key) ?? memGrants.get(key);

      if (remembered === 'never') return Promise.resolve('deny'); // step 1
      if (req.risk === 'consequential') return Promise.resolve('ask'); // step 2
      if (req.screened === true) return Promise.resolve('ask'); // step 3
      if (sessionAllows.has(key) || remembered === 'always') {
        return Promise.resolve('auto-allow'); // step 4
      }
      return Promise.resolve('ask'); // step 5
    },
  };
}
