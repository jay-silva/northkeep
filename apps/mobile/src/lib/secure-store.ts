import * as SecureStore from 'expo-secure-store';

/**
 * All secret material on the phone lives here (ADR: device linking & mobile
 * secret storage). Policy, per the plan:
 *
 *  - WHEN_UNLOCKED_THIS_DEVICE_ONLY on every item: never migrates to a new
 *    device and never lands in an iCloud/adb backup. Transport between
 *    devices stays explicit (the QR link), exactly like the desktop's
 *    device.secret file posture.
 *  - The cached master key additionally sets requireAuthentication, so iOS
 *    Keychain / Android Keystore gates each read behind biometrics (the
 *    mobile analog of ADR 0002 background unlock).
 *
 * NEEDS ON-DEVICE VALIDATION: SecureStore accessibility + requireAuthentication
 * behavior (Face ID prompt on read, denial path, device without biometrics)
 * cannot be exercised outside a real device.
 */

const DEVICE_SECRET_KEY = 'nk.device_secret_hex';
const CACHED_MASTER_KEY = 'nk.cached_master_key_hex';
const BIOMETRIC_FLAG_KEY = 'nk.biometric_unlock_enabled';
const SYNC_SERVER_KEY = 'nk.sync_server_url';
const SYNC_VERSION_KEY = 'nk.sync_last_version';

const BASE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

// --- device secret (from the link QR / manual paste) ---

export async function saveDeviceSecretHex(hex: string): Promise<void> {
  await SecureStore.setItemAsync(DEVICE_SECRET_KEY, hex, BASE_OPTIONS);
}

export async function loadDeviceSecretHex(): Promise<string | null> {
  return SecureStore.getItemAsync(DEVICE_SECRET_KEY, BASE_OPTIONS);
}

// --- biometric-gated master-key cache (optional, opt-in) ---

export async function cacheMasterKeyHex(hex: string): Promise<void> {
  await SecureStore.setItemAsync(CACHED_MASTER_KEY, hex, {
    ...BASE_OPTIONS,
    requireAuthentication: true,
  });
  // Separate unauthenticated flag: reading the key itself always triggers the
  // biometric prompt, so the UI needs a prompt-free way to know the cache exists.
  await SecureStore.setItemAsync(BIOMETRIC_FLAG_KEY, '1', BASE_OPTIONS);
}

/** Triggers the OS biometric prompt. Returns null if absent or if auth is refused. */
export async function readCachedMasterKeyHex(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(CACHED_MASTER_KEY, {
      ...BASE_OPTIONS,
      requireAuthentication: true,
    });
  } catch {
    // Auth canceled/failed, or keychain item invalidated (e.g. biometrics
    // re-enrolled). The passphrase path is always available.
    return null;
  }
}

export async function biometricUnlockEnabled(): Promise<boolean> {
  return (await SecureStore.getItemAsync(BIOMETRIC_FLAG_KEY, BASE_OPTIONS)) === '1';
}

/** "Lock vault" semantics from the plan: deletes the cached key. */
export async function clearCachedMasterKey(): Promise<void> {
  await SecureStore.deleteItemAsync(CACHED_MASTER_KEY);
  await SecureStore.deleteItemAsync(BIOMETRIC_FLAG_KEY);
}

// --- sync sidecar (mobile analog of ~/.northkeep/sync.json; never a secret) ---

export async function saveSyncServerUrl(url: string): Promise<void> {
  await SecureStore.setItemAsync(SYNC_SERVER_KEY, url, BASE_OPTIONS);
}

export async function loadSyncServerUrl(): Promise<string | null> {
  return SecureStore.getItemAsync(SYNC_SERVER_KEY, BASE_OPTIONS);
}

export async function saveLastSyncVersion(version: number): Promise<void> {
  await SecureStore.setItemAsync(SYNC_VERSION_KEY, String(version), BASE_OPTIONS);
}

export async function loadLastSyncVersion(): Promise<number> {
  const raw = await SecureStore.getItemAsync(SYNC_VERSION_KEY, BASE_OPTIONS);
  const parsed = raw === null ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

// --- sign-out / wipe-local ---

/** Removes every NorthKeep item from the keychain. The vault file is deleted separately. */
export async function wipeAllSecrets(): Promise<void> {
  await SecureStore.deleteItemAsync(CACHED_MASTER_KEY);
  await SecureStore.deleteItemAsync(BIOMETRIC_FLAG_KEY);
  await SecureStore.deleteItemAsync(DEVICE_SECRET_KEY);
  await SecureStore.deleteItemAsync(SYNC_SERVER_KEY);
  await SecureStore.deleteItemAsync(SYNC_VERSION_KEY);
}
