import * as SecureStore from 'expo-secure-store';
import { parseDeviceSecretHex } from './device-secret-format.js';

/**
 * Device-secret storage on mobile: expo-secure-store (iOS Keychain / Android
 * Keystore). Device-secret handling is deliberately NOT part of the Platform
 * seam (see core vault-storage.ts note); these are the mobile analogs of
 * platform-node's loadDeviceSecret/ensureDeviceSecret, async because
 * SecureStore is async.
 *
 * Policy (ADR 0019/0021): WHEN_UNLOCKED_THIS_DEVICE_ONLY —
 * kSecAttrAccessibleWhenUnlockedThisDeviceOnly. The secret NEVER syncs to
 * iCloud/Google backups; moving it between devices is always the explicit QR
 * link flow. The mobile app receives the secret from the desktop QR
 * (northkeep://link/v1?ds=<hex>) rather than generating its own, so there is
 * no ensure-with-generate here: a phone without a linked secret has no vault
 * to open.
 */

const DEVICE_SECRET_KEY = 'northkeep.device-secret';

const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/** Store the hex secret scanned from the desktop QR. Validates before storing. */
export async function storeDeviceSecret(hex: string): Promise<void> {
  parseDeviceSecretHex(hex); // throw on malformed input before persisting
  await SecureStore.setItemAsync(DEVICE_SECRET_KEY, hex.trim(), SECURE_STORE_OPTIONS);
}

/** The 32-byte device secret, or null if this device was never linked. */
export async function loadDeviceSecret(): Promise<Buffer | null> {
  const hex = await SecureStore.getItemAsync(DEVICE_SECRET_KEY, SECURE_STORE_OPTIONS);
  if (hex === null) return null;
  return parseDeviceSecretHex(hex);
}

/** Unlink this device (used by "unlink device"; the vault file is separate). */
export async function deleteDeviceSecret(): Promise<void> {
  await SecureStore.deleteItemAsync(DEVICE_SECRET_KEY, SECURE_STORE_OPTIONS);
}
