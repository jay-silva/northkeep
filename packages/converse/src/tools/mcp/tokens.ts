import { execFileSync } from 'node:child_process';
import { keychainAvailable } from '@northkeep/mcp-server';

/**
 * OAuth credential storage for remote MCP servers (ADR 0035 Decision 8).
 *
 * Everything secret about a remote server lives HERE, in the macOS Keychain,
 * and nothing secret lives in `mcp.json`. That split is the whole point: the
 * config file is readable, diffable, and safe to show in a support thread; the
 * refresh token that can read someone's mail is not.
 *
 * ONE Keychain item per server, holding a single JSON record, rather than one
 * item per field. A token refresh rotates the refresh token and the access
 * token together, and the client secret must not outlive them — writing them as
 * one value makes that atomic instead of three writes that can half-fail.
 *
 * NO FILE FALLBACK, deliberately. ADR 0035 records that the env-var escape
 * hatch used for provider API keys does not work here, because refresh tokens
 * rotate and an env var cannot be written back. So on a machine without a
 * Keychain there is no store, and `connect` refuses rather than degrading to
 * tokens on disk. Tests inject a backend instead (`setTokenBackend`), which
 * keeps the production path free of any "if testing, write a file" branch.
 */

const SERVICE = 'northkeep-mcp-oauth';

/** What we hold for one remote server. Shapes mirror the MCP SDK's own. */
export interface RemoteCredentials {
  /**
   * The origin these credentials were issued for. Stored WITH the tokens, not
   * only in mcp.json, so that editing the URL in the config cannot silently
   * repoint a live grant at a different host (ADR 0035 Decision 6). The connect
   * path compares the two and treats a mismatch as "not connected".
   */
  origin: string;
  tokens?: {
    access_token: string;
    token_type: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
    /** Absolute ms epoch we computed at save time from expires_in. */
    obtained_at?: number;
  };
  /**
   * Client id and secret. Present for both pre-registered clients (the primary
   * path — Google requires it) and for dynamically registered ones. The id is
   * ALSO in mcp.json so the config alone shows what the server is bound to; the
   * secret is only ever here.
   */
  client?: {
    client_id: string;
    client_secret?: string;
    client_secret_expires_at?: number;
  };
  /** PKCE verifier, alive only between redirect and callback. */
  codeVerifier?: string;
}

export interface TokenBackend {
  get(id: string): string | null;
  set(id: string, value: string): void;
  delete(id: string): void;
  available(): boolean;
}

const keychainBackend: TokenBackend = {
  available: () => keychainAvailable(),
  get(id) {
    try {
      const out = execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', id, '-w'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 4 * 1024 * 1024,
      }).trim();
      return out.length > 0 ? out : null;
    } catch {
      return null; // absent, or the keychain is locked/denied
    }
  },
  set(id, value) {
    // `security -i` reads the command from stdin, so the token never appears on
    // a command line where `ps` could read it (same pattern as the master key).
    execFileSync('security', ['-i'], {
      input: `add-generic-password -U -s ${SERVICE} -a ${id} -w ${quote(value)}\n`,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
  },
  delete(id) {
    try {
      execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', id], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch {
      // not present — fine
    }
  },
};

let backend: TokenBackend = keychainBackend;

/** Tests only. Returns a restore function. */
export function setTokenBackend(next: TokenBackend): () => void {
  const previous = backend;
  backend = next;
  return () => {
    backend = previous;
  };
}

export function tokenStoreAvailable(): boolean {
  return backend.available();
}

export function loadCredentials(id: string): RemoteCredentials | null {
  const raw = backend.get(id);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // an unreadable record is no record — the user reconnects
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const rec = parsed as RemoteCredentials;
  return typeof rec.origin === 'string' ? rec : null;
}

export function saveCredentials(id: string, credentials: RemoteCredentials): void {
  if (!backend.available()) {
    throw new Error(
      'No Keychain is available on this system, and NorthKeep will not write OAuth tokens to a file. Remote MCP servers need macOS.',
    );
  }
  backend.set(id, JSON.stringify(credentials));
}

/**
 * Read-modify-write under a process-wide lock.
 *
 * ADR 0035 Decision 8 flags refresh races: two surfaces refreshing one grant can
 * write a stale refresh token over a rotated one and destroy it. This serializes
 * writers WITHIN a process. It does NOT serialize across processes — the CLI and
 * the GUI server refreshing the same grant at the same instant can still race.
 * That limit is real and is recorded in KNOWN-LIMITS rather than papered over
 * with a lock file whose stale-lock recovery would be its own failure mode.
 */
const chains = new Map<string, Promise<unknown>>();
export function updateCredentials(
  id: string,
  mutate: (current: RemoteCredentials | null) => RemoteCredentials,
): Promise<RemoteCredentials> {
  const previous = chains.get(id) ?? Promise.resolve();
  const next = previous.then(() => {
    const updated = mutate(loadCredentials(id));
    saveCredentials(id, updated);
    return updated;
  });
  // Keep the chain alive on failure so one error does not wedge the queue for
  // this server. The map is bounded by the number of configured servers, so it
  // is never pruned — an earlier version had a no-op "cleanup" here with a
  // comment claiming it bounded the map, which is exactly the kind of false
  // claim about a property that this repo keeps getting wrong.
  chains.set(
    id,
    next.catch(() => undefined),
  );
  return next;
}

export function deleteCredentials(id: string): void {
  backend.delete(id);
}

/**
 * Has this server completed a sign-in? ADR 0035 Decision 7: a remote server
 * contributes NOTHING — not even a tool listing — until this is true, because
 * `inspect` on an unconnected server would otherwise be a primitive for putting
 * an attacker-chosen server's tool descriptions in front of the model.
 */
export function hasRemoteTokens(id: string): boolean {
  const rec = loadCredentials(id);
  return rec?.tokens?.access_token !== undefined && rec.tokens.access_token.length > 0;
}

/** True when the stored grant was issued for a different origin than configured. */
export function credentialsOriginMatches(id: string, origin: string): boolean {
  const rec = loadCredentials(id);
  return rec !== null && rec.origin === origin;
}

/** Quote a value for the `security -i` stdin mini-shell. */
function quote(value: string): string {
  return `"${value.replace(/(["\\])/g, '\\$1')}"`;
}
