/**
 * Cloud Connect orchestration (Phase B of phone-first onboarding): the pure
 * decision logic behind the Sharing screen's share / unshare / pair /
 * sync-now actions. NO React Native or Expo imports, so the state transitions
 * (including the rollback-on-failure invariants) are unit-tested under Node in
 * apps/mobile/test/connect-flow.test.ts, following the sync-flow /
 * sync-setup-flow pattern. The screen (app/sharing.tsx) wires the ports to
 * SecureStore and to the VaultSession connector methods and stays thin.
 *
 * Invariant #1 lives here: sharing is per-scope, opt-in, and loudly confirmed
 * BY THE SCREEN before runShareScope is ever called; reaching these functions
 * means the user confirmed. What this module enforces is the honesty half:
 *  - share: mark locally, push, and ROLL THE MARK BACK if the push did not
 *    land, so a scope the server never accepted can't wear a phantom Shared
 *    badge (mirrors the desktop /api/share/add rollback).
 *  - unshare: delete server-side FIRST, and only then drop the local mark. If
 *    the server delete fails the scope stays marked Shared, because the
 *    server really does still hold the copies (mirrors /api/share/remove).
 *
 * App Store steering (WS4): every failure is folded through classifySyncError,
 * and the 402 state gets connector-specific NEUTRAL copy below. No price, no
 * link, no purchase verb, no em dashes, ever.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { classifySyncError, type SyncErrorKind } from './sync-errors';

/** The hosted production connector server (apps/connector-server on Vercel). */
export const DEFAULT_CONNECTOR_SERVER_URL = 'https://northkeep-connector-server.vercel.app';

/** POST /pair/start codes expire server-side after 600 seconds. */
export const PAIRING_CODE_TTL_SECONDS = 600;

/** Neutral connector 402 copy: states the requirement, sells nothing, links nowhere. */
export const CONNECTOR_SUBSCRIPTION_MESSAGE = 'Cloud Connect requires a NorthKeep subscription.';

/** Activation guidance for the 402 state. The beta path is the share id right on the screen. */
export const CONNECTOR_SUBSCRIPTION_HINT =
  'Already subscribed? Cloud Connect activates automatically once your subscription is active. ' +
  'During the beta, you can instead send your share id to support to get access.';

/** Connector transport failure (offline, DNS, timeout). Always retryable. */
export const CONNECTOR_NETWORK_MESSAGE =
  'Could not reach the connector server. Check your connection and try again.';

/** Sync-now refusal when nothing is shared (mirrors desktop /api/share/sync). */
export const NOTHING_SHARED_MESSAGE = 'No scopes are shared yet. Share a scope first.';

/**
 * Sync-now landed memories but every scope was unshared while it ran, so the
 * write-back push was skipped on purpose (re-pushing would re-upload plaintext
 * the user just revoked). Honest, plain, no em dashes.
 */
export const SYNC_PUSH_SKIPPED_ALL_UNSHARED_MESSAGE =
  'Nothing was pushed back: every scope was unshared while the sync ran.';

/**
 * Shown with the push failure after a partially successful sync-now: the
 * down-synced memories are already saved locally, only the re-push failed.
 */
export const SYNC_PUSH_FAILED_FOLLOWUP =
  'The new memories are safe in your vault, but pushing your shared scopes back failed. Run sync again to retry the push.';

/** Connector-path 403: same private-beta state as sync, with the right noun. */
export const CONNECTOR_PRIVATE_BETA_MESSAGE =
  "This connector server is in private beta. Your account isn't enabled yet.";

/**
 * The "share id" a beta user sends to support: sha256 hex of the connector
 * token, the SAME value the server's allowlist stores (tokenHash in
 * @northkeep/sync creds.ts) and the desktop CLI prints for `northkeep share
 * id`. Computed with @noble/hashes because the node:crypto shim on mobile has
 * no createHash; the test proves byte-for-byte equality with node's sha256.
 * Not a secret: it is a one-way hash the server already knows.
 */
export function shareIdFromConnectorToken(connectorToken: string): string {
  return bytesToHex(sha256(utf8ToBytes(connectorToken)));
}

/** The URL the user pastes into an AI app to add the connector: server + /mcp (desktop mcpUrl). */
export function mcpUrlFor(server: string): string {
  return server.replace(/\/$/, '') + '/mcp';
}

/** "m:ss" countdown text for the pairing-code expiry. Clamps at 0:00. */
export function formatPairingCountdown(secondsLeft: number): string {
  const s = Math.max(0, Math.floor(secondsLeft));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** One row of the Sharing screen's scope list. */
export interface ScopeRow {
  scope: string;
  /** Live memories currently in the scope (0 for a shared scope emptied of its last memory). */
  count: number;
  shared: boolean;
}

/**
 * The scope list to render: the union of the scopes the vault actually holds
 * (from the session's live entries) and the configured shared list, sorted. A
 * shared scope with no remaining entries still needs a row so the user can
 * turn it off (same union the desktop GUI renders).
 */
export function scopeRows(
  entries: ReadonlyArray<{ scope: string }>,
  sharedScopes: readonly string[],
): ScopeRow[] {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.scope, (counts.get(e.scope) ?? 0) + 1);
  const shared = new Set(sharedScopes);
  const all = [...new Set([...counts.keys(), ...shared])].sort();
  return all.map((scope) => ({ scope, count: counts.get(scope) ?? 0, shared: shared.has(scope) }));
}

/** A classified, display-ready connector failure. */
export interface ConnectorFailure {
  kind: 'failed';
  errorKind: SyncErrorKind;
  /** Safe to show verbatim (neutral 402 copy, connector-flavored network copy). */
  message: string;
}

/**
 * Fold any connector-client error into screen-safe copy. 402 gets the neutral
 * subscription state (steering rules); network gets connector wording instead
 * of the sync-flavored default; everything else passes through classified.
 */
export function classifyConnectorError(err: unknown): ConnectorFailure {
  const friendly = classifySyncError(err);
  if (friendly.kind === 'subscription-required') {
    return {
      kind: 'failed',
      errorKind: friendly.kind,
      message: `${CONNECTOR_SUBSCRIPTION_MESSAGE} ${CONNECTOR_SUBSCRIPTION_HINT}`,
    };
  }
  if (friendly.kind === 'network') {
    return { kind: 'failed', errorKind: friendly.kind, message: CONNECTOR_NETWORK_MESSAGE };
  }
  if (friendly.kind === 'not-enabled') {
    // The sync-flavored PRIVATE_BETA_MESSAGE says "sync server"; on the
    // connector path that noun is wrong, so use the connector wording.
    return { kind: 'failed', errorKind: friendly.kind, message: CONNECTOR_PRIVATE_BETA_MESSAGE };
  }
  return { kind: 'failed', errorKind: friendly.kind, message: friendly.message };
}

/** Where the shared-scope list persists (SecureStore on the device; a Map in tests). */
export interface SharedScopeStore {
  load(): Promise<string[]>;
  save(scopes: string[]): Promise<void>;
}

export type ShareScopeOutcome =
  | { kind: 'shared'; scope: string; pushed: number }
  | ConnectorFailure;

export interface ShareScopePorts {
  store: SharedScopeStore;
  /**
   * Push the REAL plaintext entries of ALL listed shared scopes ("make these
   * scopes match exactly"). Wired to VaultSession.connectorPushScopes, which
   * calls @northkeep/sync pushSharedScopes with the open vault, the device
   * secret, and the best-effort entitlement. Throws on any refusal.
   */
  pushScopes(scopes: string[]): Promise<{ pushed: number }>;
}

/**
 * Share one scope, AFTER the screen's loud confirmation: persist the mark,
 * push every shared scope (the server reconciles the full list), and roll the
 * mark back if the push did not land, so local state never claims a share the
 * server never accepted.
 */
export async function runShareScope(ports: ShareScopePorts, scope: string): Promise<ShareScopeOutcome> {
  const before = await ports.store.load();
  const next = [...new Set([...before, scope])].sort();
  await ports.store.save(next);
  try {
    const { pushed } = await ports.pushScopes(next);
    return { kind: 'shared', scope, pushed };
  } catch (err) {
    // Rollback: the server never accepted it. Remove ONLY this call's own
    // scope from a FRESH load; a blind save(before) would clobber any mark a
    // concurrent writer added while the push was in flight.
    const current = await ports.store.load();
    await ports.store.save(current.filter((s) => s !== scope));
    return classifyConnectorError(err);
  }
}

export type UnshareScopeOutcome =
  | { kind: 'unshared'; scope: string; deleted: number }
  | ConnectorFailure;

export interface UnshareScopePorts {
  store: SharedScopeStore;
  /** Server-side DELETE of the scope's rows (wired to @northkeep/sync unshareScope). */
  unshare(scope: string): Promise<{ deleted: number }>;
}

/**
 * Unshare: delete server-side FIRST, then drop the local mark. On failure the
 * mark is left in place, because the server really does still hold the copies;
 * the screen says so instead of lying about server state.
 */
export async function runUnshareScope(
  ports: UnshareScopePorts,
  scope: string,
): Promise<UnshareScopeOutcome> {
  let deleted: number;
  try {
    ({ deleted } = await ports.unshare(scope));
  } catch (err) {
    return classifyConnectorError(err);
  }
  const before = await ports.store.load();
  await ports.store.save(before.filter((s) => s !== scope));
  return { kind: 'unshared', scope, deleted };
}

export type ConnectorSyncOutcome =
  | { kind: 'synced'; added: number; forgotten: number; deduped: number; pushed: number }
  | {
      /**
       * The down-sync landed, but every scope was unshared while it ran, so the
       * write-back push was skipped (pushing the stale list would re-upload
       * plaintext the user just revoked). The screen reports the skip honestly.
       */
      kind: 'synced-no-push';
      added: number;
      forgotten: number;
      deduped: number;
    }
  | {
      /**
       * The down-sync landed its memories in the vault, then the write-back
       * push failed. Split outcome so the screen can say BOTH halves: the
       * memories arrived AND the re-push failed (suggest running sync again).
       */
      kind: 'partially-synced';
      added: number;
      forgotten: number;
      deduped: number;
      pushFailure: ConnectorFailure;
    }
  | { kind: 'nothing-shared'; message: string }
  | ConnectorFailure;

export interface ConnectorSyncPorts {
  store: SharedScopeStore;
  /**
   * Pull app-written memories/forgets into the OPEN vault and apply them
   * (wired to VaultSession.connectorDownSync, which also refreshes the entry
   * list and runs the normal push-after-save so the vault change syncs).
   */
  downSync(): Promise<{ added: number; forgotten: number; deduped: number }>;
  /** The write-back re-push so the server's rows match the just-updated vault. */
  pushScopes(scopes: string[]): Promise<{ pushed: number }>;
}

/**
 * "Sync app-written memories", mirroring desktop /api/share/sync: down-sync
 * the connector-born memories into the vault, then re-push every shared scope
 * so each new row is rehashed server-side under its vault id.
 *
 * The write-back push RE-LOADS the store immediately before pushing, and
 * pushes only the scopes still marked shared at that moment. The down-sync is
 * slow, and an unshare that completes while it runs must not have its scope's
 * plaintext re-uploaded by a push of the stale pre-sync list. If the fresh
 * list is empty, the push is skipped entirely and reported honestly.
 */
export async function runConnectorSyncNow(ports: ConnectorSyncPorts): Promise<ConnectorSyncOutcome> {
  const scopes = await ports.store.load();
  if (scopes.length === 0) return { kind: 'nothing-shared', message: NOTHING_SHARED_MESSAGE };
  let down: { added: number; forgotten: number; deduped: number };
  try {
    down = await ports.downSync();
  } catch (err) {
    return classifyConnectorError(err);
  }
  // Fresh list, not the one loaded before the slow down-sync: only scopes the
  // user STILL shares may be pushed (revocation honesty; see the doc above).
  const fresh = await ports.store.load();
  if (fresh.length === 0) return { kind: 'synced-no-push', ...down };
  try {
    const { pushed } = await ports.pushScopes(fresh);
    return { kind: 'synced', ...down, pushed };
  } catch (err) {
    // The memories already landed in the vault; only the re-push failed. Keep
    // both halves visible instead of hiding the successful down-sync.
    return { kind: 'partially-synced', ...down, pushFailure: classifyConnectorError(err) };
  }
}

/**
 * Human summary of a completed sync-now, shown under the button. Pass
 * `pushedBack: false` for the partially-synced and synced-no-push outcomes,
 * where the closing "pushed back" sentence would be a lie.
 */
export function connectorSyncSummary(
  r: {
    added: number;
    forgotten: number;
    deduped: number;
  },
  opts?: { pushedBack?: boolean },
): string {
  const memories = (n: number) => (n === 1 ? '1 new memory' : `${n} new memories`);
  const parts: string[] = [];
  parts.push(
    r.added === 0
      ? 'No new memories from your AI apps.'
      : `${memories(r.added)} from your AI apps came into your vault.`,
  );
  if (r.forgotten > 0) {
    parts.push(r.forgotten === 1 ? '1 forget was applied.' : `${r.forgotten} forgets were applied.`);
  }
  if (r.deduped > 0) {
    parts.push(
      r.deduped === 1 ? '1 was already in your vault.' : `${r.deduped} were already in your vault.`,
    );
  }
  if (opts?.pushedBack !== false) {
    parts.push('Your shared scopes were pushed back so the server matches your vault.');
  }
  return parts.join(' ');
}
