import { describe, expect, it, vi } from 'vitest';
import {
  conflictRepushBaseVersion,
  initialSyncState,
  isSyncing,
  pushRequiresConflictRecovery,
  reduceSync,
  runSyncAfterSave,
  syncStatusLabel,
  type PushResultLike,
  type SyncAfterSavePorts,
  type SyncState,
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
    expect(ports.saveBaseVersion).toHaveBeenCalledWith(3);
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
    expect(calls).toEqual(['push(2)', 'fetchRemote', 'verifyRemoteOpens', 'stashRemote', 'push(5)', 'saveBaseVersion(6)']);
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
