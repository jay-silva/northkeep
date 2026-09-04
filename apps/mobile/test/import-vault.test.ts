import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ADR 0044, SEVENTH REVIEW KILL SHOT: a hand-imported vault was a write that
 * left no trace. `importVaultFile` called writeAtomic outside the gate with no
 * dirty flag and no baseline change, which is byte-for-byte the shape the sixth
 * review's repair branch treats as a torn baseline: bytes moved, nothing dirty.
 * The next wake decided 'repair' and fast-forwarded the server's copy over the
 * import while the pill read Synced.
 *
 * Two levels here, because the bug lived between them:
 *   (a) the DECISION, with the exact inputs runWake's `gather` builds, so the
 *       proof is that the wake pushes and never repairs or pulls;
 *   (b) the REAL import module, over a faked keychain and a faked filesystem
 *       (the pattern in secure-store-baseline.test.ts): the flag is actually
 *       set, it is set BEFORE the bytes land, and the write happens with the
 *       vault gate HELD.
 *
 * The Expo modules and the native platform seam are faked because they are
 * native; import-vault.ts, secure-store.ts, sync-flow.ts and vault-gate.ts are
 * the real modules.
 */

// --- the faked keychain (same shape as secure-store-baseline.test.ts) --------
const keychain = new Map<string, string>();
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked-this-device-only',
  setItemAsync: async (key: string, value: string) => {
    keychain.set(key, value);
  },
  getItemAsync: async (key: string) => keychain.get(key) ?? null,
  deleteItemAsync: async (key: string) => {
    keychain.delete(key);
  },
}));

// --- the faked filesystem ---------------------------------------------------
const files = new Map<string, Buffer>();
const DOCUMENT_DIR = '/doc';
const CACHE_DIR = '/cache';

vi.mock('expo-file-system', () => {
  class File {
    uri: string;
    constructor(a: string | { toString(): string }, b?: string) {
      this.uri = b === undefined ? String(a) : `${String(a)}/${b}`;
    }
    get exists(): boolean {
      return files.has(this.uri);
    }
    async bytes(): Promise<Uint8Array> {
      return new Uint8Array(files.get(this.uri) ?? Buffer.alloc(0));
    }
    delete(): void {
      files.delete(this.uri);
    }
  }
  return { File, Paths: { document: DOCUMENT_DIR, cache: CACHE_DIR } };
});

// --- the faked document picker ----------------------------------------------
let picked: { canceled: boolean; assets: { uri: string }[] } = { canceled: true, assets: [] };
vi.mock('expo-document-picker', () => ({
  getDocumentAsync: async () => picked,
}));

// --- the faked platform seam ------------------------------------------------
/** Order of the calls import-vault makes, so "dirty BEFORE the write" is provable. */
const calls: string[] = [];
/** True when writeAtomic ran while the vault gate was held. */
let wroteUnderGate: boolean | null = null;

vi.mock('@northkeep/core', () => ({
  getPlatform: () => ({
    storage: {
      exists: (path: string) => files.has(path),
      readBytes: (path: string) => files.get(path)!,
      writeAtomic: (path: string, bytes: Buffer) => {
        // The storage seam contract: the displaced image goes to `${path}.bak`.
        const existing = files.get(path);
        if (existing) files.set(`${path}.bak`, existing);
        files.set(path, Buffer.from(bytes));
        calls.push(`write:${path}`);
        wroteUnderGate = vaultGate.held;
      },
    },
  }),
}));

const { importVaultFile } = await import('../src/lib/import-vault.js');
const { loadLocalDirty, loadSyncBaseline, saveLocalDirty, saveSyncBaseline } = await import(
  '../src/lib/secure-store.js'
);
const { vaultGate } = await import('../src/lib/vault-gate.js');
const { decideWakeAction, vaultUnchangedSinceSync } = await import('../src/lib/sync-flow.js');
type WakeInput = Parameters<typeof decideWakeAction>[0];

const VAULT_PATH = `${DOCUMENT_DIR}/vault.nkv`;
const PICKED_URI = `${CACHE_DIR}/AirDropped.nkv`;

/** A minimally well-formed .nkv: the "NKV1" magic import-vault checks for. */
function nkv(tag: string, size = 128): Buffer {
  const blob = Buffer.alloc(size, 0);
  blob.write('NKV1', 0, 'ascii');
  blob.write(tag, 8, 'ascii');
  return blob;
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

beforeEach(() => {
  keychain.clear();
  files.clear();
  calls.length = 0;
  wroteUnderGate = null;
  picked = { canceled: true, assets: [] };
});

/**
 * Exactly what runWake's `gather` builds, from the two persisted values and the
 * hash of the file on disk. Nothing is invented here: if this and gather ever
 * disagree, the disagreement is the bug.
 */
async function gatherWakeInput(remoteVersion: number | null): Promise<WakeInput> {
  const baseline = await loadSyncBaseline();
  const lastSha = baseline?.sha ?? null;
  const currentSha = files.has(VAULT_PATH) ? sha256Hex(files.get(VAULT_PATH)!) : null;
  return {
    unlocked: true,
    configured: true,
    status: 'idle',
    localDirty: await loadLocalDirty(),
    localChanged: !vaultUnchangedSinceSync(lastSha, currentSha),
    baselineKnown: lastSha !== null,
    lastSyncedVersion: baseline?.version ?? 0,
    remoteVersion,
  };
}

describe('an import is a user write: the next wake PUSHES it', () => {
  it('phone with a synced vault: import then wake decides retry-push, never repair or pull', async () => {
    // A vault that is exactly what the server holds: synced, clean, baseline known.
    const synced = nkv('synced');
    files.set(VAULT_PATH, synced);
    await saveSyncBaseline({ version: 7, sha: sha256Hex(synced), generation: 3, pendingStampSha: null });
    await saveLocalDirty(false);
    // Before the fix this shape decided 'repair', and repair fast-forwarded the
    // server's copy straight over the imported vault.
    expect(decideWakeAction(await gatherWakeInput(7))).toBe('none');

    files.set(PICKED_URI, nkv('imported'));
    picked = { canceled: false, assets: [{ uri: PICKED_URI }] };
    expect(await importVaultFile()).toEqual({ ok: true, bytes: 128 });

    // The server is at the version we last synced: nothing is "ahead", and the
    // bytes on disk are not the ones the baseline names.
    const action = decideWakeAction(await gatherWakeInput(7));
    expect(action).toBe('retry-push');
    expect(action).not.toBe('repair');
    expect(action).not.toBe('pull');
  });

  it('still pushes when the server has moved ahead (a pull would bury the import)', async () => {
    const synced = nkv('synced');
    files.set(VAULT_PATH, synced);
    await saveSyncBaseline({ version: 7, sha: sha256Hex(synced), generation: 3, pendingStampSha: null });
    files.set(PICKED_URI, nkv('imported'));
    picked = { canceled: false, assets: [{ uri: PICKED_URI }] };
    await importVaultFile();

    expect(decideWakeAction(await gatherWakeInput(9))).toBe('retry-push');
  });

  it('fresh phone (no vault, no baseline): the first wake pushes rather than pulls', async () => {
    files.set(PICKED_URI, nkv('imported'));
    picked = { canceled: false, assets: [{ uri: PICKED_URI }] };
    await importVaultFile();

    // baselineKnown is false here, but dirty is checked FIRST, so the unknown
    // baseline never routes this to 'needs-pull' or an establish-with-no-bytes.
    const input = await gatherWakeInput(null);
    expect(input.baselineKnown).toBe(false);
    expect(decideWakeAction(input)).toBe('retry-push');
    expect(decideWakeAction({ ...input, remoteVersion: 4 })).toBe('retry-push');
  });

  it('the baseline is left intact, so the push extends the right version and stamps above it', async () => {
    const synced = nkv('synced');
    files.set(VAULT_PATH, synced);
    await saveSyncBaseline({ version: 7, sha: sha256Hex(synced), generation: 3, pendingStampSha: null });
    files.set(PICKED_URI, nkv('imported'));
    picked = { canceled: false, assets: [{ uri: PICKED_URI }] };
    await importVaultFile();

    const baseline = await loadSyncBaseline();
    expect(baseline?.version).toBe(7); // the push's X-Base-Version
    expect(baseline?.generation).toBe(3); // nextPushGeneration stamps 4, above what we synced
    expect(baseline?.sha).toBe(sha256Hex(synced)); // names the DISPLACED bytes: "moved"
  });

  it('REGRESSION: the pre-fix import (bytes, no dirty flag) is what decided repair', async () => {
    // The shape the kill shot exploited, reproduced by hand: writeAtomic with
    // no flag. If this ever stops reading 'repair', the fix above is being
    // tested against a decision rule that no longer punishes a silent write,
    // and the test below stops meaning anything.
    const synced = nkv('synced');
    files.set(VAULT_PATH, synced);
    await saveSyncBaseline({ version: 7, sha: sha256Hex(synced), generation: 3, pendingStampSha: null });
    await saveLocalDirty(false);
    files.set(VAULT_PATH, nkv('imported')); // the old ungated, unflagged write

    expect(decideWakeAction(await gatherWakeInput(7))).toBe('repair');
  });

  it('an import whose bytes the server already holds pushes nothing (clear-dirty)', async () => {
    // Not a hole: the imported file hashes to the baseline, so the server holds
    // exactly these bytes and there is nothing to push.
    const same = nkv('same');
    files.set(VAULT_PATH, same);
    await saveSyncBaseline({ version: 7, sha: sha256Hex(same), generation: 3, pendingStampSha: null });
    files.set(PICKED_URI, same);
    picked = { canceled: false, assets: [{ uri: PICKED_URI }] };
    await importVaultFile();

    expect(decideWakeAction(await gatherWakeInput(7))).toBe('clear-dirty');
  });
});

describe('importVaultFile, through the real secure-store', () => {
  it('sets the dirty flag, and sets it BEFORE the bytes land', async () => {
    files.set(PICKED_URI, nkv('imported'));
    picked = { canceled: false, assets: [{ uri: PICKED_URI }] };

    expect(await loadLocalDirty()).toBe(false);
    await importVaultFile();

    expect(await loadLocalDirty()).toBe(true);
    // If the write landed first and the flag write then failed, the phone would
    // be back in the kill shot's state: moved bytes, nothing dirty.
    expect(calls).toEqual([`write:${VAULT_PATH}`]);
    expect(keychain.get('nk.sync_local_dirty')).toBe('1');
  });

  it('writes the vault file with the vault gate HELD', async () => {
    files.set(VAULT_PATH, nkv('old'));
    files.set(PICKED_URI, nkv('imported'));
    picked = { canceled: false, assets: [{ uri: PICKED_URI }] };
    await importVaultFile();

    expect(wroteUnderGate).toBe(true);
    expect(vaultGate.held).toBe(false); // and released afterwards
    expect(files.get(VAULT_PATH)!.subarray(8, 16).toString('ascii').replace(/\0+$/, '')).toBe('imported');
    // writeAtomic's rolling copy still catches a bad import of the right shape.
    expect(files.get(`${VAULT_PATH}.bak`)!.subarray(8, 16).toString('ascii').replace(/\0+$/, '')).toBe('old');
  });

  it('runs afterInstall inside the same gated section, after the write', async () => {
    files.set(PICKED_URI, nkv('imported'));
    picked = { canceled: false, assets: [{ uri: PICKED_URI }] };
    let heldDuringAfterInstall: boolean | null = null;
    let sawInstalledBytes = false;
    await importVaultFile({
      afterInstall: () => {
        heldDuringAfterInstall = vaultGate.held;
        sawInstalledBytes = files.has(VAULT_PATH);
      },
    });
    expect(heldDuringAfterInstall).toBe(true);
    expect(sawInstalledBytes).toBe(true);
  });

  it('a canceled pick and a non-vault file touch neither the flag nor the file', async () => {
    picked = { canceled: true, assets: [] };
    expect(await importVaultFile()).toEqual({ ok: false, reason: 'canceled' });

    files.set(PICKED_URI, Buffer.from('not a vault at all, but long enough', 'ascii'));
    picked = { canceled: false, assets: [{ uri: PICKED_URI }] };
    expect(await importVaultFile()).toEqual({ ok: false, reason: 'not-a-vault' });

    expect(await loadLocalDirty()).toBe(false);
    expect(files.has(VAULT_PATH)).toBe(false);
    expect(calls).toEqual([]);
  });
});
