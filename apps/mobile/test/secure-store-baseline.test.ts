import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The ONE baseline value (ADR 0044, sixth review kill shot), exercised against
 * the real secure-store module over an in-memory keychain. Everything here is
 * about what SURVIVES: a wipe must leave nothing that can rebuild a stale
 * baseline on a re-onboarded device, and the legacy three-key layout must fold
 * into the single value exactly once.
 *
 * The Expo module is faked because it is native; the module under test is not.
 */
const keychain = new Map<string, string>();
const setItemAsync = vi.fn(async (key: string, value: string) => {
  keychain.set(key, value);
});

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-this-device-only',
  setItemAsync,
  getItemAsync: async (key: string) => keychain.get(key) ?? null,
  deleteItemAsync: async (key: string) => {
    keychain.delete(key);
  },
}));

const {
  loadSyncBaseline,
  saveSyncBaseline,
  loadLastSyncSha,
  loadLastSyncVersion,
  loadLastSyncGeneration,
  savePendingStampSha,
  saveConnectorPairedAt,
  loadConnectorPairedAt,
  saveConnectorServerUrl,
  wipeAllSecrets,
} = await import('../src/lib/secure-store.js');
const { DEFAULT_CONNECTOR_SERVER_URL } = await import('../src/lib/connect-flow.js');

const SHA = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

/** Every key this module can leave behind that a later read could interpret. */
const SYNC_KEYS = [
  'nk.sync_baseline',
  'nk.sync_last_version',
  'nk.sync_last_sha',
  'nk.sync_last_generation',
  'nk.sync_last_synced_at',
  'nk.sync_local_dirty',
];

beforeEach(() => {
  keychain.clear();
  setItemAsync.mockClear();
});

describe('wipeAllSecrets leaves nothing that can rebuild a baseline', () => {
  it('a wipe then a load reads null, even with the legacy keys present', async () => {
    // A device that never read the baseline since upgrading still holds the
    // legacy three. If a wipe left them, migrateLegacyBaseline would hand the
    // re-onboarded device a stale version/sha/generation on its first read.
    keychain.set('nk.sync_last_version', '5');
    keychain.set('nk.sync_last_sha', SHA);
    keychain.set('nk.sync_last_generation', '3');
    keychain.set('nk.sync_local_dirty', '1');
    keychain.set('nk.sync_last_synced_at', new Date().toISOString());

    await wipeAllSecrets();

    for (const key of SYNC_KEYS) expect(keychain.has(key)).toBe(false);
    expect(await loadSyncBaseline()).toBeNull();
    expect(await loadLastSyncSha()).toBeNull();
    expect(await loadLastSyncGeneration()).toBeNull();
    expect(await loadLastSyncVersion()).toBe(0);
  });

  it('a wipe after the new key is written reads null too, and nothing re-migrates', async () => {
    await saveSyncBaseline({ version: 9, sha: SHA, generation: 4, pendingStampSha: OTHER });
    await wipeAllSecrets();
    expect(await loadSyncBaseline()).toBeNull();
    // A second read must not resurrect anything either (no legacy source left).
    expect(await loadSyncBaseline()).toBeNull();
    for (const key of SYNC_KEYS) expect(keychain.has(key)).toBe(false);
  });
});

describe('the baseline is written in ONE call, and the legacy keys fold in once', () => {
  it('saveSyncBaseline is a single setItemAsync: version, sha and generation cannot tear', async () => {
    await saveSyncBaseline({ version: 7, sha: SHA, generation: 2, pendingStampSha: null });
    expect(setItemAsync).toHaveBeenCalledTimes(1);
    expect(setItemAsync.mock.calls[0]![0]).toBe('nk.sync_baseline');
    expect(await loadSyncBaseline()).toEqual({ version: 7, sha: SHA, generation: 2, pendingStampSha: null });
  });

  it('the first load of a phone on the old layout assembles the value and deletes the legacy keys', async () => {
    keychain.set('nk.sync_last_version', '5');
    keychain.set('nk.sync_last_sha', SHA);
    keychain.set('nk.sync_last_generation', '3');

    expect(await loadSyncBaseline()).toEqual({ version: 5, sha: SHA, generation: 3, pendingStampSha: null });
    expect(keychain.has('nk.sync_baseline')).toBe(true);
    expect(keychain.has('nk.sync_last_version')).toBe(false);
    expect(keychain.has('nk.sync_last_sha')).toBe(false);
    expect(keychain.has('nk.sync_last_generation')).toBe(false);

    // Migration is once: the second read comes straight from the new key.
    setItemAsync.mockClear();
    expect(await loadSyncBaseline()).toEqual({ version: 5, sha: SHA, generation: 3, pendingStampSha: null });
    expect(setItemAsync).not.toHaveBeenCalled();
  });

  it('a legacy phone with a version but no hash keeps "baseline unknown" rather than inventing one', async () => {
    keychain.set('nk.sync_last_version', '5');
    const baseline = await loadSyncBaseline();
    expect(baseline).toEqual({ version: 5, sha: null, generation: null, pendingStampSha: null });
    // sha null is what decideWakeAction reads as baselineKnown: false, which
    // routes to establish/needs-pull and never to a push.
    expect(await loadLastSyncSha()).toBeNull();
  });

  it('a corrupt stored value reads as null, and a garbled legacy field does not poison the rest', async () => {
    keychain.set('nk.sync_baseline', '{not json');
    expect(await loadSyncBaseline()).toBeNull();
    keychain.set('nk.sync_baseline', JSON.stringify({ version: 3, sha: 'nope', generation: 1 }));
    expect(await loadSyncBaseline()).toBeNull();

    keychain.clear();
    keychain.set('nk.sync_last_version', 'garbage');
    keychain.set('nk.sync_last_sha', SHA);
    keychain.set('nk.sync_last_generation', '-2');
    expect(await loadSyncBaseline()).toEqual({ version: 0, sha: SHA, generation: null, pendingStampSha: null });
  });

  it('the pending stamp lives inside the baseline: no separate key to leak past a wipe', async () => {
    await saveSyncBaseline({ version: 2, sha: SHA, generation: null, pendingStampSha: null });
    await savePendingStampSha(OTHER);
    expect([...keychain.keys()].filter((k) => k.startsWith('nk.sync'))).toEqual(['nk.sync_baseline']);
    expect((await loadSyncBaseline())?.pendingStampSha).toBe(OTHER);
    await wipeAllSecrets();
    expect(await loadSyncBaseline()).toBeNull();
  });

  // ADR 0050 Decision 5: a pairing belongs to one connector server.
  it('keeps the pairing marker when the connector server is unchanged', async () => {
    await saveConnectorPairedAt(new Date('2026-09-19T00:00:00.000Z'));
    // Nothing stored means this phone is on the default, which is what it paired with.
    await saveConnectorServerUrl(DEFAULT_CONNECTOR_SERVER_URL);
    expect(await loadConnectorPairedAt()).toBe('2026-09-19T00:00:00.000Z');
    await saveConnectorServerUrl(DEFAULT_CONNECTOR_SERVER_URL);
    expect(await loadConnectorPairedAt()).toBe('2026-09-19T00:00:00.000Z');
  });

  it('drops the pairing marker when the connector server changes, and on a wipe', async () => {
    await saveConnectorPairedAt();
    await saveConnectorServerUrl('https://connector.example.test');
    expect(await loadConnectorPairedAt()).toBeNull();

    await saveConnectorPairedAt();
    await wipeAllSecrets();
    expect(await loadConnectorPairedAt()).toBeNull();
  });
});
