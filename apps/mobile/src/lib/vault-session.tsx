import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as LocalAuthentication from 'expo-local-authentication';
import {
  KDF_INTERACTIVE,
  Vault,
  deriveMasterKey,
  generateDeviceSecret,
  getPlatform,
  memzero,
  type MemoryEntry,
  type RememberInput,
  type RetrieveOptions,
  type ScoredEntry,
} from '@northkeep/core';
import { deriveSyncCreds } from '@northkeep/sync';
import { DEMO_MEMORIES, DEMO_PASSPHRASE } from './demo-vault';
import { deleteIfExists, demoVaultPath, recoverVaultFileIfMissing, vaultPath } from './paths';
import {
  biometricUnlockEnabled,
  cacheMasterKeyHex,
  clearCachedMasterKey,
  loadDeviceSecretHex,
  loadLastSyncVersion,
  loadSyncServerUrl,
  readCachedMasterKeyHex,
  saveDeviceSecretHex,
  saveLastSyncVersion,
  wipeAllSecrets,
} from './secure-store';
import {
  fetchRemoteBlob,
  pullVaultMobile,
  pushVaultMobile,
  stashRecoverableBak,
  verifyBlobOpensWithKey,
  type VerifiedRemoteBlob,
} from './sync';
import { classifySyncError } from './sync-errors';
import { initialSyncState, reduceSync, runSyncAfterSave, type SyncEvent, type SyncState } from './sync-flow';

/**
 * The unlock-session state machine for M6-1 (link, unlock, browse). Holds the
 * open Vault, an in-memory copy of the master key (needed for pull-verify and
 * the optional biometric cache), and the decrypted entry list.
 *
 * Key hygiene: the session key copy is zeroed via memzero on every lock;
 * Vault.close() zeroes the vault's own key. The device secret is loaded from
 * SecureStore per operation and zeroed after use, never held across renders.
 *
 * NEEDS ON-DEVICE VALIDATION: the synchronous Argon2id derive (MODERATE, 256
 * MiB) blocks the JS thread for the duration of unlock; acceptable for M6-1,
 * profiled in M6-5. Biometric availability/enrollment paths are device-only.
 */

export type SessionStatus = 'loading' | 'unlinked' | 'locked' | 'unlocked';

export interface VaultSession {
  status: SessionStatus;
  /** Live entries, newest first (mirrors the web GUI's list().reverse()). */
  entries: MemoryEntry[];
  /** True when a biometric-gated cached key exists for the unlock screen to offer. */
  biometricCacheEnabled: boolean;
  /** Short account id derived from the device secret (Settings display). */
  accountIdShort: string | null;
  /**
   * M6-2b demo mode. True while a synthetic, throwaway demo vault is open (the
   * "Try a demo" path). Deliberately NOT a SessionStatus value: status stays
   * 'unlinked' so the index router and lock-on-background never treat the demo
   * as a real vault. The /demo screen drives itself off this flag.
   */
  isDemo: boolean;
  linkDevice(deviceSecretHex: string): Promise<void>;
  /**
   * M6-2b create-on-phone: no Mac required. Generates a device secret ON DEVICE
   * (core generateDeviceSecret = randomBytes(32) via the platform crypto
   * provider), stores it in SecureStore, creates a brand-new empty encrypted
   * vault via core Vault.create (same logic as desktop `northkeep init`), then
   * unlocks it into the session. Mirrors the desktop init: create then open.
   */
  createVault(passphrase: string, opts?: { enableBiometricCache?: boolean }): Promise<void>;
  /**
   * M6-2b: open a built-in SAMPLE vault with synthetic memories, instantly, with
   * no passphrase, no Mac, no network. Isolated from any real vault (separate
   * cache path, ephemeral non-persisted device secret). Never syncs.
   */
  startDemo(): Promise<void>;
  /** Tear down the demo vault and delete its throwaway file. */
  exitDemo(): Promise<void>;
  unlockWithPassphrase(passphrase: string, opts?: { enableBiometricCache?: boolean }): Promise<void>;
  /** Returns false if there is no cached key or the biometric prompt was refused. */
  unlockWithBiometrics(): Promise<boolean>;
  /** clearBiometricCache: the explicit "Lock vault" action also deletes the cached key. */
  lock(opts?: { clearBiometricCache?: boolean }): Promise<void>;
  /** Pull from sync and reload; requires unlocked (the key verifies the download). */
  pullAndReload(): Promise<{ pulled: boolean }>;
  /**
   * Phase A enable-sync: run the save-then-push sequence NOW (same plumbing as
   * pushAfterSave) and return the terminal event. Throws when no device secret
   * or server URL is set, and rethrows transport errors (402/403/network) so
   * the enable-sync flow (src/lib/sync-setup-flow.ts) can classify them; the
   * loud syncState indicator is updated either way.
   */
  pushNow(): Promise<SyncEvent>;
  /** Loud sync-state indicator (M6-2, invariant #6 style): idle / syncing / synced / conflict-recovered / error. */
  syncState: SyncState;
  /**
   * M6-2 chain-correct edits. Each mutates the open Vault (remember / editMemory /
   * forget preserve the append-only hash chain), writes with save() (serialize ->
   * encrypt -> atomic write + .bak), reloads the list, then pushes with
   * X-Base-Version optimistic concurrency (409 -> last-writer-wins conflict
   * recovery). The local save always succeeds; a sync failure is surfaced via
   * syncState, never lost silently.
   */
  addMemory(input: RememberInput): Promise<MemoryEntry>;
  editMemory(id: string, patch: { content?: string; scope?: string; type?: MemoryEntry['type'] }): Promise<MemoryEntry>;
  forgetMemory(id: string): Promise<MemoryEntry>;
  reloadEntries(): void;
  /**
   * Scored keyword retrieval over the open vault (M6-3 Converse context).
   * Delegates to the core Vault.retrieve (term overlap + recency + type
   * priority); returns [] when locked. Read-only — never mutates or syncs.
   */
  retrieve(query: string, options?: RetrieveOptions): ScoredEntry[];
  /** Wipes SecureStore and the local vault file; returns to onboarding. */
  signOutWipe(): Promise<void>;
  getMemory(id: string): MemoryEntry | undefined;
}

const SessionContext = createContext<VaultSession | null>(null);

export function useVaultSession(): VaultSession {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useVaultSession must be used inside <VaultSessionProvider>.');
  return ctx;
}

export function VaultSessionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [biometricCacheEnabled, setBiometricCacheEnabled] = useState(false);
  const [accountIdShort, setAccountIdShort] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<SyncState>(() => initialSyncState());
  const [isDemo, setIsDemo] = useState(false);
  const vaultRef = useRef<Vault | null>(null);
  const masterKeyRef = useRef<Buffer | null>(null);
  // Ref mirror of isDemo so the memoized callbacks (lock, pushAfterSave) can read
  // the current value without being re-created on every demo toggle.
  const isDemoRef = useRef(false);

  // Bootstrap: linked or not?
  useEffect(() => {
    let alive = true;
    (async () => {
      const secretHex = await loadDeviceSecretHex();
      const bio = await biometricUnlockEnabled();
      if (!alive) return;
      if (secretHex) {
        setAccountIdShort(shortAccountId(secretHex));
        setStatus('locked');
      } else {
        setStatus('unlinked');
      }
      setBiometricCacheEnabled(bio);
    })().catch(() => {
      if (alive) setStatus('unlinked');
    });
    return () => {
      alive = false;
    };
  }, []);

  const closeSession = useCallback(() => {
    vaultRef.current?.close();
    vaultRef.current = null;
    if (masterKeyRef.current) {
      memzero(masterKeyRef.current);
      masterKeyRef.current = null;
    }
    setEntries([]);
  }, []);

  const reloadEntries = useCallback(() => {
    const vault = vaultRef.current;
    if (!vault) return;
    setEntries(vault.list().reverse());
  }, []);

  const openWithSessionKey = useCallback(
    (key: Buffer) => {
      // openWithKey takes ownership of (and zeroes) the buffer it gets, so the
      // session keeps its own copy for pull-verify / biometric caching.
      const sessionCopy = Buffer.from(key);
      let vault: Vault;
      try {
        vault = Vault.openWithKey(vaultPath(), key);
      } catch (err) {
        memzero(sessionCopy);
        throw err;
      }
      vaultRef.current = vault;
      masterKeyRef.current = sessionCopy;
      setEntries(vault.list().reverse());
      setStatus('unlocked');
    },
    [],
  );

  const linkDevice = useCallback(async (deviceSecretHex: string) => {
    await saveDeviceSecretHex(deviceSecretHex);
    setAccountIdShort(shortAccountId(deviceSecretHex));
    setStatus('locked');
  }, []);

  const unlockWithPassphrase = useCallback(
    async (passphrase: string, opts?: { enableBiometricCache?: boolean }) => {
      const platform = getPlatform();
      const secretHex = await loadDeviceSecretHex();
      if (!secretHex) throw new Error('This phone is not linked yet. Scan the link code from your computer first.');

      // Crash-recovery for the non-atomic mobile save window (ADR 0021 item 3):
      // if a prior save was interrupted the vault may be at .tmp/.bak, not the
      // canonical path. Restore it before deciding whether to pull.
      recoverVaultFileIfMissing();

      const path = vaultPath();
      if (!platform.storage.exists(path)) {
        // Fresh phone: pull the vault down first. No local vault exists, so no
        // key verification is needed (nothing to protect; matches desktop pullVault).
        const serverUrl = await loadSyncServerUrl();
        if (!serverUrl) {
          throw new Error(
            'No vault on this phone yet. Set your sync server in Settings, or import a vault file.',
          );
        }
        const pulled = await pullVaultMobile({ serverUrl, deviceSecretHex: secretHex, vaultPath: path });
        if (!pulled.ok) {
          throw new Error(
            'Your sync account has no vault yet. Sync from your computer first, or import a vault file.',
          );
        }
        await saveLastSyncVersion(pulled.version);
      }

      const secret = Buffer.from(secretHex, 'hex');
      let key: Buffer;
      try {
        const header = Vault.readHeader(path);
        // Argon2id runs with the params from the vault header (bounds-checked
        // in readHeader). Synchronous and heavy; see the module note.
        key = deriveMasterKey(passphrase, secret, header.salt, header.kdf);
      } finally {
        memzero(secret);
      }
      openWithSessionKey(key); // wrong passphrase throws VaultAuthError from here

      if (opts?.enableBiometricCache && masterKeyRef.current) {
        const hardware = await LocalAuthentication.hasHardwareAsync();
        const enrolled = await LocalAuthentication.isEnrolledAsync();
        if (hardware && enrolled) {
          await cacheMasterKeyHex(masterKeyRef.current.toString('hex'));
          setBiometricCacheEnabled(true);
        }
      }
    },
    [openWithSessionKey],
  );

  const unlockWithBiometrics = useCallback(async (): Promise<boolean> => {
    const hex = await readCachedMasterKeyHex(); // OS biometric prompt happens here
    if (!hex) return false;
    openWithSessionKey(Buffer.from(hex, 'hex'));
    return true;
  }, [openWithSessionKey]);

  const lock = useCallback(
    async (opts?: { clearBiometricCache?: boolean }) => {
      // The demo vault holds no secrets and no key to zero, and lock-on-background
      // calls this on every background transition. Leave the demo open so it
      // survives an app-switch; exitDemo() is the only teardown for it.
      if (isDemoRef.current) return;
      closeSession();
      if (opts?.clearBiometricCache) {
        await clearCachedMasterKey();
        setBiometricCacheEnabled(false);
      }
      setStatus((prev) => (prev === 'unlocked' ? 'locked' : prev));
    },
    [closeSession],
  );

  /**
   * M6-2b create-on-phone. Mirrors desktop `northkeep init` through the mobile
   * platform seam: generate the device secret on device, persist it to
   * SecureStore, create the empty encrypted vault with core Vault.create (fresh
   * salt -> deriveMasterKey -> platform.sqlite.createEmpty -> save via
   * storage.writeAtomic), then unlock it into the session with the existing
   * passphrase path. No hand-rolled crypto (invariant #3): every key operation
   * runs inside core.
   */
  const createVault = useCallback(
    async (passphrase: string, opts?: { enableBiometricCache?: boolean }) => {
      const platform = getPlatform();
      // A prior interrupted save may have left the vault at .tmp/.bak; restore it
      // so the "already exists" guard sees the real state before we create.
      recoverVaultFileIfMissing();
      const path = vaultPath();
      if (platform.storage.exists(path)) {
        throw new Error(
          'A vault already exists on this phone. Unlock it instead, or wipe this phone in Settings to start over.',
        );
      }
      // randomBytes(32) from the platform crypto provider (core helper).
      const secret = generateDeviceSecret(platform.crypto);
      const secretHex = secret.toString('hex');
      try {
        // Same call the desktop init uses; defaults to KDF_MODERATE. create()
        // derives the key, builds the empty schema, and writes the .nkv.
        const vault = Vault.create({ path, passphrase, deviceSecret: secret });
        vault.close();
      } finally {
        memzero(secret);
      }
      // Device secret lives only in SecureStore (WHEN_UNLOCKED_THIS_DEVICE_ONLY),
      // never in the vault blob, never logged.
      await saveDeviceSecretHex(secretHex);
      setAccountIdShort(shortAccountId(secretHex));
      setStatus('locked');
      // Re-derive and open into the session via the verified unlock path. This is
      // a second Argon2id derive; a one-time onboarding cost (see module note).
      await unlockWithPassphrase(passphrase, opts);
    },
    [unlockWithPassphrase],
  );

  /**
   * M6-2b demo. Builds a synthetic vault in the cache directory under an
   * ephemeral device secret that is NEVER written to SecureStore, seeds it with
   * the sample memories, and opens it read-only into the session. Uses
   * KDF_INTERACTIVE so it opens near-instantly (the demo is throwaway; the heavy
   * MODERATE cost only protects real vaults). Never persists a device secret and
   * never sets a sync server, so bootstrap stays 'unlinked' and nothing syncs.
   */
  const startDemo = useCallback(async () => {
    const platform = getPlatform();
    const path = demoVaultPath();
    // A prior demo may have left files behind; Vault.create refuses to overwrite.
    deleteIfExists(path);
    deleteIfExists(`${path}.bak`);
    deleteIfExists(`${path}.tmp`);
    const secret = generateDeviceSecret(platform.crypto); // ephemeral, in-memory only
    let vault: Vault;
    try {
      vault = Vault.create({
        path,
        passphrase: DEMO_PASSPHRASE,
        deviceSecret: secret,
        kdf: KDF_INTERACTIVE,
      });
    } finally {
      memzero(secret);
    }
    for (const memory of DEMO_MEMORIES) vault.remember(memory);
    vault.save();
    // Drop any prior session state (there should be none coming from onboarding).
    closeSession();
    vaultRef.current = vault;
    masterKeyRef.current = null; // no key retained for the demo
    isDemoRef.current = true;
    setIsDemo(true);
    setEntries(vault.list().reverse());
  }, [closeSession]);

  const exitDemo = useCallback(async () => {
    isDemoRef.current = false;
    setIsDemo(false);
    vaultRef.current?.close();
    vaultRef.current = null;
    setEntries([]);
    const path = demoVaultPath();
    deleteIfExists(path);
    deleteIfExists(`${path}.bak`);
    deleteIfExists(`${path}.tmp`);
  }, []);

  const pullAndReload = useCallback(async (): Promise<{ pulled: boolean }> => {
    const key = masterKeyRef.current;
    if (!vaultRef.current || !key) throw new Error('Unlock the vault before syncing.');
    const secretHex = await loadDeviceSecretHex();
    const serverUrl = await loadSyncServerUrl();
    if (!secretHex) throw new Error('This phone is not linked.');
    if (!serverUrl) throw new Error('No sync server configured. Set one in Settings.');
    const result = await pullVaultMobile({
      serverUrl,
      deviceSecretHex: secretHex,
      vaultPath: vaultPath(),
      masterKey: key,
    });
    if (!result.ok) return { pulled: false };
    await saveLastSyncVersion(result.version);
    // Reopen from the freshly written file with the held key.
    vaultRef.current.close();
    vaultRef.current = null;
    const reopenKey = Buffer.from(key);
    vaultRef.current = Vault.openWithKey(vaultPath(), reopenKey);
    reloadEntries();
    return { pulled: true };
  }, [reloadEntries]);

  /**
   * Push the just-saved local vault, resolving a two-sided conflict with the
   * last-writer-wins policy (07-MOBILE-LAUNCH-PLAN.md M6-2; see src/lib/sync-flow.ts
   * for the decision rules and the pure unit tests). The local save has already
   * happened by the time this runs, so a sync failure never loses the edit; it
   * only leaves syncState in 'error' with a recoverable local vault.
   *
   * NEEDS ON-DEVICE VALIDATION: the whole network sequence (push, the 409 branch,
   * fetch+verify+stash, re-push) has never run against a real sync server; only
   * the sync-flow decision logic is unit-tested.
   */
  /**
   * The save-then-push sequence against a known server, shared by pushAfterSave
   * (every mutation) and pushNow (the enable-sync first push). Returns the
   * terminal event; transport errors (network, 402, 403, unexpected HTTP)
   * propagate to the caller.
   */
  const runPushSequence = useCallback(
    async (serverUrl: string, secretHex: string): Promise<SyncEvent> => {
      const path = vaultPath();
      // The remote fetched during conflict recovery, held so verify + stash act on
      // the SAME verified blob the fetch port returned.
      let pendingRemote: VerifiedRemoteBlob | null = null;
      return runSyncAfterSave({
        hasMasterKey: () => masterKeyRef.current !== null,
        loadBaseVersion: () => loadLastSyncVersion(),
        push: (baseVersion) =>
          pushVaultMobile({ serverUrl, deviceSecretHex: secretHex, vaultPath: path, baseVersion }),
        fetchRemote: async () => {
          pendingRemote = await fetchRemoteBlob({ serverUrl, deviceSecretHex: secretHex });
          return pendingRemote === null ? null : { version: pendingRemote.version };
        },
        verifyRemoteOpens: () => {
          const key = masterKeyRef.current;
          return pendingRemote !== null && key !== null && verifyBlobOpensWithKey(pendingRemote.blob, key);
        },
        stashRemote: () => {
          if (pendingRemote !== null) stashRecoverableBak(path, pendingRemote.blob);
        },
        saveBaseVersion: (version) => saveLastSyncVersion(version),
      });
    },
    [],
  );

  const pushAfterSave = useCallback(async (): Promise<void> => {
    // Hard guarantee: the demo never touches the network. It has no persisted
    // device secret anyway, but guard explicitly so no future demo edit path can
    // reach the sync server.
    if (isDemoRef.current) return;
    const secretHex = await loadDeviceSecretHex();
    const serverUrl = await loadSyncServerUrl();
    if (!secretHex || !serverUrl) {
      // Saved locally; there is simply nowhere to push yet. Say so, don't error loudly.
      setSyncState((s) =>
        reduceSync(s, {
          type: 'error',
          message: 'Saved on this phone. Turn on sync in Settings to push it to your other devices.',
        }),
      );
      return;
    }
    setSyncState((s) => reduceSync(s, { type: 'start' }));
    try {
      const event = await runPushSequence(serverUrl, secretHex);
      setSyncState((s) => reduceSync(s, event));
    } catch (err) {
      // A thrown transport error (network, 402, unexpected HTTP): the local
      // save already succeeded, so surface it without losing the edit.
      // classifySyncError keeps the server's CLI-flavored 402 copy off the
      // screen (WS4) and tags the kind for distinct presentation.
      const friendly = classifySyncError(err);
      setSyncState((s) => reduceSync(s, { type: 'error', message: friendly.message, kind: friendly.kind }));
    }
  }, [runPushSequence]);

  /** Phase A enable-sync first push. See the VaultSession interface doc. */
  const pushNow = useCallback(async (): Promise<SyncEvent> => {
    if (isDemoRef.current) throw new Error('The demo vault never syncs.');
    const secretHex = await loadDeviceSecretHex();
    const serverUrl = await loadSyncServerUrl();
    if (!secretHex) throw new Error('No device secret on this phone yet. Create or link a vault first.');
    if (!serverUrl) throw new Error('No sync server configured yet.');
    setSyncState((s) => reduceSync(s, { type: 'start' }));
    try {
      const event = await runPushSequence(serverUrl, secretHex);
      setSyncState((s) => reduceSync(s, event));
      return event;
    } catch (err) {
      const friendly = classifySyncError(err);
      setSyncState((s) => reduceSync(s, { type: 'error', message: friendly.message, kind: friendly.kind }));
      // Rethrow the RAW error: the enable-sync flow classifies it itself and
      // must distinguish 402 from 403 from network.
      throw err;
    }
  }, [runPushSequence]);

  const addMemory = useCallback(
    async (input: RememberInput): Promise<MemoryEntry> => {
      const vault = vaultRef.current;
      if (!vault) throw new Error('Unlock the vault before adding a memory.');
      const entry = vault.remember(input); // appends to the hash chain
      vault.save(); // serialize -> encrypt -> atomic write + .bak
      reloadEntries();
      await pushAfterSave();
      return entry;
    },
    [reloadEntries, pushAfterSave],
  );

  const editMemory = useCallback(
    async (
      id: string,
      patch: { content?: string; scope?: string; type?: MemoryEntry['type'] },
    ): Promise<MemoryEntry> => {
      const vault = vaultRef.current;
      if (!vault) throw new Error('Unlock the vault before editing a memory.');
      // editMemory supersedes by appending a new entry (append-only; the chain
      // stays valid, ADR 0015). No-op patches return the original unchanged.
      const entry = vault.editMemory(id, patch);
      vault.save();
      reloadEntries();
      await pushAfterSave();
      return entry;
    },
    [reloadEntries, pushAfterSave],
  );

  const forgetMemory = useCallback(
    async (id: string): Promise<MemoryEntry> => {
      const vault = vaultRef.current;
      if (!vault) throw new Error('Unlock the vault before forgetting a memory.');
      // forget tombstones in place (content blanked, row + hashes kept so the
      // chain and the "forgotten on this date" fact both survive).
      const entry = vault.forget(id);
      vault.save();
      reloadEntries();
      await pushAfterSave();
      return entry;
    },
    [reloadEntries, pushAfterSave],
  );

  const signOutWipe = useCallback(async () => {
    closeSession();
    await wipeAllSecrets();
    deleteIfExists(vaultPath());
    deleteIfExists(`${vaultPath()}.bak`);
    deleteIfExists(`${vaultPath()}.tmp`);
    setBiometricCacheEnabled(false);
    setAccountIdShort(null);
    setSyncState(initialSyncState());
    setStatus('unlinked');
  }, [closeSession]);

  const getMemory = useCallback(
    (id: string) => entries.find((entry) => entry.id === id),
    [entries],
  );

  const retrieve = useCallback((query: string, options?: RetrieveOptions): ScoredEntry[] => {
    const vault = vaultRef.current;
    if (!vault) return [];
    return vault.retrieve(query, options);
  }, []);

  const value = useMemo<VaultSession>(
    () => ({
      status,
      entries,
      biometricCacheEnabled,
      accountIdShort,
      isDemo,
      linkDevice,
      createVault,
      startDemo,
      exitDemo,
      unlockWithPassphrase,
      unlockWithBiometrics,
      lock,
      pullAndReload,
      pushNow,
      syncState,
      addMemory,
      editMemory,
      forgetMemory,
      reloadEntries,
      retrieve,
      signOutWipe,
      getMemory,
    }),
    [
      status,
      entries,
      biometricCacheEnabled,
      accountIdShort,
      isDemo,
      linkDevice,
      createVault,
      startDemo,
      exitDemo,
      unlockWithPassphrase,
      unlockWithBiometrics,
      lock,
      pullAndReload,
      pushNow,
      syncState,
      addMemory,
      editMemory,
      forgetMemory,
      reloadEntries,
      retrieve,
      signOutWipe,
      getMemory,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/**
 * First 12 hex chars of the derived sync account id (public lookup id, not a
 * secret). Returns null when the platform adapters are not registered (the
 * derivation needs BLAKE2b), so bootstrap still works with the loud
 * platform-unavailable banner showing.
 */
function shortAccountId(deviceSecretHex: string): string | null {
  try {
    const secret = Buffer.from(deviceSecretHex, 'hex');
    try {
      return deriveSyncCreds(secret).accountId.slice(0, 12);
    } finally {
      memzero(secret);
    }
  } catch {
    return null;
  }
}
