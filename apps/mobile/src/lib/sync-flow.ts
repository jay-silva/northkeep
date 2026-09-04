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
  | {
      type: 'conflict-recovered';
      version: number;
      /**
       * True when the blob the re-push displaced is the one THIS PHONE
       * uploaded moments earlier. Set only when true, so the common
       * other-device case stays a two-field event.
       */
      displacedOwnUpload?: boolean;
    }
  | { type: 'error'; message: string; kind?: SyncErrorKind };

/** The minimal shape a push result must expose for the decision helpers. */
export interface PushResultLike {
  ok: boolean;
  conflict: boolean;
  version: number;
  /** Hex sha256 of the bytes the server accepted, when the transport reports it (ADR 0044). */
  sha256?: string;
  /**
   * The sync generation the transport stamped on disk before uploading, when
   * it bumped one. The session's open vault must adopt it, or its next save
   * writes the old value back and the phone's generation never rises (third
   * adversarial review, 2026-09-03).
   */
  generation?: number;
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
        detail: event.displacedOwnUpload
          ? // Naming another device here was a false alarm about the user's
            // own data: the displaced blob is this phone's own earlier upload
            // (ADR 0044, fifth review).
            "This phone's earlier upload was replaced by the newer save; " +
            'a copy is kept on this phone (.conflict.bak).'
          : 'Another device had also changed this vault. Your edit was kept and pushed; ' +
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
 * LWW conflict re-push generation (planner N1). A phone stuck at 5 while the
 * Mac has pushed 6–8 must not re-upload 6 (that would make the Mac refuse).
 * Set generation to max(local, fetched remote) + 1 before re-uploading.
 */
export function conflictRepushSyncGeneration(localGen: number, remoteGen: number): number {
  return Math.max(localGen, remoteGen) + 1;
}

/**
 * What a push should stamp on the vault, or null for "leave the stamp alone".
 * Mirrors packages/sync/src/client.ts pushVault exactly (ADR 0044, fourth
 * review on the desktop, fifth on the phone).
 *
 * ONE BUMP PER LOGICAL PUSH, however many attempts it takes. Bumping on every
 * attempt let a phone with one pending write gain a generation per retry;
 * once any other device pushed, that phone sat above every honest blob, its
 * pull refused as a replay and its push 409ing, with no way out but a save
 * that LWW-pushed the stale vault over the other device.
 *
 *   lastSyncGeneration === null   -> bump (currentStamp + 1)
 *   currentStamp <= last          -> last + 1
 *   currentStamp > last           -> null (a previous attempt already stamped
 *                                   it and never landed; do not stamp again)
 *
 * `last + 1` rather than `currentStamp + 1` in the middle case is what a vault
 * RESTORED FROM AN OLDER COPY needs: stamping from its own low value would put
 * it below the copy the server already holds, and the next pull would read as
 * a replay.
 *
 * A null baseline counts as "bump" on purpose, and it re-bumps on every
 * attempt: with no baseline there is no way to tell a fresh stamp from an
 * unlanded one, and stamping low is the worse error. The inflation costs
 * nothing now, because the pull's replay check reads lastSyncGeneration and
 * not the local stamp (see pulledBlobIsReplay).
 */
export function nextPushGeneration(currentStamp: number, lastSyncGeneration: number | null): number | null {
  if (lastSyncGeneration === null) return currentStamp + 1;
  if (currentStamp <= lastSyncGeneration) return lastSyncGeneration + 1;
  return null;
}

/**
 * THE BASELINE: what this phone last synced, as ONE value (ADR 0044, sixth
 * review kill shot).
 *
 * It used to be three SecureStore keys written one after another. A failure or
 * an interruption between them (one `setItemAsync` throw is enough, and the
 * device locking during a wake pull will do it) left the version, the sha and
 * the generation describing different moments: most dangerously a sha naming
 * the bytes the install had just replaced. `localChanged` then read true for a
 * vault holding nothing the user wrote, the wake pushed it, and the 409 plus
 * the M6-2 re-push rolled the other device's committed write off the server.
 *
 * One JSON value written in one call cannot tear: either the whole baseline
 * moves or none of it does.
 */
export interface SyncBaseline {
  /** The server version this phone last pushed to or pulled. */
  version: number;
  /** Hex sha256 of the vault file as it stood at that moment. Null when unknown. */
  sha: string | null;
  /** The sync generation sealed in those bytes. Null means "no baseline" (see nextPushGeneration). */
  generation: number | null;
  /**
   * Hex sha256 of bytes a push STAMPED but the server never accepted, and only
   * while there is no generation baseline to hold the stamp still. Without it a
   * failed establish bumped the stamp on every attempt, and an inflated stamp
   * is what wedged the phone in the fifth review. Cleared when a push lands.
   */
  pendingStampSha?: string | null;
}

const HEX_SHA_RE = /^[0-9a-f]{64}$/;

function validSha(value: unknown): value is string {
  return typeof value === 'string' && HEX_SHA_RE.test(value);
}

/**
 * Parse the stored baseline. Bad JSON, a non-object, or ANY field out of shape
 * reads as null, never as a partial baseline: a half-trusted baseline is the
 * torn state this value exists to make impossible. Null reads as "baseline
 * unknown", which decideWakeAction routes to establish/needs-pull, and those
 * never push on their own.
 *
 * Pure and here rather than in secure-store.ts so the validation is testable
 * under Node (secure-store.ts imports expo-secure-store).
 */
export function parseSyncBaseline(raw: string | null): SyncBaseline | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  if (!Number.isInteger(value.version) || (value.version as number) < 0) return null;
  if (!(value.sha === null || value.sha === undefined || validSha(value.sha))) return null;
  if (
    !(
      value.generation === null ||
      value.generation === undefined ||
      (Number.isInteger(value.generation) && (value.generation as number) >= 0)
    )
  ) {
    return null;
  }
  if (!(value.pendingStampSha === null || value.pendingStampSha === undefined || validSha(value.pendingStampSha))) {
    return null;
  }
  return {
    version: value.version as number,
    sha: validSha(value.sha) ? value.sha : null,
    generation: typeof value.generation === 'number' ? value.generation : null,
    pendingStampSha: validSha(value.pendingStampSha) ? value.pendingStampSha : null,
  };
}

/** Serialize a baseline for its single SecureStore write. */
export function serializeSyncBaseline(baseline: SyncBaseline): string {
  return JSON.stringify({
    version: baseline.version,
    sha: baseline.sha,
    generation: baseline.generation,
    pendingStampSha: baseline.pendingStampSha ?? null,
  });
}

/**
 * How a torn baseline is repaired. The phone holds bytes that do not match its
 * stored sha and the user wrote none of them, so nothing here is unpushed and
 * nothing can be lost either way.
 *
 *   the server's sha equals the file  -> 'record-baseline': the file IS what the
 *                                        server holds; write the baseline from
 *                                        the status response. No network write.
 *   anything else                     -> 'fast-forward': pull the server's copy
 *                                        and install it, which records too.
 */
export type RepairPlan = 'record-baseline' | 'fast-forward';

export function decideRepair(statusSha: string | null, currentSha: string | null): RepairPlan {
  return statusSha !== null && currentSha !== null && statusSha === currentSha
    ? 'record-baseline'
    : 'fast-forward';
}

/**
 * `nextPushGeneration` with the null-baseline guard the fifth review's fix left
 * open (ADR 0044, sixth review flesh wound). With no generation baseline there
 * is nothing to tell a fresh stamp from one a failed attempt already wrote, so
 * the old rule bumped on every attempt: three failed establishes cost three
 * generations and floated the phone above every honest blob.
 *
 * The pending stamp closes it: a push that stamps without landing records the
 * hash of the bytes it stamped, and the next prepare that finds the file still
 * hashing to it does not bump again. A real save moves the file, so the hash
 * stops matching and the next push bumps once, correctly.
 */
export function nextPushGenerationWithPending(input: {
  currentStamp: number;
  lastSyncGeneration: number | null;
  /** Hash of the vault file as it stands BEFORE this push stamps it. */
  currentSha: string | null;
  pendingStampSha: string | null | undefined;
}): number | null {
  const next = nextPushGeneration(input.currentStamp, input.lastSyncGeneration);
  if (next === null) return null;
  if (
    input.lastSyncGeneration === null &&
    input.pendingStampSha != null &&
    input.currentSha !== null &&
    input.currentSha === input.pendingStampSha
  ) {
    return null;
  }
  return next;
}

/**
 * Is an incoming blob older than the copy this phone LAST SYNCED? The replay
 * check, and the yardstick is the whole point: `lastSyncGeneration`, never the
 * local file's own stamp.
 *
 * The local stamp is wrong because it inflates with unpushed edits and with
 * pushes that never landed, and it establishes nothing about what the server
 * ever held. A phone whose establish push failed four times sits four
 * generations above every honest blob on the server, so comparing against it
 * refuses the very pull that would have unwedged the phone (ADR 0044, fifth
 * review kill shot). The question this check exists to answer is "is the
 * server handing me back something older than the copy I already had FROM
 * it?", and only lastSyncGeneration answers that.
 *
 * A null baseline reads as 0 and accepts anything: that is a phone that
 * predates the key, or one whose only sync so far was a first pull with no
 * key to read the installed generation with. The next push, or the next pull
 * against an existing local vault, records a real baseline and the check
 * bites from then on.
 */
export function pulledBlobIsReplay(pulledGeneration: number, lastSyncGeneration: number | null): boolean {
  return pulledGeneration < (lastSyncGeneration ?? 0);
}

/**
 * Did the conflict re-push displace bytes THIS PHONE uploaded moments earlier
 * (typically its own establish push), rather than another device's edit?
 * Compares the displaced blob's hash with the hash of what this phone last
 * synced. Drives the pill wording: telling the user another device changed
 * the vault when nothing of the sort happened is a false alarm about their
 * own data (ADR 0044, fifth review).
 *
 * `lastSyncedSha` is written by pulls as well as pushes, so it is strictly
 * "what this phone last synced", a superset of "what this phone last
 * uploaded". A false positive needs the server to 409 while handing back
 * byte-identical content, which is not reachable in practice.
 */
export function conflictDisplacedOwnUpload(displacedSha: string | null, lastSyncedSha: string | null): boolean {
  return displacedSha !== null && lastSyncedSha !== null && displacedSha === lastSyncedSha;
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
  push(baseVersion: number, opts?: { skipGenerationBump?: boolean }): Promise<PushResultLike>;
  /** GET + structural/hash-verify the remote; returns its version, or null if the account has no vault. */
  fetchRemote(): Promise<{ version: number } | null>;
  /** Prove the just-fetched remote opens with the master key (defeats a hostile/corrupt server). */
  verifyRemoteOpens(): boolean;
  /** Sync generation of the just-verified remote (same number desktop would compare). */
  remoteSyncGeneration(): number;
  /**
   * Current local vault sync generation (after the first push's bump). May be
   * async: on the phone this reads the vault file under the in-process vault
   * gate (src/lib/vault-gate.ts).
   */
  localSyncGeneration(): number | Promise<number>;
  /**
   * Persist generation = conflictRepushSyncGeneration(...) before the re-push.
   * May be async, and is AWAITED: it is a vault write, so on the phone it runs
   * under the vault gate and the re-push's read must not start before it lands.
   */
  applyConflictRepushGeneration(nextGeneration: number): void | Promise<void>;
  /** Stash the just-fetched, verified remote as the recoverable .bak (last-writer-wins). */
  stashRemote(): void;
  /**
   * Is the blob we just stashed this phone's OWN earlier upload rather than
   * another device's edit? Drives the pill wording only (see
   * conflictDisplacedOwnUpload). Asked BEFORE the re-push, because
   * saveBaseVersion overwrites the hash the answer is drawn from. Optional:
   * absent means "assume another device", the pre-existing wording.
   */
  displacedRemoteWasOwnUpload?(): boolean | Promise<boolean>;
  /**
   * Persist the new in-sync baseline after a push the server accepted: the
   * version, the hash of the accepted bytes, and the sync generation sealed
   * inside them. That generation is what the next push bumps against and what
   * the next pull's replay check compares to, so it MUST be recorded on every
   * accepted push and never before one (ADR 0044, fifth review).
   */
  saveBaseVersion(version: number, sha256?: string, generation?: number): Promise<void>;
  /**
   * Carry the generation the transport stamped on disk into the session's
   * open vault, so the next save does not overwrite it with the old value.
   */
  adoptGeneration?(generation: number): void;
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
    if (push1.generation !== undefined) ports.adoptGeneration?.(push1.generation);
    await ports.saveBaseVersion(push1.version, push1.sha256, push1.generation);
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
  // Asked before the re-push: saveBaseVersion below overwrites the stored hash
  // this answer is drawn from.
  const displacedOwnUpload = (await ports.displacedRemoteWasOwnUpload?.()) === true;
  const nextGen = conflictRepushSyncGeneration(await ports.localSyncGeneration(), ports.remoteSyncGeneration());
  await ports.applyConflictRepushGeneration(nextGen);
  const base2 = conflictRepushBaseVersion(push1, base);
  const push2 = await ports.push(base2, { skipGenerationBump: true });
  if (!push2.ok) {
    return {
      type: 'error',
      message: 'Another device is syncing at the same time. Your edit is saved here; sync again in a moment.',
    };
  }
  if (push2.generation !== undefined) ports.adoptGeneration?.(push2.generation);
  // The re-push skips the bump, so the transport may report no generation. It
  // does not need to: applyConflictRepushGeneration wrote exactly `nextGen` to
  // the file under a FIFO gate, so that IS the generation in the accepted
  // bytes. Recording it here is what keeps a conflict re-push from leaving the
  // baseline stale (and reading it back would mean an extra openWithKey, which
  // can migrate and therefore write).
  await ports.saveBaseVersion(push2.version, push2.sha256, push2.generation ?? nextGen);
  return displacedOwnUpload
    ? { type: 'conflict-recovered', version: push2.version, displacedOwnUpload: true }
    : { type: 'conflict-recovered', version: push2.version };
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

// ---------------------------------------------------------------------------
// ADR 0044: wake pull (fast-forward only) and the sync age.
// ---------------------------------------------------------------------------

export type WakeAction =
  | 'none'
  | 'retry-push'
  | 'pull'
  | 'check'
  | 'establish'
  | 'needs-pull'
  /**
   * The bytes moved but the user wrote nothing: a TORN BASELINE (ADR 0044,
   * sixth review kill shot). The install wrote the server's bytes and the
   * baseline write that follows it failed, so the stored sha names the old
   * bytes. Pushing here uploads a vault holding nothing the user wrote, and
   * the 409 plus the M6-2 re-push rolls the other device's write off the
   * server. The caller repairs from the server instead (decideRepair).
   */
  | 'repair'
  /**
   * A save is flagged unpushed but the file hashes to the baseline: the push
   * landed and only the flag write failed. The caller clears the flag. No
   * network.
   */
  | 'clear-dirty';

/**
 * The loud line for a phone that cannot tell whether it is behind or ahead:
 * the user decides. Deliberately NOT "the server has newer changes": the
 * server may have been restored below us, or wiped, and the phone genuinely
 * cannot tell which. Saying "newer" while pointing at a pull that REPLACES
 * this phone's vault is how a pre-0044 unpushed edit got buried (fourth
 * adversarial review, 2026-09-03). The line names the replacement and the
 * backup instead.
 */
export const NEEDS_PULL_MESSAGE =
  "The server's copy differs from this phone's. Pull to replace this phone's vault; a copy is kept.";

export interface WakeInput {
  unlocked: boolean;
  /** Device secret and server URL are both set. */
  configured: boolean;
  status: SyncStatus;
  errorKind?: SyncErrorKind;
  /**
   * True when a local save has happened whose push has not landed yet (set
   * before every push, cleared when the server accepts it). Persisted so a
   * failed push survives a relaunch: syncState resets to idle on launch, but an
   * unpushed edit is still unpushed, and a wake pull must never bury it.
   */
  localDirty: boolean;
  /**
   * True when the vault file on disk does not hash to the stored post-sync
   * baseline, or when there is no baseline. This is the byte-level signal the
   * desktop uses; localDirty alone tracked push ATTEMPTS and missed saves made
   * before sync was configured (second adversarial review, 2026-09-03).
   */
  localChanged: boolean;
  /**
   * False when there is no stored post-sync hash: a phone that synced before
   * the hash existed. Then "changed" is unknowable, and unknown must never
   * become a push with nothing unpushed (third adversarial review: the 409
   * would trigger last-writer-wins and roll the other device back).
   */
  baselineKnown: boolean;
  /** Server version from GET /api/status, or null when not fetched yet. */
  remoteVersion: number | null;
  /** The last server version this phone pushed to or pulled. */
  lastSyncedVersion: number;
}

/**
 * What a wake (unlock, or return to foreground while unlocked) should do.
 * Pure, so every branch is tested in Node. The one rule: the phone pulls on
 * its own only when its last push landed (nothing local is unpushed) AND the
 * server is ahead. Anything unpushed is pushed instead, exactly like the
 * save-then-push path; a paywall or a private server is never retried here.
 *
 *   locked or unconfigured            -> 'none'
 *   a sync in flight                  -> 'none'
 *   error: subscription / not enabled -> 'none'   (the user acts, not a timer)
 *   user wrote AND bytes moved        -> 'retry-push'
 *   user wrote, bytes unmoved         -> 'clear-dirty' (the push landed; only
 *                                        the flag write failed. No network.)
 *   bytes moved, user wrote nothing,
 *     baseline known                  -> 'repair'  (a torn baseline; see below)
 *   baseline unknown (no stored hash, a phone that synced before it existed):
 *     remote unknown                  -> 'check'
 *     remote == last synced version   -> 'establish' (one push WITHOUT conflict
 *                                        recovery: the server holds what we
 *                                        last synced, so our bytes extend it;
 *                                        a 409 there is reported, never resolved)
 *     anything else                   -> 'needs-pull' (say so; the user pulls)
 *   remote version unknown            -> 'check'  (fetch /api/status, decide again)
 *   server ahead                      -> 'pull'
 *   otherwise                         -> 'none'
 */
/**
 * The byte-level "untouched since sync" test. Unknown on either side counts as
 * changed: a phone that synced before the hash existed, or has no file, must
 * never be fast-forwarded over.
 */
export function vaultUnchangedSinceSync(lastSyncSha: string | null, currentSha: string | null): boolean {
  return lastSyncSha !== null && currentSha !== null && lastSyncSha === currentSha;
}

/**
 * Did the vault file move between a wake's decision and the install? Used by
 * pullVaultMobile right before it writes (the phone has no file lock, so this
 * is its version of the desktop's under-lock re-check). No expectation means
 * a manual pull, which replaces regardless (documented limit).
 */
export function localBytesMoved(expectedSha: string | undefined, currentSha: string | null): boolean {
  if (expectedSha === undefined) return false;
  return currentSha === null || currentSha !== expectedSha;
}

/**
 * Does this phone hold bytes the server has never accepted? True when a save
 * is waiting for its push (`localDirty`) OR when the file does not hash to the
 * stored post-sync baseline. An ABSENT baseline counts as unpushed on purpose:
 * that is the upgrade path (a phone that synced before the hash key existed),
 * and it is exactly the case where a silent replace buries an edit.
 *
 * Used by the manual pull-to-refresh, which REPLACES the vault, to decide
 * whether to ask first (ADR 0044, fourth review).
 */
export function hasUnpushedBytes(input: {
  localDirty: boolean;
  lastSyncSha: string | null;
  currentSha: string | null;
}): boolean {
  if (input.localDirty) return true;
  return !vaultUnchangedSinceSync(input.lastSyncSha, input.currentSha);
}

/**
 * The base version an `establish` push sends. Normally the version this phone
 * last synced to: the server holds those bytes, so ours extend them. But an
 * EMPTY server (GET /api/status 404, remoteVersion null) holds nothing, and
 * pushing a stored version at it is refused forever: the pill says pull, the
 * pull finds nothing, and every later save reports a conflict (fourth review).
 * An empty server is base 0, the same base a fresh phone's first push sends.
 */
export function establishBaseVersion(remoteVersion: number | null, lastSyncedVersion: number): number {
  return remoteVersion === null ? 0 : lastSyncedVersion;
}

export function decideWakeAction(input: WakeInput): WakeAction {
  if (!input.unlocked || !input.configured) return 'none';
  if (input.status === 'syncing') return 'none';
  if (input.status === 'error' && (input.errorKind === 'subscription-required' || input.errorKind === 'not-enabled')) {
    return 'none';
  }
  // A PUSH NEEDS BOTH SIGNALS (ADR 0044, sixth review kill shot). `localDirty`
  // says the user wrote something; `localChanged` says the bytes on disk moved
  // away from the baseline. Either one alone used to push, and moved bytes
  // alone is exactly what a torn baseline looks like: the install landed the
  // server's copy and the bookkeeping write after it failed, so the phone
  // pushed a vault holding nothing the user wrote and the LWW re-push rolled
  // the other device's write off the server.
  if (input.localDirty && !input.localChanged) return 'clear-dirty';
  if (input.localDirty) return 'retry-push';
  // An unknown baseline is not "changed": it is unknowable, and pushing on it
  // manufactured the 409 that rolled the other device back (third review).
  if (!input.baselineKnown) {
    if (input.remoteVersion === null) return 'check';
    return input.remoteVersion === input.lastSyncedVersion ? 'establish' : 'needs-pull';
  }
  // Known baseline, nothing the user wrote, and the bytes moved anyway.
  if (input.localChanged) return 'repair';
  if (input.remoteVersion === null) return 'check';
  if (input.remoteVersion > input.lastSyncedVersion) return 'pull';
  return 'none';
}

/**
 * "just now" / "N min ago" / "N hour(s) ago" / "N day(s) ago", rounded. The
 * wording is identical to the desktop's syncAge (packages/sync/src/auto.ts) so
 * the Mac and the phone describe the same moment the same way. Null when the
 * phone has never synced.
 */
export function syncAgeLabel(lastSyncedAt: string | null, now: number = Date.now()): string | null {
  if (!lastSyncedAt) return null;
  const then = Date.parse(lastSyncedAt);
  if (Number.isNaN(then)) return null;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * The one-line age shown under the sync pill and in Settings: "Synced 2 min
 * ago" while fresh, "Last synced 6 days ago" once it is over an hour old (the
 * wording change is the staleness signal ADR 0044 asks for). Null when never.
 */
export function syncAgeLine(lastSyncedAt: string | null, now: number = Date.now()): string | null {
  const label = syncAgeLabel(lastSyncedAt, now);
  if (label === null) return null;
  const then = Date.parse(lastSyncedAt as string);
  const stale = now - then >= 60 * 60 * 1000;
  return stale ? `Last synced ${label}` : `Synced ${label}`;
}
