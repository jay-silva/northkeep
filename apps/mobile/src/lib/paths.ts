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

/**
 * The demo vault (M6-2b "Try a demo"). Deliberately isolated from the real
 * vault: it lives in the CACHE directory (never the document directory where the
 * real vault.nkv lives), holds only synthetic memories, is opened with an
 * ephemeral device secret that is NEVER written to SecureStore, and is never
 * synced. The cache location also lets the OS purge it, reinforcing that it is
 * throwaway and can never be mistaken for the user's real vault.
 */
export const DEMO_VAULT_FILENAME = 'demo.nkv';

export function demoVaultPath(): string {
  return new File(Paths.cache, DEMO_VAULT_FILENAME).uri;
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

/**
 * Crash-recovery for the non-atomic mobile writeAtomic window (ADR 0021 item 3,
 * a prerequisite for M6-2 writes). The mobile storage adapter writes `.tmp`,
 * copies the live vault to `.bak`, DELETES the target, then moves `.tmp` into
 * place; a crash between the delete and the move leaves NO file at the canonical
 * path, with the new image at `.tmp` and the previous at `.bak` (both complete,
 * never torn). core does not read either, so recover here BEFORE opening:
 * prefer `.tmp` (the newer, in-flight write), else fall back to `.bak`.
 *
 * A no-op when the vault file already exists (the common case). Returns which
 * source it recovered from, or null if nothing was needed/available.
 *
 * NEEDS ON-DEVICE VALIDATION: the expo-file-system File move/copy/exists calls
 * here have never executed off a device, and the crash window itself can only be
 * reproduced on hardware. This is reviewable recovery LOGIC, not proven behavior.
 */
export function recoverVaultFileIfMissing(): 'tmp' | 'bak' | null {
  const target = new File(vaultPath());
  if (target.exists) return null;
  try {
    const tmp = new File(`${target.uri}.tmp`);
    if (tmp.exists) {
      tmp.move(target);
      return 'tmp';
    }
    const bak = new File(`${target.uri}.bak`);
    if (bak.exists) {
      bak.copy(target); // keep .bak in place as a second copy until the next save
      return 'bak';
    }
  } catch {
    // If recovery itself fails, fall through: the caller will report "no vault"
    // rather than crash, and the .tmp/.bak files remain for manual recovery.
  }
  return null;
}
