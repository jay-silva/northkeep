import { File, Paths } from 'expo-file-system';

/**
 * Where the encrypted vault lives on the phone. The .nkv file is ciphertext
 * (whole-file XChaCha20-Poly1305, ADR 0001), so the app documents directory
 * is acceptable at rest; the secrets that unlock it live in SecureStore, not
 * on the filesystem.
 *
 * TODO(platform-mobile integration): confirm the path convention the
 * @northkeep/platform-mobile VaultStorage adapter expects (file:// URI vs
 * plain path) and align here; this module is the only place the app builds
 * vault paths.
 *
 * NEEDS ON-DEVICE VALIDATION: expo-file-system's File/Paths API (SDK 54+
 * surface) has not been executed from this environment.
 */

export const VAULT_FILENAME = 'vault.nkv';

export function vaultPath(): string {
  return new File(Paths.document, VAULT_FILENAME).uri;
}

/** Scratch path used by the pull flow for verify-before-replace. */
export function pulledTmpPath(): string {
  return new File(Paths.cache, `${VAULT_FILENAME}.pulled.tmp`).uri;
}

/** Best-effort delete of a scratch file; never throws. */
export function deleteIfExists(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Scratch cleanup is best-effort; a leftover tmp file in the cache
    // directory is ciphertext and the OS may purge it at will.
  }
}
