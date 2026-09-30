/**
 * Cloud Connect orchestration (Phase B of phone-first onboarding): the pure
 * decision logic behind the Sharing screen's share / unshare / pair /
 * sync-now actions. NO React Native or Expo imports, so the state transitions
 * (including the rollback-on-failure invariants) are unit-tested under Node in
 * apps/mobile/test/connect-flow.test.ts, following the sync-flow /
 * sync-setup-flow pattern. The Cloud Connect screens (app/sharing/*, chiefly
 * app/sharing/scopes.tsx) wire the ports to SecureStore and to the VaultSession
 * connector methods and stay thin.
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
import {
  ConnectorStalePushError,
  holdMessage,
  LAPSED_UNSHARE_HINT,
  UNSHARE_FAILED_MESSAGE,
  UNSHARE_LOCAL_SAVE_FAILED_MESSAGE,
  type VaultStamp,
} from '@northkeep/sync';
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

/** Share add refused: this phone's vault file is not the copy the sync server holds (ADR 0063 D5). */
export const PHONE_NOT_IN_SYNC_MESSAGE =
  'This phone is not in sync with your other devices yet, so nothing was shared. Let sync finish, then share again.';

/** HTTP 428 on the phone: the connector holds a copy from a newer vault version. */
export const PHONE_STALE_PUSH_MESSAGE =
  'Another device pushed a newer copy to Cloud Connect. Let this phone finish syncing, then share again.';

/** Nothing was sent: this phone may not hold the newest vault. */
export class PhoneNotInSyncError extends Error {
  constructor() {
    super(PHONE_NOT_IN_SYNC_MESSAGE);
    this.name = 'PhoneNotInSyncError';
  }
}

/**
 * The push's `vault.server`: the first 16 hex of sha256 over the sync server
 * URL, normalized as the desktop's setSyncServer stores it. It must equal the
 * desktop's vaultServerHash for the same server, or the connector reads every
 * phone push as a different sync server and replaces the recorded order.
 */
export function vaultServerHashForPhone(syncServerUrl: string): string {
  const normalized = new URL(syncServerUrl).toString().replace(/\/$/, '');
  return bytesToHex(sha256(utf8ToBytes(normalized))).slice(0, 16);
}

/**
 * The stamp for a phone push (ADR 0063 D5). No sync server: no stamp, as on a
 * desktop with no vault sync. Otherwise the phone must hold exactly the bytes
 * the sync server reports. The phone never pushes its vault from here,
 * because its last-writer-wins push could displace a newer Mac vault.
 */
export function phoneVaultStamp(input: {
  syncServerUrl: string | null;
  status: { version: number; sha256: string } | null;
  localSha: string | null;
}): VaultStamp | undefined {
  if (input.syncServerUrl === null) return undefined;
  if (input.status === null || input.localSha === null || input.status.sha256 !== input.localSha) {
    throw new PhoneNotInSyncError();
  }
  return { server: vaultServerHashForPhone(input.syncServerUrl), version: input.status.version };
}

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
  return allowlistHashFromToken(connectorToken);
}

/**
 * sha256 hex of a derived token: the exact value BOTH server allowlists store
 * (`NORTHKEEP_SYNC_ALLOWED_TOKEN_HASHES`, `NORTHKEEP_CONNECTOR_ALLOWED_TOKEN_HASHES`)
 * and what `tokenHash` produces on desktop.
 *
 * Sync and Cloud Connect derive DIFFERENT tokens from the same device secret,
 * so a comped account needs a hash from each; they are not interchangeable. The
 * phone could previously produce only the connector one, which meant a
 * phone-only design partner could be given Cloud Connect but not sync, since
 * the Settings screen showed the account id and that is a different derivation
 * label the allowlist will never match.
 *
 * @noble/hashes rather than node:crypto: the mobile shim has no createHash. A
 * test proves byte-for-byte equality with node's sha256. Not a secret, just a
 * one-way hash the server already knows.
 */
export function allowlistHashFromToken(token: string): string {
  return bytesToHex(sha256(utf8ToBytes(token)));
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

/** The slug holdMessage wants, from the scope the fold reports. */
function heldSlug(scope: string): string {
  return scope.startsWith('project:') ? scope.slice('project:'.length) : scope;
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
  // The shared 428 text names Mac commands; the phone says what it can do.
  if (err instanceof ConnectorStalePushError) return { kind: 'failed', errorKind: 'other', message: PHONE_STALE_PUSH_MESSAGE };
  if (err instanceof PhoneNotInSyncError) return { kind: 'failed', errorKind: 'other', message: err.message };
  const friendly = classifySyncError(err);
  if (friendly.kind === 'subscription-required') {
    return {
      kind: 'failed',
      errorKind: friendly.kind,
      message: `${CONNECTOR_SUBSCRIPTION_MESSAGE} ${CONNECTOR_SUBSCRIPTION_HINT} ${LAPSED_UNSHARE_HINT}`,
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
  /** load() reads the marks; save() is the rollback: it saves the marks and pushes the vault as every edit does. */
  store: SharedScopeStore;
  /**
   * The phoneVaultStamp, read before anything is written. Throws
   * PhoneNotInSyncError when the phone does not hold exactly the sync
   * server's copy, so nothing is saved and nothing is sent.
   */
  stamp(): Promise<VaultStamp | undefined>;
  /** Save the marks on this phone only. The vault is pushed after Cloud Connect accepts. */
  markLocal(scopes: string[]): Promise<void>;
  /**
   * Push the REAL plaintext entries of ALL listed shared scopes ("make these
   * scopes match exactly") with the stamp read before the mark. Wired to
   * VaultSession.connectorPushScopes (@northkeep/sync pushSharedScopes over a
   * snapshot of the open vault, the device secret and the entitlement).
   */
  pushScopes(scopes: string[], stamp: VaultStamp | undefined): Promise<{ pushed: number }>;
  /** Carry the mark to the sync server: the normal push after a save. */
  syncVault(): Promise<void>;
}

/**
 * Share one scope, AFTER the screen's loud confirmation (ADR 0063 D5). The
 * phone must already hold exactly the sync server's copy: it never pushes its
 * vault first, because its last-writer-wins push could displace a newer Mac
 * vault and then be stamped as the newest. In sync, it marks the scope, pushes
 * every shared scope stamped with that copy's version, then pushes the vault.
 * A refused push rolls the mark back, so local state never claims a share the
 * server never accepted.
 */
export async function runShareScope(ports: ShareScopePorts, scope: string): Promise<ShareScopeOutcome> {
  const before = await ports.store.load();
  const wasShared = before.includes(scope);
  const next = [...new Set([...before, scope])].sort();
  let stamp: VaultStamp | undefined;
  try {
    stamp = await ports.stamp();
  } catch (err) {
    return classifyConnectorError(err);
  }
  await ports.markLocal(next);
  let pushed: number;
  try {
    ({ pushed } = await ports.pushScopes(next, stamp));
  } catch (err) {
    // Rollback: the server never accepted it. Remove ONLY this call's own
    // scope from a FRESH load; a blind save(before) would clobber any mark a
    // concurrent writer added while the push was in flight.
    //
    // NEVER roll back a scope that was already shared before this call (e.g.
    // marked on another device and arrived via vault sync while this screen's
    // state was stale): unmarking it here would sync "private" everywhere while
    // the connector still holds the rows from the earlier legitimate share —
    // no unshare DELETE ever ran. Same guard the web route has.
    if (!wasShared) {
      const current = await ports.store.load();
      await ports.store.save(current.filter((s) => s !== scope));
    }
    return classifyConnectorError(err);
  }
  // Cloud Connect holds the scope now, so a failed vault push must not undo
  // the mark; the next save or wake pushes it, and the sync line says why.
  try {
    await ports.syncVault();
  } catch {
    // Reported through the session's sync state.
  }
  return { kind: 'shared', scope, pushed };
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
    // ADR 0061: an unshare failure is never subscription copy; unshare is free.
    return { ...classifyConnectorError(err), message: UNSHARE_FAILED_MESSAGE };
  }
  try {
    const before = await ports.store.load();
    await ports.store.save(before.filter((s) => s !== scope));
  } catch {
    // The server already deleted; only the local mark failed to save.
    return { kind: 'failed', errorKind: 'other', message: UNSHARE_LOCAL_SAVE_FAILED_MESSAGE };
  }
  return { kind: 'unshared', scope, deleted };
}

/**
 * The text the Sharing screen shows for a failed unshare. Each failure
 * message already says whether the server copies remain, so nothing is
 * appended (ADR 0061 code recheck note 1: an appended "not removed" sentence
 * contradicted the local-save-failed case, where the server had deleted).
 */
export function unshareFailureText(outcome: ConnectorFailure): string {
  return outcome.message;
}

/** The down-sync counts every outcome carries, including the ADR 0050 holds. */
export interface ConnectorDownSyncCounts {
  added: number;
  forgotten: number;
  deduped: number;
  /** Rows left pending because their unshared project scope is not accepting them. */
  held: number;
  /** The unshared project scopes those rows are for. */
  held_scopes: string[];
  /** Rows dropped unapplied because their type is not one the vault stores. */
  skipped?: number;
}

export type ConnectorSyncOutcome =
  | ({ kind: 'synced'; newlyShared: string[] } & ConnectorDownSyncCounts)
  | { kind: 'nothing-shared'; message: string }
  | ConnectorFailure;

export interface ConnectorSyncPorts {
  store: SharedScopeStore;
  /**
   * Pull app-written memories into the OPEN vault and apply the additions
   * (wired to VaultSession.connectorDownSync, which also refreshes the entry
   * list and runs the normal push-after-save so the vault change syncs).
   */
  downSync(): Promise<ConnectorDownSyncCounts>;
  /**
   * Whether this phone has started a pairing (ADR 0050 Decision 5). An
   * unpaired phone has no account on that server and must not create one.
   */
  paired(): Promise<boolean>;
}

/**
 * "Sync app-written memories": apply the connector's additions to the vault.
 * The phone never pushes to Cloud Connect afterwards (ADR 0063 D1): the vault
 * change reaches the sync server, and a Mac that is in sync updates Cloud
 * Connect. Each acked row already carries its vault id.
 */
export async function runConnectorSyncNow(ports: ConnectorSyncPorts): Promise<ConnectorSyncOutcome> {
  const scopes = await ports.store.load();
  if (scopes.length === 0 && !(await ports.paired())) {
    return { kind: 'nothing-shared', message: NOTHING_SHARED_MESSAGE };
  }
  let down: ConnectorDownSyncCounts;
  try {
    down = await ports.downSync();
  } catch (err) {
    return classifyConnectorError(err);
  }
  // Scopes the fold marked Shared in this run (ADR 0050): the screen says so.
  const newlyShared = (await ports.store.load()).filter((s) => !scopes.includes(s));
  return { kind: 'synced', ...down, newlyShared };
}

/**
 * Whether "Sync app-written memories" may run: the same gate as
 * runConnectorSyncNow. A paired phone with nothing shared must be able to sync,
 * because that sync is how a project created in a connected app first arrives
 * (ADR 0050). A phone that never paired has no account there to ask.
 */
export function canSyncNow(state: { sharedCount: number; paired: boolean }): boolean {
  return state.sharedCount > 0 || state.paired;
}

export interface SyncOutcomeView {
  reloadShared(): Promise<string[]>;
  setSharedScopes(scopes: string[]): void;
  setSyncResult(text: string | null): void;
  setSyncError(failure: ConnectorFailure | null): void;
}

/**
 * What the Sharing screen shows after "Sync app-written memories". Any sync
 * that reached the server re-reads the shared list, because the fold can have
 * marked a newly arrived project Shared (ADR 0050).
 */
export async function applySyncOutcome(outcome: ConnectorSyncOutcome, view: SyncOutcomeView): Promise<void> {
  if (outcome.kind === 'synced') {
    view.setSharedScopes(await view.reloadShared());
    view.setSyncResult(connectorSyncSummary(outcome));
  } else if (outcome.kind === 'nothing-shared') {
    view.setSyncResult(outcome.message);
  } else {
    view.setSyncError(outcome);
  }
}

/** A project an AI app created arrived and the fold marked it Shared (ADR 0050). */
export function newlySharedMessage(scope: string): string {
  return `"${scope}" came from a connected app and is now marked Shared. Later edits to it are pushed; unshare it to stop.`;
}

/** Human summary of a completed sync-now, shown under the button. */
export function connectorSyncSummary(
  r: {
    added: number;
    forgotten: number;
    deduped: number;
    held_scopes?: readonly string[];
    skipped?: number;
    newlyShared?: readonly string[];
    /** ADR 0063: replacements and removals the phone leaves for the Mac. */
    deferred?: number;
    conflicts?: readonly unknown[];
  },
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
  // A held project is the whole point of a sync that landed nothing: say which
  // one, and what sharing it would do.
  for (const scope of r.newlyShared ?? []) parts.push(newlySharedMessage(scope));
  for (const scope of r.held_scopes ?? []) parts.push(holdMessage(heldSlug(scope)));
  const forMac = (r.deferred ?? 0) + (r.conflicts?.length ?? 0);
  if (forMac > 0) {
    parts.push(
      forMac === 1
        ? '1 change from your AI apps would replace or remove something here. Review on your Mac.'
        : `${forMac} changes from your AI apps would replace or remove something here. Review on your Mac.`,
    );
  }
  if ((r.skipped ?? 0) > 0) {
    parts.push(
      r.skipped === 1
        ? '1 memory was skipped: its type is not one NorthKeep stores.'
        : `${r.skipped} memories were skipped: their type is not one NorthKeep stores.`,
    );
  }
  return parts.join(' ');
}
