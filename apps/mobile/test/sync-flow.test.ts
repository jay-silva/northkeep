import { describe, expect, it, vi } from 'vitest';
import {
  conflictRepushBaseVersion,
  conflictRepushSyncGeneration,
  decideWakeAction,
  localBytesMoved,
  initialSyncState,
  syncAgeLabel,
  syncAgeLine,
  isSyncing,
  pushRequiresConflictRecovery,
  reduceSync,
  runSyncAfterSave,
  syncStatusLabel,
  type PushResultLike,
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
    expect(ports.saveBaseVersion).toHaveBeenCalledWith(3, undefined); // no sha from the test port; the phone hashes the file instead
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

  it('bytes decide: a vault that does not hash to the post-sync baseline pushes, never pulls', () => {
    // The onboarding path from the second adversarial review: memories saved
    // before sync was configured (localDirty never set on the old code), first
    // push failed on the paywall, the Mac pushed v4, the phone reopens.
    expect(
      decideWakeAction({ ...ready, status: 'error', errorKind: undefined, localDirty: false, localChanged: true, lastSyncedVersion: 0, remoteVersion: 4 }),
    ).toBe('retry-push');
    expect(decideWakeAction({ ...ready, localChanged: true, remoteVersion: 9 })).toBe('retry-push');
    expect(decideWakeAction({ ...ready, localChanged: true, remoteVersion: null })).toBe('retry-push');
    expect(decideWakeAction({ ...ready, localChanged: true, status: 'idle', remoteVersion: 9 })).toBe('retry-push');
    // Paywall and private beta still win: the user acts, not a timer.
    expect(decideWakeAction({ ...ready, localChanged: true, status: 'error', errorKind: 'subscription-required' })).toBe('none');
    expect(decideWakeAction({ ...ready, localChanged: true, status: 'error', errorKind: 'not-enabled' })).toBe('none');
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
      expect(decideWakeAction({ ...ready, status: 'error', errorKind, localDirty: true, remoteVersion: 9 })).toBe('retry-push');
    }
  });

  it('retries the push when a local save is still unpushed, even if the server looks ahead', () => {
    expect(decideWakeAction({ ...ready, localDirty: true, remoteVersion: 9 })).toBe('retry-push');
    expect(decideWakeAction({ ...ready, status: 'idle', localDirty: true, remoteVersion: null })).toBe('retry-push');
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
