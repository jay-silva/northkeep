import { Directory, File, Paths } from 'expo-file-system';
import type { VaultStorage } from '@northkeep/core';

/**
 * Mobile VaultStorage: expo-file-system's synchronous File API behind the
 * platform seam, reproducing platform-node's atomic-save semantics with the
 * primitives iOS/Android expose: write the new image to `${path}.tmp`, keep the
 * previous contents as `${path}.bak`, then move the temp file into place.
 *
 * Honest divergences from the Node adapter (both documented in ADR 0023 and
 * flagged for the invariant-#3 adversarial review):
 *   1. expo's File API exposes no fsync, so the explicit fd-fsync +
 *      directory-fsync the Node adapter performs is not available.
 *   2. expo's move() cannot overwrite an existing destination, so there is no
 *      atomic rename. The sequence below writes .tmp, copies the live vault to
 *      .bak, deletes the target, then moves .tmp into place. A crash in the
 *      narrow window between the delete and the move leaves NO file at `path` —
 *      the previous vault is at `.bak` and the new one at `.tmp`, both
 *      complete, but neither at the canonical path. core does not read .bak, so
 *      apps/mobile MUST implement recovery-on-open (prefer `.tmp`, else `.bak`)
 *      before this is trusted with a real vault. Never only a torn/partial file
 *      is produced; the failure mode is "no vault at path", which is
 *      recoverable, not "corrupt vault".
 */

/** Default vault location inside the app sandbox (Documents, device-local). */
export function defaultVaultUri(): string {
  return new File(Paths.document, 'vault.nkv').uri;
}

function parentDirectoryUri(uri: string): string {
  const cut = uri.lastIndexOf('/');
  if (cut <= 0) throw new Error(`Cannot determine parent directory of "${uri}"`);
  return uri.slice(0, cut);
}

export function mobileVaultStorage(): VaultStorage {
  return {
    exists(path: string): boolean {
      return new File(path).exists;
    },

    readBytes(path: string): Buffer {
      const file = new File(path);
      if (!file.exists) throw new Error(`No file at ${path}`);
      // bytesSync (NOT bytes(), which is async) — the seam contract is synchronous.
      const bytes = file.bytesSync();
      return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    },

    writeAtomic(path: string, bytes: Uint8Array): void {
      // Hand the native module a PLAIN Uint8Array: callers pass the Metro
      // Buffer polyfill (a Uint8Array subclass), and expo-modules-core's JSI
      // argument conversion can fail its type lookup on it (the on-device
      // "unordered_map::at: key not found"). A copy of ~400KB is cheap.
      const plain = new Uint8Array(bytes);
      // Step labels: on-device native errors are opaque one-liners, so name the
      // failing operation in the rethrow (surfaces directly in the UI banner).
      const step = <T>(name: string, fn: () => T): T => {
        try {
          return fn();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`writeAtomic[${name}] at ${path}: ${msg}`);
        }
      };

      const target = new File(path);
      const tmp = new File(`${path}.tmp`);
      const bak = new File(`${path}.bak`);
      const dir = new Directory(parentDirectoryUri(path));
      if (!step('dir.exists', () => dir.exists)) {
        step('dir.create', () => dir.create({ intermediates: true }));
      }

      if (step('tmp.exists', () => tmp.exists)) step('tmp.delete', () => tmp.delete());
      step('tmp.create', () => tmp.create());
      step('tmp.write', () => tmp.write(plain));

      if (step('target.exists', () => target.exists)) {
        if (step('bak.exists', () => bak.exists)) step('bak.delete', () => bak.delete());
        step('target.copy(bak)', () => target.copy(bak));
        // File.move does not overwrite; the .bak taken above covers the window
        // between this delete and the move completing.
        step('target.delete', () => target.delete());
      }
      step('tmp.move(target)', () => tmp.move(target));
    },
  };
}
