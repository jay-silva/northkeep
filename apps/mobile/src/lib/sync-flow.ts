/**
 * The mobile sync-state machine and the pure conflict/base-version decision
 * logic for M6-2 (edit + full two-way sync). This module is deliberately pure
 * TypeScript with NO React Native, Expo, or @northkeep imports, so it runs
 * unmodified under Node in the repo's Vitest suite
 * (apps/mobile/test/sync-flow.test.ts). The screen-facing indicator and the
 * transport orchestration in vault-session.tsx are built ON TOP of these
 * functions; keeping the decision rules here is what lets us actually TEST the
 * conflict resolution without a device or a server.
 *
 * Conflict policy (matches 07-MOBILE-LAUNCH-PLAN.md M6-2 acceptance:
 * "forced two-sided conflict -> last-writer-wins with recoverable .bak"):
 *
 *   The phone is the LAST writer, so on a two-sided conflict the phone's edit
 *   WINS. The mechanism, driven by these predicates and executed in
 *   vault-session.tsx, is:
 *     1. push(localBytes, base = lastKnownVersion)
 *     2. HTTP 409  => the server moved on. Fetch the remote blob, run the same
 *        structural + transport-hash + verify-opens-with-key safety checks the
 *        desktop pull uses, and stash that VERIFIED remote as `${vault}.bak`
 *        (the displaced other-device version stays recoverable). The live vault
 *        is NEVER overwritten.
 *     3. push(localBytes, base = serverVersionFrom409). The server now holds the
 *        phone's edit; the displaced remote is recoverable in .bak.
 *
 *   This intentionally differs from the desktop CLI, which on 409 tells the
 *   user to `pull` (remote wins locally, local edit -> .bak) then `push`. That
 *   is first-writer-wins. The plan asks the phone to AUTOMATE a
 *   last-writer-wins policy instead; the asymmetry is inherent to automating a
 *   decision the desktop punts to the human. Either way no data is lost: one
 *   version is live, the other is in a recoverable .bak, and the pushed blob is
 *   always a chain-valid vault so `northkeep verify` passes on the Mac after.
 */

import type { SyncErrorKind } from './sync-errors';

export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'conflict-recovered' | 'error';

export interface SyncState {
  status: SyncStatus;
  /** The last server version this device is known to be in sync with. */
  version: number;
  /** Human-readable detail for the loud indicator (invariant #6 style). null when idle/syncing. */
  detail: string | null;
  /**
   * Set only when status is 'error' and the dispatcher classified the failure
   * (classifySyncError). Lets the UI present subscription-required distinctly
   * (neutral activation state, WS4) without string-matching the detail text.
   */
  errorKind?: SyncErrorKind;
}

export type SyncEvent =
  | { type: 'start' }
  | { type: 'synced'; version: number }
  | { type: 'conflict-recovered'; version: number }
  | { type: 'error'; message: string; kind?: SyncErrorKind };

/** The minimal shape a push result must expose for the decision helpers. */
export interface PushResultLike {
  ok: boolean;
  conflict: boolean;
  version: number;
}

export function initialSyncState(version = 0): SyncState {
  return { status: 'idle', version, detail: null };
}

/**
 * The sync-state reducer. Pure and total: every event maps to a next state, and
 * the version bookkeeping is centralized here so the UI and the orchestration
 * never disagree about "what base version do we push next".
 *
 *   - `start`               -> syncing (version unchanged; a push is in flight)
 *   - `synced`              -> synced, version := the new server version
 *   - `conflict-recovered`  -> conflict-recovered, version := the re-push's version
 *   - `error`               -> error (version unchanged: we did not advance)
 */
export function reduceSync(state: SyncState, event: SyncEvent): SyncState {
  switch (event.type) {
    case 'start':
      return { ...state, status: 'syncing', detail: null, errorKind: undefined };
    case 'synced':
      return { status: 'synced', version: event.version, detail: null };
    case 'conflict-recovered':
      return {
        status: 'conflict-recovered',
        version: event.version,
        detail:
          'Another device had also changed this vault. Your edit was kept and pushed; ' +
          "the other device's version was backed up on this phone (.conflict.bak).",
      };
    case 'error':
      return { ...state, status: 'error', detail: event.message, errorKind: event.kind };
    default: {
      // Exhaustiveness guard: a new event type must be handled explicitly.
      const _never: never = event;
      return state;
    }
  }
}

/**
 * Does this push result require the conflict-recovery path (fetch+verify remote,
 * stash to .bak, re-push)? True exactly on an HTTP 409 (ok=false, conflict=true).
 * A transport error is NOT a conflict; it surfaces as an 'error' event and
 * leaves the version untouched.
 */
export function pushRequiresConflictRecovery(result: PushResultLike): boolean {
  return result.ok === false && result.conflict === true;
}

/**
 * The base version to send on the conflict RE-push. The 409 body carries the
 * server's current version; echoing it back as X-Base-Version is what tells the
 * server "I have seen your latest, replace it with mine" (optimistic
 * concurrency). Guards against a malformed/negative version by falling back to
 * the last known base.
 */
export function conflictRepushBaseVersion(conflict: PushResultLike, lastKnown: number): number {
  return Number.isInteger(conflict.version) && conflict.version >= 0 ? conflict.version : lastKnown;
}

/**
 * The side-effecting operations the sync orchestration needs, injected so the
 * SEQUENCE (the load-bearing, bug-prone part) is testable in Node with fakes
 * and never depends on Expo, the network, or a device. vault-session.tsx wires
 * these to the real transport (pushVaultMobile / fetchRemoteBlob /
 * verifyBlobOpensWithKey / stashRecoverableBak) and the SecureStore version
 * bookkeeping.
 *
 * `fetchRemote`, `verifyRemoteOpens`, and `stashRemote` are three ports rather
 * than one so the ORDER is enforced and tested: fetch, THEN verify the fetched
 * blob opens with our key, and ONLY THEN stash it to the recoverable .bak. A
 * failed verify must stop before stash and before the re-push.
 */
export interface SyncAfterSavePorts {
  /** True when the master key is in memory (needed to verify a displaced remote). */
  hasMasterKey(): boolean;
  /** The last server version this device synced to (the optimistic-concurrency base). */
  loadBaseVersion(): Promise<number>;
  /** PUT the current local vault with X-Base-Version = baseVersion. May throw on transport error. */
  push(baseVersion: number): Promise<PushResultLike>;
  /** GET + structural/hash-verify the remote; returns its version, or null if the account has no vault. */
  fetchRemote(): Promise<{ version: number } | null>;
  /** Prove the just-fetched remote opens with the master key (defeats a hostile/corrupt server). */
  verifyRemoteOpens(): boolean;
  /** Stash the just-fetched, verified remote as the recoverable .bak (last-writer-wins). */
  stashRemote(): void;
  /** Persist the new in-sync version after a successful push. */
  saveBaseVersion(version: number): Promise<void>;
}

/**
 * The M6-2 save-then-sync sequence, expressed purely over the injected ports so
 * it can be exercised in Node (apps/mobile/test/sync-flow.test.ts). Returns the
 * terminal SyncEvent to dispatch; the caller emits 'start' before awaiting and
 * catches any thrown transport error into an 'error' event.
 *
 *   1. push(base). ok -> save + 'synced'.
 *   2. 409 -> last-writer-wins recovery: require the key, fetch the remote,
 *      verify it opens with our key, stash it to .bak, then re-push OUR edit
 *      with base = the server's version -> save + 'conflict-recovered'.
 *   3. Any refusal along the way (unexpected non-409, no key, no remote, verify
 *      fails, or a third-writer race on the re-push) -> 'error', and the local
 *      vault and the saved base version are left untouched.
 */
export async function runSyncAfterSave(ports: SyncAfterSavePorts): Promise<SyncEvent> {
  const base = await ports.loadBaseVersion();
  const push1 = await ports.push(base);
  if (push1.ok) {
    await ports.saveBaseVersion(push1.version);
    return { type: 'synced', version: push1.version };
  }
  if (!pushRequiresConflictRecovery(push1)) {
    return { type: 'error', message: 'The push was refused for an unexpected reason.' };
  }
  if (!ports.hasMasterKey()) {
    return { type: 'error', message: 'Unlock the vault to resolve the sync conflict.' };
  }
  const remote = await ports.fetchRemote();
  if (remote === null) {
    return { type: 'error', message: 'The server changed during sync. Your edit is saved here; try syncing again.' };
  }
  if (!ports.verifyRemoteOpens()) {
    return {
      type: 'error',
      message:
        'The other version on the server did not open with your key, so nothing was overwritten. ' +
        'Your edit is saved on this phone.',
    };
  }
  ports.stashRemote();
  const base2 = conflictRepushBaseVersion(push1, base);
  const push2 = await ports.push(base2);
  if (!push2.ok) {
    return {
      type: 'error',
      message: 'Another device is syncing at the same time. Your edit is saved here; sync again in a moment.',
    };
  }
  await ports.saveBaseVersion(push2.version);
  return { type: 'conflict-recovered', version: push2.version };
}

/** True while a sync is in flight; the indicator shows a spinner and mutations wait. */
export function isSyncing(status: SyncStatus): boolean {
  return status === 'syncing';
}

/** Short label for the loud sync-state pill. */
export function syncStatusLabel(status: SyncStatus): string {
  switch (status) {
    case 'idle':
      return 'Idle';
    case 'syncing':
      return 'Syncing...';
    case 'synced':
      return 'Synced';
    case 'conflict-recovered':
      return 'Conflict resolved';
    case 'error':
      return 'Sync error';
  }
}
