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
import { Vault, deriveMasterKey, getPlatform, memzero, type MemoryEntry } from '@northkeep/core';
import { deriveSyncCreds } from '@northkeep/sync';
import { deleteIfExists, vaultPath } from './paths';
import {
  biometricUnlockEnabled,
  cacheMasterKeyHex,
  clearCachedMasterKey,
  loadDeviceSecretHex,
  loadSyncServerUrl,
  readCachedMasterKeyHex,
  saveDeviceSecretHex,
  saveLastSyncVersion,
  wipeAllSecrets,
} from './secure-store';
import { pullVaultMobile } from './sync';

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
  linkDevice(deviceSecretHex: string): Promise<void>;
  unlockWithPassphrase(passphrase: string, opts?: { enableBiometricCache?: boolean }): Promise<void>;
  /** Returns false if there is no cached key or the biometric prompt was refused. */
  unlockWithBiometrics(): Promise<boolean>;
  /** clearBiometricCache: the explicit "Lock vault" action also deletes the cached key. */
  lock(opts?: { clearBiometricCache?: boolean }): Promise<void>;
  /** Pull from sync and reload; requires unlocked (the key verifies the download). */
  pullAndReload(): Promise<{ pulled: boolean }>;
  reloadEntries(): void;
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
  const vaultRef = useRef<Vault | null>(null);
  const masterKeyRef = useRef<Buffer | null>(null);

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
      closeSession();
      if (opts?.clearBiometricCache) {
        await clearCachedMasterKey();
        setBiometricCacheEnabled(false);
      }
      setStatus((prev) => (prev === 'unlocked' ? 'locked' : prev));
    },
    [closeSession],
  );

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

  const signOutWipe = useCallback(async () => {
    closeSession();
    await wipeAllSecrets();
    deleteIfExists(vaultPath());
    deleteIfExists(`${vaultPath()}.bak`);
    setBiometricCacheEnabled(false);
    setAccountIdShort(null);
    setStatus('unlinked');
  }, [closeSession]);

  const getMemory = useCallback(
    (id: string) => entries.find((entry) => entry.id === id),
    [entries],
  );

  const value = useMemo<VaultSession>(
    () => ({
      status,
      entries,
      biometricCacheEnabled,
      accountIdShort,
      linkDevice,
      unlockWithPassphrase,
      unlockWithBiometrics,
      lock,
      pullAndReload,
      reloadEntries,
      signOutWipe,
      getMemory,
    }),
    [
      status,
      entries,
      biometricCacheEnabled,
      accountIdShort,
      linkDevice,
      unlockWithPassphrase,
      unlockWithBiometrics,
      lock,
      pullAndReload,
      reloadEntries,
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
