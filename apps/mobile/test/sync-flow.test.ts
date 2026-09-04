import { describe, expect, it, vi } from 'vitest';
import {
  NEEDS_PULL_MESSAGE,
  conflictDisplacedOwnUpload,
  conflictRepushBaseVersion,
  conflictRepushSyncGeneration,
  decideRepair,
  decideWakeAction,
  establishBaseVersion,
  hasUnpushedBytes,
  localBytesMoved,
  initialSyncState,
  nextPushGeneration,
  nextPushGenerationWithPending,
  parseSyncBaseline,
  pulledBlobIsReplay,
  serializeSyncBaseline,
  syncAgeLabel,
  syncAgeLine,
  isSyncing,
  pushRequiresConflictRecovery,
  reduceSync,
  runSyncAfterSave,
  syncStatusLabel,
  type PushResultLike,
  type SyncBaseline,
  type WakeInput,
  type SyncAfterSavePorts,
  type SyncState,
  vaultUnchangedSinceSync,
} from '../src/lib/sync-flow.js';

/**
 * Pure Node coverage of the M6-2 conflict/base-version decision and the
 * sync-state machine. This is the logic that CAN be tested off-device; the
 * transport wiring in src/lib/sync.ts and the screen wiring in
 * src/lib/vault-session.tsx sit on top of it and need a real server + phone to
 * exercise end to end (documented in those files and the ADRs).
 */

describe('reduceSync state machine', () => {
  it('starts idle at the given version with no detail', () => {
    expect(initialSyncState(7)).toEqual({ status: 'idle', version: 7, detail: null });
    expect(initialSyncState()).toEqual({ status: 'idle', version: 0, detail: null });
  });

  it('start -> syncing keeps the version and clears detail', () => {
    const s = reduceSync({ status: 'error', version: 3, detail: 'boom' }, { type: 'start' });
    expect(s).toEqual({ status: 'syncing', version: 3, detail: null });
  });

  it('synced advances the version to the pushed version (base bookkeeping)', () => {
    const s = reduceSync(initialSyncState(4), { type: 'synced', version: 5 });
    expect(s).toEqual({ status: 'synced', version: 5, detail: null });
  });

  it('conflict-recovered advances to the re-push version and explains the .bak', () => {
    const s = reduceSync(initialSyncState(4), { type: 'conflict-recovered', version: 6 });
    expect(s.status).toBe('conflict-recovered');
    expect(s.version).toBe(6);
    expect(s.detail).toMatch(/\.bak/);
    expect(s.detail).toMatch(/your edit was kept/i);
  });

  it('error preserves the version (we did not advance) and carries the message', () => {
    const s = reduceSync(initialSyncState(9), { type: 'error', message: 'network down' });
    expect(s).toEqual({ status: 'error', version: 9, detail: 'network down' });
  });

  it('error carries the classified kind (WS4 distinct presentation) and start clears it', () => {
    const s = reduceSync(initialSyncState(1), {
      type: 'error',
      message: 'Sync requires a NorthKeep subscription.',
      kind: 'subscription-required',
    });
    expect(s.status).toBe('error');
    expect(s.errorKind).toBe('subscription-required');
    const s2 = reduceSync(s, { type: 'start' });
    expect(s2.errorKind).toBeUndefined();
    const s3 = reduceSync(s, { type: 'synced', version: 2 });
    expect(s3.errorKind).toBeUndefined();
  });

  it('models the full happy-path push sequence', () => {
    let s: SyncState = initialSyncState(1);
    s = reduceSync(s, { type: 'start' });
    expect(s.status).toBe('syncing');
    s = reduceSync(s, { type: 'synced', version: 2 });
    expect(s).toEqual({ status: 'synced', version: 2, detail: null });
  });

  it('models the full two-sided-conflict sequence, ending at the re-push version', () => {
    // base=2 locally; server has moved to 5; phone wins and re-pushes to 6.
    let s: SyncState = initialSyncState(2);
    s = reduceSync(s, { type: 'start' });
    s = reduceSync(s, { type: 'conflict-recovered', version: 6 });
    expect(s.status).toBe('conflict-recovered');
    expect(s.version).toBe(6);
  });
});

describe('pushRequiresConflictRecovery', () => {
  const cases: Array<[PushResultLike, boolean]> = [
    [{ ok: true, conflict: false, version: 3 }, false],
    [{ ok: false, conflict: true, version: 5 }, true],
    // Defensive: a non-conflict failure (shouldn't happen; transport throws) is not recovery.
    [{ ok: false, conflict: false, version: 0 }, false],
  ];
  it.each(cases)('decides recovery for %o -> %s', (result, expected) => {
    expect(pushRequiresConflictRecovery(result)).toBe(expected);
  });
});

describe('conflictRepushBaseVersion', () => {
  it('echoes the server version from the 409 body', () => {
    expect(conflictRepushBaseVersion({ ok: false, conflict: true, version: 5 }, 2)).toBe(5);
  });
  it('falls back to the last known base when the 409 version is malformed', () => {
    expect(conflictRepushBaseVersion({ ok: false, conflict: true, version: -1 }, 2)).toBe(2);
    expect(conflictRepushBaseVersion({ ok: false, conflict: true, version: 1.5 }, 4)).toBe(4);
  });
});

describe('runSyncAfterSave orchestration (the load-bearing conflict sequence)', () => {
  /**
   * A recording fake of the injected side effects. Defaults to the happy path;
   * `pushResults` supplies queued push outcomes so the default RECORDING push is
   * used (and the `calls` order captures the push args too).
   */
  function makePorts(overrides: Partial<SyncAfterSavePorts> = {}, pushResults?: PushResultLike[]) {
    const calls: string[] = [];
    let pushIdx = 0;
    const ports: SyncAfterSavePorts = {
      hasMasterKey: vi.fn(() => true),
      loadBaseVersion: vi.fn(async () => 2),
      push: vi.fn(async (base: number) => {
        calls.push(`push(${base})`);
        if (pushResults) return pushResults[pushIdx++]!;
        return { ok: true, conflict: false, version: base + 1 } as PushResultLike;
      }),
      fetchRemote: vi.fn(async () => {
        calls.push('fetchRemote');
        return { version: 5 };
      }),
      verifyRemoteOpens: vi.fn(() => {
        calls.push('verifyRemoteOpens');
        return true;
      }),
      stashRemote: vi.fn(() => {
        calls.push('stashRemote');
      }),
      remoteSyncGeneration: vi.fn(() => 8),
      localSyncGeneration: vi.fn(() => 6),
      applyConflictRepushGeneration: vi.fn((n: number) => {
        calls.push(`applyConflictRepushGeneration(${n})`);
      }),
      saveBaseVersion: vi.fn(async (v: number) => {
        calls.push(`saveBaseVersion(${v})`);
      }),
      ...overrides,
    };
    return { ports, calls };
  }

  it('happy path: a clean push ends synced and never touches the conflict ports', async () => {
    const { ports } = makePorts();
    const event = await runSyncAfterSave(ports);
    expect(event).toEqual({ type: 'synced', version: 3 });
    expect(ports.saveBaseVersion).toHaveBeenCalledWith(3, undefined, undefined); // no sha/generation from the test port
    expect(ports.fetchRemote).not.toHaveBeenCalled();
    expect(ports.verifyRemoteOpens).not.toHaveBeenCalled();
    expect(ports.stashRemote).not.toHaveBeenCalled();
  });

  it('two-sided conflict: verifies, stashes, re-pushes OUR edit with base=serverVersion, ends conflict-recovered', async () => {
    // base=2 locally; first push 409s with server at 5; re-push at base 5 -> 6.
    const { ports, calls } = makePorts({}, [
      { ok: false, conflict: true, version: 5 },
      { ok: true, conflict: false, version: 6 },
    ]);
    const event = await runSyncAfterSave(ports);
    expect(event).toEqual({ type: 'conflict-recovered', version: 6 });
    // Order is the contract: push, fetch, verify, stash, THEN re-push at base 5.
    expect(calls).toEqual([
      'push(2)',
      'fetchRemote',
      'verifyRemoteOpens',
      'stashRemote',
      'applyConflictRepushGeneration(9)',
      'push(5)',
      'saveBaseVersion(6)',
    ]);
    expect(ports.stashRemote).toHaveBeenCalledTimes(1);
  });

  it('hostile/corrupt remote (verify fails): no stash, no re-push, base untouched, ends error', async () => {
    const push = vi
      .fn<(base: number) => Promise<PushResultLike>>()
      .mockResolvedValueOnce({ ok: false, conflict: true, version: 5 });
    const { ports } = makePorts({ push, verifyRemoteOpens: vi.fn(() => false) });
    const event = await runSyncAfterSave(ports);
    expect(event.type).toBe('error');
    expect(ports.stashRemote).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledTimes(1); // never re-pushed
    expect(ports.saveBaseVersion).not.toHaveBeenCalled();
  });

  it('conflict but the vault is locked: does not fetch, ends error', async () => {
    const push = vi.fn(async () => ({ ok: false, conflict: true, version: 5 }) as PushResultLike);
    const { ports } = makePorts({ push, hasMasterKey: vi.fn(() => false) });
    const event = await runSyncAfterSave(ports);
    expect(event.type).toBe('error');
    expect(ports.fetchRemote).not.toHaveBeenCalled();
  });

  it('conflict but the account has no remote blob (null): ends error, no re-push', async () => {
    const push = vi.fn(async () => ({ ok: false, conflict: true, version: 5 }) as PushResultLike);
    const { ports } = makePorts({ push, fetchRemote: vi.fn(async () => null) });
    const event = await runSyncAfterSave(ports);
    expect(event.type).toBe('error');
    expect(ports.stashRemote).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('third-writer race on the re-push (second 409): ends error, base not advanced', async () => {
    const push = vi
      .fn<(base: number) => Promise<PushResultLike>>()
      .mockResolvedValueOnce({ ok: false, conflict: true, version: 5 })
      .mockResolvedValueOnce({ ok: false, conflict: true, version: 7 });
    const { ports } = makePorts({ push });
    const event = await runSyncAfterSave(ports);
    expect(event.type).toBe('error');
    expect(ports.stashRemote).toHaveBeenCalledTimes(1); // we did stash before the losing re-push
    expect(ports.saveBaseVersion).not.toHaveBeenCalled();
  });

  it('an unexpected non-409 push failure ends error without conflict recovery', async () => {
    const push = vi.fn(async () => ({ ok: false, conflict: false, version: 0 }) as PushResultLike);
    const { ports } = makePorts({ push });
    const event = await runSyncAfterSave(ports);
    expect(event.type).toBe('error');
    expect(ports.fetchRemote).not.toHaveBeenCalled();
  });
});

describe('runSyncAfterSave adopts the stamped generation (third review)', () => {
  function ports(pushResults: PushResultLike[]) {
    const adopted: number[] = [];
    let i = 0;
    const p: SyncAfterSavePorts = {
      hasMasterKey: () => true,
      loadBaseVersion: async () => 1,
      push: async () => pushResults[i++]!,
      fetchRemote: async () => ({ version: 5 }),
      verifyRemoteOpens: () => true,
      remoteSyncGeneration: () => 5,
      localSyncGeneration: () => 2,
      applyConflictRepushGeneration: () => {},
      stashRemote: () => {},
      saveBaseVersion: async () => {},
      adoptGeneration: (g) => {
        adopted.push(g);
      },
    };
    return { p, adopted };
  }
  it('hands the clean push generation to the session vault', async () => {
    const { p, adopted } = ports([{ ok: true, conflict: false, version: 2, generation: 7 }]);
    await runSyncAfterSave(p);
    expect(adopted).toEqual([7]);
  });
  it('does nothing when the transport reports no generation (bump skipped), and tolerates a missing port', async () => {
    const { p, adopted } = ports([{ ok: true, conflict: false, version: 2 }]);
    await runSyncAfterSave(p);
    expect(adopted).toEqual([]);
    const { p: bare } = ports([{ ok: true, conflict: false, version: 2, generation: 3 }]);
    delete (bare as Partial<SyncAfterSavePorts>).adoptGeneration;
    await expect(runSyncAfterSave(bare)).resolves.toEqual({ type: 'synced', version: 2 });
  });
  it('adopts on the conflict re-push too when the transport stamped one', async () => {
    const { p, adopted } = ports([
      { ok: false, conflict: true, version: 5 },
      { ok: true, conflict: false, version: 6, generation: 6 },
    ]);
    const ev = await runSyncAfterSave(p);
    expect(ev.type).toBe('conflict-recovered');
    expect(adopted).toEqual([6]);
  });
});

describe('conflictRepushSyncGeneration (planner N1)', () => {
  it('sets generation to max(local, remote) + 1', () => {
    expect(conflictRepushSyncGeneration(5, 8)).toBe(9);
    expect(conflictRepushSyncGeneration(8, 5)).toBe(9);
    expect(conflictRepushSyncGeneration(5, 5)).toBe(6);
    expect(conflictRepushSyncGeneration(0, 0)).toBe(1);
  });

  it('behind-phone LWW then Mac pull would succeed (phone 5, Mac 8 → re-push 9 >= 8)', () => {
    const phoneLocal = 5;
    const macRemote = 8;
    const afterFirstBump = phoneLocal + 1; // 6, the naive re-push that would loop
    expect(afterFirstBump).toBeLessThan(macRemote);
    const lwwGen = conflictRepushSyncGeneration(afterFirstBump, macRemote);
    expect(lwwGen).toBe(9);
    expect(lwwGen >= macRemote).toBe(true);
  });
});

describe('indicator helpers', () => {
  it('isSyncing is true only mid-flight', () => {
    expect(isSyncing('syncing')).toBe(true);
    expect(isSyncing('idle')).toBe(false);
    expect(isSyncing('conflict-recovered')).toBe(false);
  });
  it('labels every status', () => {
    for (const status of ['idle', 'syncing', 'synced', 'conflict-recovered', 'error'] as const) {
      expect(syncStatusLabel(status).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// ADR 0044: the wake decision and the sync age
// ---------------------------------------------------------------------------

describe('decideWakeAction (ADR 0044 fast-forward rule)', () => {
  const ready: WakeInput = {
    unlocked: true,
    configured: true,
    status: 'synced',
    localDirty: false,
    localChanged: false,
    baselineKnown: true,
    remoteVersion: null,
    lastSyncedVersion: 3,
  };

  it('BOTH signals push: the user wrote something AND the bytes moved', () => {
    // The onboarding path from the second adversarial review: memories saved
    // before sync was configured, first push failed on the paywall, the Mac
    // pushed v4, the phone reopens. The save set the dirty flag under the gate
    // before it wrote, so both signals are present and it pushes.
    const edited = { ...ready, localDirty: true, localChanged: true };
    expect(
      decideWakeAction({ ...edited, status: 'error', errorKind: undefined, lastSyncedVersion: 0, remoteVersion: 4 }),
    ).toBe('retry-push');
    expect(decideWakeAction({ ...edited, remoteVersion: 9 })).toBe('retry-push');
    expect(decideWakeAction({ ...edited, remoteVersion: null })).toBe('retry-push');
    expect(decideWakeAction({ ...edited, status: 'idle', remoteVersion: 9 })).toBe('retry-push');
    // Paywall and private beta still win: the user acts, not a timer.
    expect(decideWakeAction({ ...edited, status: 'error', errorKind: 'subscription-required' })).toBe('none');
    expect(decideWakeAction({ ...edited, status: 'error', errorKind: 'not-enabled' })).toBe('none');
    // MOVED BYTES ALONE ARE NOT AN EDIT (sixth review kill shot). They are a
    // torn baseline, and pushing them uploads a vault holding nothing the user
    // wrote; the 409 and the LWW re-push then roll the other device back.
    expect(decideWakeAction({ ...ready, localDirty: false, localChanged: true, remoteVersion: 9 })).toBe('repair');
    expect(decideWakeAction({ ...ready, localDirty: false, localChanged: true, remoteVersion: null })).toBe('repair');
    expect(decideWakeAction({ ...ready, localDirty: false, localChanged: true, lastSyncedVersion: 0, remoteVersion: 4 })).toBe('repair');
    // Untouched bytes: the existing fast-forward rule.
    expect(decideWakeAction({ ...ready, localChanged: false, remoteVersion: 9 })).toBe('pull');
    expect(decideWakeAction({ ...ready, localChanged: false, remoteVersion: null })).toBe('check');
  });

  it('an unknown baseline never pushes on its own (third review: the upgrade path)', () => {
    // A phone that synced before the post-sync hash existed: stored version,
    // no stored hash, nothing dirty. "Unknown" is not "changed".
    const upgraded: WakeInput = { ...ready, baselineKnown: false, localChanged: true, localDirty: false, lastSyncedVersion: 1 };
    for (const status of ['idle', 'synced', 'conflict-recovered', 'error'] as const) {
      for (const errorKind of ['network', 'redirect-refused', 'other', undefined] as const) {
        const base = { ...upgraded, status, errorKind };
        expect(decideWakeAction({ ...base, remoteVersion: null })).toBe('check');
        expect(decideWakeAction({ ...base, remoteVersion: 3 })).toBe('needs-pull');
        expect(decideWakeAction({ ...base, remoteVersion: 1 })).toBe('establish');
        expect(decideWakeAction({ ...base, remoteVersion: 0 })).toBe('needs-pull');
        // Never a push with nothing unpushed, never an automatic pull.
        for (const remoteVersion of [null, 0, 1, 2, 3, 99]) {
          const action = decideWakeAction({ ...base, remoteVersion });
          expect(action).not.toBe('retry-push');
          expect(action).not.toBe('pull');
        }
      }
    }
    // A genuinely unpushed save still pushes, baseline or not.
    expect(decideWakeAction({ ...upgraded, localDirty: true, remoteVersion: 3 })).toBe('retry-push');
    // Paywall and private beta still win.
    expect(decideWakeAction({ ...upgraded, status: 'error', errorKind: 'subscription-required', remoteVersion: 3 })).toBe('none');
    expect(decideWakeAction({ ...upgraded, status: 'error', errorKind: 'not-enabled', remoteVersion: 1 })).toBe('none');
    // Locked or unconfigured: nothing.
    expect(decideWakeAction({ ...upgraded, unlocked: false, remoteVersion: 1 })).toBe('none');
  });

  it('localBytesMoved: the pre-install re-check refuses a moved file and only when asked', () => {
    const h = 'c'.repeat(64);
    expect(localBytesMoved(undefined, h)).toBe(false); // manual pull: no expectation
    expect(localBytesMoved(undefined, null)).toBe(false);
    expect(localBytesMoved(h, h)).toBe(false);
    expect(localBytesMoved(h, 'd'.repeat(64))).toBe(true);
    expect(localBytesMoved(h, null)).toBe(true);
  });

  it('vaultUnchangedSinceSync: unknown on either side counts as changed', () => {
    const h = 'a'.repeat(64);
    expect(vaultUnchangedSinceSync(h, h)).toBe(true);
    expect(vaultUnchangedSinceSync(h, 'b'.repeat(64))).toBe(false);
    expect(vaultUnchangedSinceSync(null, h)).toBe(false);
    expect(vaultUnchangedSinceSync(h, null)).toBe(false);
    expect(vaultUnchangedSinceSync(null, null)).toBe(false);
  });

  it('does nothing while locked or unconfigured, whatever else is true', () => {
    expect(decideWakeAction({ ...ready, unlocked: false, remoteVersion: 9 })).toBe('none');
    expect(decideWakeAction({ ...ready, configured: false, remoteVersion: 9 })).toBe('none');
    expect(decideWakeAction({ ...ready, unlocked: false, status: 'error', errorKind: 'network' })).toBe('none');
  });

  it('does nothing while a sync is in flight', () => {
    expect(decideWakeAction({ ...ready, status: 'syncing', remoteVersion: 9 })).toBe('none');
  });

  it('never retries a paywall or a private server on its own', () => {
    expect(decideWakeAction({ ...ready, status: 'error', errorKind: 'subscription-required' })).toBe('none');
    expect(decideWakeAction({ ...ready, status: 'error', errorKind: 'not-enabled' })).toBe('none');
  });

  it('an error with nothing unpushed is not a push: it checks the server, then fast-forwards or does nothing', () => {
    // A failed status check or pull leaves the phone in 'error' with its last
    // push landed. Pushing here manufactured a 409 and the LWW re-push rolled
    // the Mac back (adversarial review 2026-09-03). Only a dirty vault pushes.
    for (const errorKind of ['network', 'redirect-refused', 'other', undefined] as const) {
      expect(decideWakeAction({ ...ready, status: 'error', errorKind, localDirty: false, remoteVersion: null })).toBe('check');
      expect(decideWakeAction({ ...ready, status: 'error', errorKind, localDirty: false, remoteVersion: 9 })).toBe('pull');
      expect(decideWakeAction({ ...ready, status: 'error', errorKind, localDirty: false, remoteVersion: ready.lastSyncedVersion })).toBe('none');
      // Dirty with UNMOVED bytes: the push landed and only the flag write
      // failed. Clear the flag, no network.
      expect(decideWakeAction({ ...ready, status: 'error', errorKind, localDirty: true, remoteVersion: 9 })).toBe('clear-dirty');
      expect(
        decideWakeAction({ ...ready, status: 'error', errorKind, localDirty: true, localChanged: true, remoteVersion: 9 }),
      ).toBe('retry-push');
    }
  });

  it('retries the push when a local save is still unpushed AND its bytes are on disk, even if the server looks ahead', () => {
    const unpushed = { ...ready, localDirty: true, localChanged: true };
    expect(decideWakeAction({ ...unpushed, remoteVersion: 9 })).toBe('retry-push');
    expect(decideWakeAction({ ...unpushed, status: 'idle', remoteVersion: null })).toBe('retry-push');
    // The flag without the bytes is a stale flag, not an unpushed save.
    expect(decideWakeAction({ ...ready, localDirty: true, remoteVersion: 9 })).toBe('clear-dirty');
    expect(decideWakeAction({ ...ready, status: 'idle', localDirty: true, remoteVersion: null })).toBe('clear-dirty');
  });

  it('asks for a status check before deciding when the remote version is unknown', () => {
    expect(decideWakeAction({ ...ready, remoteVersion: null })).toBe('check');
    expect(decideWakeAction({ ...ready, status: 'idle', remoteVersion: null })).toBe('check');
    expect(decideWakeAction({ ...ready, status: 'conflict-recovered', remoteVersion: null })).toBe('check');
  });

  it('pulls only when the server is ahead of the last landed push', () => {
    expect(decideWakeAction({ ...ready, remoteVersion: 4 })).toBe('pull');
    expect(decideWakeAction({ ...ready, status: 'idle', remoteVersion: 10 })).toBe('pull');
    expect(decideWakeAction({ ...ready, remoteVersion: 3 })).toBe('none');
    expect(decideWakeAction({ ...ready, remoteVersion: 2 })).toBe('none');
  });
});

describe('establishBaseVersion (ADR 0044, fourth review)', () => {
  it('pushes from the stored version when the server holds a vault at it', () => {
    expect(establishBaseVersion(4, 4)).toBe(4);
    expect(establishBaseVersion(0, 0)).toBe(0);
  });

  it('pushes from base 0 against an EMPTY server, whatever this phone last synced', () => {
    // The bug: establish against a 404 server sent our stored version, the
    // server refused it forever, the pill said pull, the pull found nothing,
    // and every later save reported a conflict.
    expect(establishBaseVersion(null, 7)).toBe(0);
    expect(establishBaseVersion(null, 0)).toBe(0);
    expect(establishBaseVersion(null, 1_000_000)).toBe(0);
  });
});

describe('hasUnpushedBytes (the manual pull-to-refresh confirmation)', () => {
  const synced = 'a'.repeat(64);
  const edited = 'b'.repeat(64);

  it('is false only when the file still hashes to the stored baseline and nothing is dirty', () => {
    expect(hasUnpushedBytes({ localDirty: false, lastSyncSha: synced, currentSha: synced })).toBe(false);
  });

  it('is true when the bytes moved, when a push is still pending, or both', () => {
    expect(hasUnpushedBytes({ localDirty: false, lastSyncSha: synced, currentSha: edited })).toBe(true);
    expect(hasUnpushedBytes({ localDirty: true, lastSyncSha: synced, currentSha: synced })).toBe(true);
    expect(hasUnpushedBytes({ localDirty: true, lastSyncSha: synced, currentSha: edited })).toBe(true);
  });

  it('an ABSENT baseline counts as unpushed: that is the upgrade path the warning exists for', () => {
    expect(hasUnpushedBytes({ localDirty: false, lastSyncSha: null, currentSha: synced })).toBe(true);
    expect(hasUnpushedBytes({ localDirty: false, lastSyncSha: null, currentSha: null })).toBe(true);
    expect(hasUnpushedBytes({ localDirty: false, lastSyncSha: synced, currentSha: null })).toBe(true);
  });
});

describe('NEEDS_PULL_MESSAGE wording (ADR 0044, fourth review)', () => {
  it('does not claim the server is newer, and names the replacement and the backup', () => {
    // The phone cannot tell "ahead" from "restored below us" from "wiped", so
    // it must not say "newer", and it must say that a pull REPLACES.
    expect(NEEDS_PULL_MESSAGE).toBe(
      "The server's copy differs from this phone's. Pull to replace this phone's vault; a copy is kept.",
    );
    expect(NEEDS_PULL_MESSAGE).not.toMatch(/newer/i);
    expect(NEEDS_PULL_MESSAGE).toMatch(/differs/i);
    expect(NEEDS_PULL_MESSAGE).toMatch(/replace/i);
    expect(NEEDS_PULL_MESSAGE).toMatch(/copy is kept/i);
    // House style: no em dashes in user-facing copy.
    expect(NEEDS_PULL_MESSAGE).not.toContain('\u2014');
  });
});

describe('syncAgeLabel / syncAgeLine (ADR 0044, same wording as the desktop)', () => {
  const now = Date.parse('2026-09-03T12:00:00Z');

  it('wording matches packages/sync syncAge exactly', () => {
    expect(syncAgeLabel(null, now)).toBeNull();
    expect(syncAgeLabel('not a date', now)).toBeNull();
    expect(syncAgeLabel('2026-09-03T11:59:50Z', now)).toBe('just now');
    expect(syncAgeLabel('2026-09-03T11:58:00Z', now)).toBe('2 min ago');
    expect(syncAgeLabel('2026-09-03T09:00:00Z', now)).toBe('3 hours ago');
    expect(syncAgeLabel('2026-09-03T11:00:00Z', now)).toBe('1 hour ago');
    expect(syncAgeLabel('2026-09-02T11:00:00Z', now)).toBe('1 day ago');
    expect(syncAgeLabel('2026-08-28T12:00:00Z', now)).toBe('6 days ago');
  });

  it('the line says Synced while fresh and Last synced once an hour has passed', () => {
    expect(syncAgeLine(null, now)).toBeNull();
    expect(syncAgeLine('2026-09-03T11:58:00Z', now)).toBe('Synced 2 min ago');
    expect(syncAgeLine('2026-09-03T11:00:00Z', now)).toBe('Last synced 1 hour ago');
    expect(syncAgeLine('2026-08-28T12:00:00Z', now)).toBe('Last synced 6 days ago');
  });
});

// ---------------------------------------------------------------------------
// ADR 0044, FIFTH REVIEW (the phone kill shot): one bump per logical push, and
// a replay check measured against what this phone last SYNCED rather than
// against the local file's stamp.
// ---------------------------------------------------------------------------

describe('nextPushGeneration (one bump per logical push)', () => {
  it('no baseline: bumps from the current stamp (and keeps bumping, deliberately)', () => {
    // Null means "we cannot tell a fresh stamp from an unlanded one". Stamping
    // low is the worse error, so it bumps; the inflation is harmless because
    // the replay check no longer reads the local stamp.
    expect(nextPushGeneration(0, null)).toBe(1);
    expect(nextPushGeneration(7, null)).toBe(8);
  });

  it('stamp BEHIND the baseline (restored from an older copy): stamps last + 1, never current + 1', () => {
    // current + 1 would put the vault BELOW the copy the server already holds,
    // and the next pull would then read as a replay.
    expect(nextPushGeneration(2, 9)).toBe(10);
    expect(nextPushGeneration(0, 4)).toBe(5);
  });

  it('stamp EQUAL to the baseline (the ordinary first attempt): bumps once', () => {
    expect(nextPushGeneration(5, 5)).toBe(6);
  });

  it('stamp AHEAD of the baseline (a previous attempt stamped and never landed): does not bump again', () => {
    expect(nextPushGeneration(6, 5)).toBeNull();
    expect(nextPushGeneration(9, 5)).toBeNull();
  });
});

describe('pulledBlobIsReplay (the yardstick is lastSyncGeneration, not the local stamp)', () => {
  it('is inert with no baseline: a phone that predates the key accepts any honest blob', () => {
    expect(pulledBlobIsReplay(0, null)).toBe(false);
    expect(pulledBlobIsReplay(2, null)).toBe(false);
  });

  it('refuses only what is older than the copy this phone last synced', () => {
    expect(pulledBlobIsReplay(4, 5)).toBe(true);
    expect(pulledBlobIsReplay(5, 5)).toBe(false);
    expect(pulledBlobIsReplay(6, 5)).toBe(false);
  });
});

/**
 * A fake phone: the vault's generation stamp on disk, plus the persisted
 * lastSyncGeneration. `push` runs exactly the rule preparePushMobile runs
 * (nextPushGeneration then read back), and `saveBaseVersion` records the
 * generation only on the pushes the fake server accepts.
 */
function fakePhone(initial: { stamp: number; lastSyncGeneration: number | null }) {
  const disk = {
    stamp: initial.stamp,
    lastSyncGeneration: initial.lastSyncGeneration,
    /** The persisted pending stamp (sixth review): part of the one baseline value. */
    pendingStampSha: null as string | null,
    /** Stand-in for the vault's user content, so a real save moves the file hash. */
    content: 'v1',
  };
  /** The file hash: content plus the generation stamp, exactly what a stamp-and-save moves. */
  const fileSha = () => `${disk.content}@${disk.stamp}`;
  let attempts = 0;
  /** Queue of server outcomes: 'fail' throws (a 500), a number is the accepted version. */
  function ports(outcomes: Array<'fail' | number>): SyncAfterSavePorts {
    return {
      hasMasterKey: () => true,
      loadBaseVersion: async () => 5,
      push: async (_base, opts) => {
        let generation: number | undefined;
        if (!opts?.skipGenerationBump) {
          // Exactly what preparePushMobile runs.
          const next = nextPushGenerationWithPending({
            currentStamp: disk.stamp,
            lastSyncGeneration: disk.lastSyncGeneration,
            currentSha: fileSha(),
            pendingStampSha: disk.pendingStampSha,
          });
          if (next !== null) disk.stamp = next;
          generation = disk.stamp;
          if (disk.lastSyncGeneration === null) disk.pendingStampSha = fileSha();
        }
        const outcome = outcomes[attempts++]!;
        if (outcome === 'fail') throw new Error('Sync server returned HTTP 500 on push.');
        return { ok: true, conflict: false, version: outcome, generation };
      },
      fetchRemote: async () => ({ version: 0 }),
      verifyRemoteOpens: () => true,
      remoteSyncGeneration: () => 0,
      localSyncGeneration: () => disk.stamp,
      applyConflictRepushGeneration: () => {},
      stashRemote: () => {},
      saveBaseVersion: async (_v, _sha, generation) => {
        // The one baseline write: the generation lands and the pending stamp
        // is cleared, because those bytes are no longer unlanded.
        if (generation !== undefined) disk.lastSyncGeneration = generation;
        disk.pendingStampSha = null;
      },
    };
  }
  return { disk, ports, fileSha, attemptCount: () => attempts };
}

describe('four failed attempts then a success stamp EXACTLY one bump (the kill shot)', () => {
  it('with a baseline, a push retried five times gains one generation, not five', async () => {
    const phone = fakePhone({ stamp: 5, lastSyncGeneration: 5 });
    const outcomes: Array<'fail' | number> = ['fail', 'fail', 'fail', 'fail', 9];
    // Four failures: the caller catches the transport error and tries again on
    // the next wake, exactly as pushAfterSave / runWake do.
    for (let i = 0; i < 4; i += 1) {
      await expect(runSyncAfterSave(phone.ports(outcomes))).rejects.toThrow(/HTTP 500/);
      // Still exactly one bump after every failed attempt.
      expect(phone.disk.stamp).toBe(6);
      // And nothing is recorded until the server accepts: a baseline written
      // on an attempt would make the phone refuse honest blobs.
      expect(phone.disk.lastSyncGeneration).toBe(5);
    }
    const event = await runSyncAfterSave(phone.ports(outcomes));
    expect(event).toEqual({ type: 'synced', version: 9 });
    expect(phone.attemptCount()).toBe(5);
    expect(phone.disk.stamp).toBe(6); // one bump for five attempts
    expect(phone.disk.lastSyncGeneration).toBe(6); // recorded only on acceptance
  });

  it('the accepted bytes set the baseline, so the NEXT logical push bumps again (once)', async () => {
    const phone = fakePhone({ stamp: 5, lastSyncGeneration: 5 });
    await runSyncAfterSave(phone.ports([7]));
    expect(phone.disk).toMatchObject({ stamp: 6, lastSyncGeneration: 6, pendingStampSha: null });
    await runSyncAfterSave(phone.ports([8]));
    expect(phone.disk).toMatchObject({ stamp: 7, lastSyncGeneration: 7, pendingStampSha: null });
  });
});

describe('the fifth review A2 scenario: a failed establish must not wedge the pull', () => {
  it('stored version 5, no hash, establish 500s three times, then the Mac pushes gen 2 / version 9', async () => {
    // The phone has synced before the post-sync hash existed: version 5, no
    // baseline of any kind. Its establish push fails three times against the
    // outage. With no lastSyncGeneration there IS no baseline to hold the
    // stamp still, so it inflates: 6, 7, 8. That is deliberate and now inert.
    const phone = fakePhone({ stamp: 5, lastSyncGeneration: null });
    for (let i = 0; i < 3; i += 1) {
      await expect(runSyncAfterSave(phone.ports(['fail', 'fail', 'fail']))).rejects.toThrow(/HTTP 500/);
    }
    // ONE bump for three failed establishes (ADR 0044, sixth review). The
    // pending stamp is what holds it: the first attempt stamped 6 and recorded
    // the hash of those bytes, and the next two found the file still hashing
    // to it. Before the fix this read 8, and an inflated stamp is what floated
    // the phone above every honest blob on the server.
    expect(phone.disk.stamp).toBe(6);
    expect(phone.disk.lastSyncGeneration).toBeNull(); // nothing landed, nothing recorded

    // The Mac then pushes: server version 9, blob at sync generation 2.
    const wake: WakeInput = {
      unlocked: true,
      configured: true,
      status: 'error',
      localDirty: false,
      localChanged: false,
      baselineKnown: false,
      remoteVersion: 9,
      lastSyncedVersion: 5,
    };
    expect(decideWakeAction(wake)).toBe('needs-pull');

    // The manual pull the pill asks for MUST succeed: generation 2 is not
    // older than what this phone last synced (nothing).
    expect(pulledBlobIsReplay(2, phone.disk.lastSyncGeneration)).toBe(false);

    // The counterfactual that names the defect: measured against the LOCAL
    // stamp the same honest blob was refused, and the phone had no way out
    // but a save that LWW-pushed its stale vault over the Mac.
    expect(2 < phone.disk.stamp).toBe(true);
  });
});

describe('conflict wording: the phone must not blame another device for its own upload', () => {
  it('conflictDisplacedOwnUpload matches only on an equal, known pair of hashes', () => {
    expect(conflictDisplacedOwnUpload('aa', 'aa')).toBe(true);
    expect(conflictDisplacedOwnUpload('aa', 'bb')).toBe(false);
    expect(conflictDisplacedOwnUpload(null, 'aa')).toBe(false);
    expect(conflictDisplacedOwnUpload('aa', null)).toBe(false);
    expect(conflictDisplacedOwnUpload(null, null)).toBe(false);
  });

  it('the pill says the phone replaced its own upload, and still names the copy', () => {
    const s = reduceSync(initialSyncState(4), {
      type: 'conflict-recovered',
      version: 6,
      displacedOwnUpload: true,
    });
    expect(s.detail).toMatch(/this phone's earlier upload was replaced/i);
    expect(s.detail).not.toMatch(/another device/i);
    expect(s.detail).toMatch(/\.conflict\.bak/);
    expect(s.detail).not.toMatch(/—/); // no em dash in user-facing copy
  });

  it('a genuine other-device conflict keeps the original wording', () => {
    const s = reduceSync(initialSyncState(4), { type: 'conflict-recovered', version: 6 });
    expect(s.detail).toMatch(/another device/i);
  });

  it('runSyncAfterSave asks the port before the re-push and carries the answer into the event', async () => {
    const order: string[] = [];
    const pushResults: PushResultLike[] = [
      { ok: false, conflict: true, version: 5 },
      { ok: true, conflict: false, version: 6 },
    ];
    let i = 0;
    const ports: SyncAfterSavePorts = {
      hasMasterKey: () => true,
      loadBaseVersion: async () => 2,
      push: async () => {
        order.push('push');
        return pushResults[i++]!;
      },
      fetchRemote: async () => ({ version: 5 }),
      verifyRemoteOpens: () => true,
      remoteSyncGeneration: () => 5,
      localSyncGeneration: () => 2,
      applyConflictRepushGeneration: () => {},
      stashRemote: () => {},
      displacedRemoteWasOwnUpload: async () => {
        order.push('displacedRemoteWasOwnUpload');
        return true;
      },
      saveBaseVersion: async () => {
        order.push('saveBaseVersion');
      },
    };
    const event = await runSyncAfterSave(ports);
    expect(event).toEqual({ type: 'conflict-recovered', version: 6, displacedOwnUpload: true });
    // Asked BEFORE the re-push and before saveBaseVersion overwrites the hash it reads.
    expect(order).toEqual(['push', 'displacedRemoteWasOwnUpload', 'push', 'saveBaseVersion']);
  });
});

describe('the conflict re-push records a baseline even though it skipped the bump', () => {
  it('falls back to the generation applyConflictRepushGeneration just wrote', async () => {
    const recorded: Array<number | undefined> = [];
    const pushResults: PushResultLike[] = [
      { ok: false, conflict: true, version: 5 },
      { ok: true, conflict: false, version: 6 }, // skipGenerationBump: no generation reported
    ];
    let i = 0;
    const ports: SyncAfterSavePorts = {
      hasMasterKey: () => true,
      loadBaseVersion: async () => 2,
      push: async () => pushResults[i++]!,
      fetchRemote: async () => ({ version: 5 }),
      verifyRemoteOpens: () => true,
      remoteSyncGeneration: () => 8,
      localSyncGeneration: () => 6,
      applyConflictRepushGeneration: () => {},
      stashRemote: () => {},
      saveBaseVersion: async (_v, _sha, generation) => {
        recorded.push(generation);
      },
    };
    await runSyncAfterSave(ports);
    // max(6, 8) + 1 = 9, the value written to the file before the re-push.
    expect(recorded).toEqual([9]);
  });
});

// ---------------------------------------------------------------------------
// ADR 0044, SIXTH REVIEW KILL SHOT (phone): the torn baseline.
//
// The install wrote the server's bytes and the baseline bookkeeping after it
// failed or was interrupted (one SecureStore write throwing is enough; the
// device locking during a wake pull will do it). The stored sha then named the
// OLD bytes, `localChanged` read true, and the wake pushed a vault holding
// nothing the user wrote. The 409 and the M6-2 last-writer-wins re-push rolled
// the other device's committed write off the server, and both pills said
// Synced.
// ---------------------------------------------------------------------------

describe('the baseline is ONE value: parse, serialize, and what a bad one reads as', () => {
  const sha = 'a'.repeat(64);
  const other = 'b'.repeat(64);

  it('round-trips version, sha, generation and the pending stamp', () => {
    const baseline: SyncBaseline = { version: 7, sha, generation: 3, pendingStampSha: other };
    expect(parseSyncBaseline(serializeSyncBaseline(baseline))).toEqual(baseline);
    expect(parseSyncBaseline(serializeSyncBaseline({ version: 0, sha: null, generation: null }))).toEqual({
      version: 0,
      sha: null,
      generation: null,
      pendingStampSha: null,
    });
  });

  it('bad JSON and bad fields read as NULL, never as a partial baseline', () => {
    // Null is "baseline unknown", which the wake routes to establish/needs-pull
    // and never to a push. A HALF-trusted baseline is the torn state this value
    // exists to make impossible, so nothing is salvaged from a bad one.
    expect(parseSyncBaseline(null)).toBeNull();
    expect(parseSyncBaseline('')).toBeNull();
    expect(parseSyncBaseline('{')).toBeNull();
    expect(parseSyncBaseline('"a string"')).toBeNull();
    expect(parseSyncBaseline('[1,2]')).toBeNull();
    expect(parseSyncBaseline('null')).toBeNull();
    expect(parseSyncBaseline(JSON.stringify({ sha, generation: 1 }))).toBeNull(); // no version
    expect(parseSyncBaseline(JSON.stringify({ version: -1, sha, generation: 1 }))).toBeNull();
    expect(parseSyncBaseline(JSON.stringify({ version: 1.5, sha, generation: 1 }))).toBeNull();
    expect(parseSyncBaseline(JSON.stringify({ version: '3', sha, generation: 1 }))).toBeNull();
    expect(parseSyncBaseline(JSON.stringify({ version: 3, sha: 'not-a-hash', generation: 1 }))).toBeNull();
    expect(parseSyncBaseline(JSON.stringify({ version: 3, sha: sha.toUpperCase(), generation: 1 }))).toBeNull();
    expect(parseSyncBaseline(JSON.stringify({ version: 3, sha, generation: -2 }))).toBeNull();
    expect(parseSyncBaseline(JSON.stringify({ version: 3, sha, generation: 'x' }))).toBeNull();
    expect(parseSyncBaseline(JSON.stringify({ version: 3, sha, generation: 1, pendingStampSha: 'nope' }))).toBeNull();
    // Generation 0 is a REAL baseline and must survive: reading it as null
    // would make the replay check inert on a freshly created vault.
    expect(parseSyncBaseline(JSON.stringify({ version: 3, sha, generation: 0 }))).toEqual({
      version: 3,
      sha,
      generation: 0,
      pendingStampSha: null,
    });
  });
});

describe('decideRepair (how a torn baseline is healed)', () => {
  const sha = 'c'.repeat(64);
  it('records the baseline when the server holds exactly these bytes: no network write', () => {
    expect(decideRepair(sha, sha)).toBe('record-baseline');
  });
  it('fast-forwards otherwise, which is safe because nothing here is unpushed', () => {
    expect(decideRepair('d'.repeat(64), sha)).toBe('fast-forward');
    expect(decideRepair(null, sha)).toBe('fast-forward');
    expect(decideRepair(sha, null)).toBe('fast-forward');
    expect(decideRepair('', sha)).toBe('fast-forward'); // a server that reports no sha
  });
});

describe('the decideWakeAction matrix: dirty x changed x baselineKnown', () => {
  const base: WakeInput = {
    unlocked: true,
    configured: true,
    status: 'synced',
    localDirty: false,
    localChanged: false,
    baselineKnown: true,
    remoteVersion: null,
    lastSyncedVersion: 3,
  };

  it('every combination, against the four invariants the kill shot turns on', () => {
    for (const localDirty of [false, true]) {
      for (const localChanged of [false, true]) {
        for (const baselineKnown of [false, true]) {
          for (const remoteVersion of [null, 0, 3, 9]) {
            const input = { ...base, localDirty, localChanged, baselineKnown, remoteVersion };
            const action = decideWakeAction(input);

            // 1. A PULL only when the vault is clean, the baseline is known,
            //    and the server is ahead. Fast-forward only, as ever.
            if (action === 'pull') {
              expect({ localDirty, localChanged, baselineKnown }).toEqual({
                localDirty: false,
                localChanged: false,
                baselineKnown: true,
              });
              expect(remoteVersion !== null && remoteVersion > input.lastSyncedVersion).toBe(true);
            }
            // 2. A PUSH only when the user wrote something AND the bytes moved.
            if (action === 'retry-push') expect({ localDirty, localChanged }).toEqual({ localDirty: true, localChanged: true });
            // 3. REPAIR only on the torn-baseline shape.
            if (action === 'repair') {
              expect({ localDirty, localChanged, baselineKnown }).toEqual({
                localDirty: false,
                localChanged: true,
                baselineKnown: true,
              });
            }
            // 4. CLEAR-DIRTY exactly when the flag is set and the bytes are not.
            if (action === 'clear-dirty') expect({ localDirty, localChanged }).toEqual({ localDirty: true, localChanged: false });

            // And the converses, so a rule cannot go missing rather than wrong.
            if (localDirty && localChanged) expect(action).toBe('retry-push');
            if (localDirty && !localChanged) expect(action).toBe('clear-dirty');
            if (!localDirty && localChanged && baselineKnown) expect(action).toBe('repair');
          }
        }
      }
    }
  });

  it('an unknown baseline still establishes or asks: the rules the third and fourth reviews set', () => {
    const unknown = { ...base, baselineKnown: false, localChanged: true };
    expect(decideWakeAction({ ...unknown, remoteVersion: null })).toBe('check');
    expect(decideWakeAction({ ...unknown, remoteVersion: 3 })).toBe('establish');
    expect(decideWakeAction({ ...unknown, remoteVersion: 9 })).toBe('needs-pull');
    // Never repair on an unknown baseline: there is no baseline to be torn.
    for (const remoteVersion of [null, 0, 3, 9]) {
      expect(decideWakeAction({ ...unknown, remoteVersion })).not.toBe('repair');
    }
  });

  it('locked, unconfigured, syncing and the paywall still win over every combination', () => {
    for (const localDirty of [false, true]) {
      for (const localChanged of [false, true]) {
        const on = { ...base, localDirty, localChanged, remoteVersion: 9 };
        expect(decideWakeAction({ ...on, unlocked: false })).toBe('none');
        expect(decideWakeAction({ ...on, configured: false })).toBe('none');
        expect(decideWakeAction({ ...on, status: 'syncing' })).toBe('none');
        expect(decideWakeAction({ ...on, status: 'error', errorKind: 'subscription-required' })).toBe('none');
        expect(decideWakeAction({ ...on, status: 'error', errorKind: 'not-enabled' })).toBe('none');
      }
    }
  });
});

/**
 * A two-device world driven through the SHIPPED pure decisions
 * (decideWakeAction, decideRepair, vaultUnchangedSinceSync, parse/serialize),
 * with a fake SecureStore whose baseline write can be made to throw exactly
 * once. That single throw is the whole defect now that the baseline is one
 * value.
 *
 * The claim under test is about the SERVER: the other device's committed write
 * must still be there afterwards.
 */
function makeWorld(options: { serverContent: string; serverVersion: number; phoneFile: string }) {
  // A stand-in hash: hex, 64 chars, and distinct per content, which is all the
  // decisions look at (parseSyncBaseline rejects anything that is not a hash).
  const shaOf = (content: string) => Buffer.from(content, 'utf8').toString('hex').padEnd(64, '0').slice(0, 64);
  const server = { version: options.serverVersion, content: options.serverContent };
  const phone = { file: options.phoneFile };
  const store = { baseline: null as string | null, dirty: false };
  let failNextBaselineWrite = false;
  const actions: string[] = [];

  function writeBaseline(next: SyncBaseline): void {
    if (failNextBaselineWrite) {
      failNextBaselineWrite = false;
      // One SecureStore setItemAsync throw. The device locking mid-wake does it.
      throw new Error('SecureStore write failed');
    }
    store.baseline = serializeSyncBaseline(next);
  }

  /** The gated install, in the order installPulledBlob runs it: bytes, dirty, baseline. */
  function install(): void {
    phone.file = server.content;
    store.dirty = false;
    writeBaseline({ version: server.version, sha: shaOf(server.content), generation: null, pendingStampSha: null });
  }

  /** A user edit: the flag is set under the gate BEFORE the save, then the bytes move. */
  function edit(content: string): void {
    store.dirty = true;
    phone.file = content;
  }

  function wake(): string {
    const baseline = parseSyncBaseline(store.baseline);
    const currentSha = shaOf(phone.file);
    const action = decideWakeAction({
      unlocked: true,
      configured: true,
      status: 'idle',
      localDirty: store.dirty,
      localChanged: !vaultUnchangedSinceSync(baseline?.sha ?? null, currentSha),
      baselineKnown: (baseline?.sha ?? null) !== null,
      remoteVersion: server.version,
      lastSyncedVersion: baseline?.version ?? 0,
    });
    actions.push(action);
    if (action === 'pull') {
      install();
    } else if (action === 'clear-dirty') {
      store.dirty = false;
    } else if (action === 'repair') {
      if (decideRepair(shaOf(server.content), currentSha) === 'record-baseline') {
        writeBaseline({ version: server.version, sha: currentSha, generation: null, pendingStampSha: null });
      } else {
        install();
      }
    } else if (action === 'retry-push') {
      finishPush(pushPrepared());
    }
    return action;
  }

  /**
   * The upload half: the bytes are read and hashed under the gate, the gate is
   * RELEASED, and the PUT goes out. On a 409 the M6-2 last-writer-wins re-push
   * puts the phone's bytes on the server either way. This is the move that must
   * not happen for a vault holding nothing the user wrote.
   */
  function pushPrepared(): { sha: string; version: number } {
    const sha = shaOf(phone.file);
    server.content = phone.file;
    server.version += 1;
    return { sha, version: server.version };
  }

  /** The bookkeeping after the server accepts, in the shipped order and with its guard. */
  function finishPush(accepted: { sha: string; version: number }): void {
    // Only if the accepted bytes are still the bytes on disk: a save that
    // landed during the upload owns the flag.
    if (shaOf(phone.file) === accepted.sha) store.dirty = false;
    writeBaseline({ version: accepted.version, sha: accepted.sha, generation: null, pendingStampSha: null });
  }

  return {
    server,
    phone,
    store,
    actions,
    wake,
    edit,
    shaOf,
    pushPrepared,
    finishPush,
    failBaselineWriteOnce: () => {
      failNextBaselineWrite = true;
    },
  };
}

describe('D1: a wake pull whose baseline write fails must NOT push the installed bytes back', () => {
  it('repairs from the server, and the other device\'s write is still there', () => {
    // The phone is in sync at version 3. The Mac then commits a write: the
    // server is at version 4 holding "mac-write".
    const world = makeWorld({ serverContent: 'mac-write', serverVersion: 4, phoneFile: 'shared-v3' });
    world.store.baseline = serializeSyncBaseline({
      version: 3,
      sha: world.shaOf('shared-v3'),
      generation: 2,
      pendingStampSha: null,
    });

    // Wake 1: clean and behind, so it fast-forwards. The bytes land, and then
    // the baseline write throws (the device locked).
    world.failBaselineWriteOnce();
    expect(() => world.wake()).toThrow(/SecureStore/);
    expect(world.actions).toEqual(['pull']);
    expect(world.phone.file).toBe('mac-write'); // the install happened
    expect(parseSyncBaseline(world.store.baseline)?.sha).toBe(world.shaOf('shared-v3')); // TORN: names the old bytes

    // Wake 2: the bytes moved but the user wrote nothing. This is the wake that
    // used to push, 409, and roll the Mac's write off the server.
    expect(world.wake()).toBe('repair');
    expect(world.actions).not.toContain('retry-push');
    // THE CLAIM: the Mac's committed write is still on the server, untouched,
    // and the server version never moved.
    expect(world.server).toEqual({ version: 4, content: 'mac-write' });
    // And the baseline is healed with no network write, so the phone settles.
    expect(parseSyncBaseline(world.store.baseline)).toEqual({
      version: 4,
      sha: world.shaOf('mac-write'),
      generation: null,
      pendingStampSha: null,
    });
    expect(world.wake()).toBe('none');
  });

  it('a REAL unpushed edit still pushes: the fix does not swallow the user\'s write', () => {
    const world = makeWorld({ serverContent: 'shared-v3', serverVersion: 3, phoneFile: 'shared-v3' });
    world.store.baseline = serializeSyncBaseline({
      version: 3,
      sha: world.shaOf('shared-v3'),
      generation: 2,
      pendingStampSha: null,
    });
    world.edit('phone-memory'); // dirty set under the gate, before the save
    expect(world.wake()).toBe('retry-push');
    expect(world.server).toEqual({ version: 4, content: 'phone-memory' });
    expect(world.wake()).toBe('none');
  });

  it('a push that landed with only its dirty-flag write lost clears the flag, without a network call', () => {
    const world = makeWorld({ serverContent: 'phone-memory', serverVersion: 4, phoneFile: 'phone-memory' });
    world.store.baseline = serializeSyncBaseline({
      version: 4,
      sha: world.shaOf('phone-memory'),
      generation: 3,
      pendingStampSha: null,
    });
    world.store.dirty = true; // the flag write failed after the baseline landed
    expect(world.wake()).toBe('clear-dirty');
    expect(world.server).toEqual({ version: 4, content: 'phone-memory' }); // no push
    expect(world.store.dirty).toBe(false);
    expect(world.wake()).toBe('none');
  });
});

describe('a save that lands DURING a push keeps its unpushed flag', () => {
  it('the accepted push does not clear the later save\'s flag, and the next wake pushes it', () => {
    // The gate is released before the PUT, so a save can land while it is in
    // flight. If the push's bookkeeping clears that save's flag, the next wake
    // sees moved bytes with nothing dirty, calls it a torn baseline, and
    // fast-forwards the server's copy over the save.
    const world = makeWorld({ serverContent: 'shared-v3', serverVersion: 3, phoneFile: 'shared-v3' });
    world.store.baseline = serializeSyncBaseline({
      version: 3,
      sha: world.shaOf('shared-v3'),
      generation: 2,
      pendingStampSha: null,
    });
    world.edit('A');
    const accepted = world.pushPrepared(); // bytes read and uploaded; gate released
    world.edit('B'); // the save lands while the PUT is in flight
    world.finishPush(accepted); // the server accepted A's bytes
    expect(world.store.dirty).toBe(true); // B's flag survives

    expect(world.wake()).toBe('retry-push');
    expect(world.server.content).toBe('B');
    expect(world.phone.file).toBe('B');
    expect(world.wake()).toBe('none');
  });
});

describe('E1: a torn baseline while the server has moved on again fast-forwards', () => {
  it('installs the server copy instead of pushing, and the server is never written', () => {
    const world = makeWorld({ serverContent: 'mac-write', serverVersion: 4, phoneFile: 'shared-v3' });
    world.store.baseline = serializeSyncBaseline({
      version: 3,
      sha: world.shaOf('shared-v3'),
      generation: 2,
      pendingStampSha: null,
    });
    world.failBaselineWriteOnce();
    expect(() => world.wake()).toThrow(/SecureStore/);

    // The Mac commits again while the phone sits torn: the server's sha no
    // longer equals the phone's file, so recording the baseline would be a lie.
    world.server.content = 'mac-write-2';
    world.server.version = 5;

    expect(world.wake()).toBe('repair');
    expect(world.actions).not.toContain('retry-push');
    // Nothing was pushed; the phone fast-forwarded onto the Mac's newer write.
    expect(world.server).toEqual({ version: 5, content: 'mac-write-2' });
    expect(world.phone.file).toBe('mac-write-2');
    expect(parseSyncBaseline(world.store.baseline)?.version).toBe(5);
    expect(world.wake()).toBe('none');
  });
});

describe('the pending stamp: a failed establish with no baseline bumps exactly once', () => {
  const sha = (n: string) => n.repeat(64).slice(0, 64);

  it('nextPushGenerationWithPending does not re-bump bytes an earlier attempt stamped', () => {
    // No baseline, nothing stamped yet: bump.
    expect(
      nextPushGenerationWithPending({ currentStamp: 5, lastSyncGeneration: null, currentSha: sha('a'), pendingStampSha: null }),
    ).toBe(6);
    // The same bytes an earlier attempt stamped: do not bump again.
    expect(
      nextPushGenerationWithPending({ currentStamp: 6, lastSyncGeneration: null, currentSha: sha('a'), pendingStampSha: sha('a') }),
    ).toBeNull();
    // A real save moved the file: bump once for the new logical push.
    expect(
      nextPushGenerationWithPending({ currentStamp: 6, lastSyncGeneration: null, currentSha: sha('b'), pendingStampSha: sha('a') }),
    ).toBe(7);
    // With a baseline the pending stamp is irrelevant: nextPushGeneration rules.
    expect(
      nextPushGenerationWithPending({ currentStamp: 5, lastSyncGeneration: 5, currentSha: sha('a'), pendingStampSha: sha('a') }),
    ).toBe(6);
    expect(
      nextPushGenerationWithPending({ currentStamp: 7, lastSyncGeneration: 5, currentSha: sha('a'), pendingStampSha: null }),
    ).toBeNull();
    // No file to hash: fall back to the old rule rather than skipping a bump.
    expect(
      nextPushGenerationWithPending({ currentStamp: 5, lastSyncGeneration: null, currentSha: null, pendingStampSha: sha('a') }),
    ).toBe(6);
  });

  it('three failed establishes leave the stamp one above where it started', async () => {
    const phone = fakePhone({ stamp: 5, lastSyncGeneration: null });
    for (let i = 0; i < 3; i += 1) {
      await expect(runSyncAfterSave(phone.ports(['fail', 'fail', 'fail']))).rejects.toThrow(/HTTP 500/);
      expect(phone.disk.stamp).toBe(6);
      expect(phone.disk.lastSyncGeneration).toBeNull();
    }
    // The fourth attempt lands: the baseline is recorded and the pending stamp
    // is cleared, so the NEXT logical push bumps again, once.
    const event = await runSyncAfterSave(phone.ports(['fail', 'fail', 'fail', 9, 10]));
    expect(event).toEqual({ type: 'synced', version: 9 });
    expect(phone.disk).toMatchObject({ stamp: 6, lastSyncGeneration: 6, pendingStampSha: null });
    await runSyncAfterSave(phone.ports(['fail', 'fail', 'fail', 9, 10]));
    expect(phone.disk).toMatchObject({ stamp: 7, lastSyncGeneration: 7 });
  });
});
