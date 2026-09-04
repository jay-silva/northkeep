import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { getPlatform } from '@northkeep/core';
import { deleteIfExists, preImportBakPath, vaultPath } from './paths';
import { saveLocalDirty } from './secure-store';
import { vaultGate } from './vault-gate';

/**
 * .nkv import via the document picker (M6-1 alternate path: usable without a
 * sync subscription; AirDrop a vault from the Mac, pick it here). The file is
 * ciphertext; opening it still requires the linked device secret AND the
 * passphrase, so importing a foreign .nkv yields nothing readable.
 *
 * AN IMPORT IS A USER WRITE (ADR 0044, seventh review kill shot). It used to
 * call writeAtomic outside the gate with no bookkeeping at all, which produced
 * the one shape the sixth review's repair branch reads as a torn baseline:
 * bytes moved, nothing dirty. The next wake decided 'repair' and fast-forwarded
 * the server's copy straight over the vault the user had just imported, with
 * the pill reading Synced. Before ADR 0044 an import was pushed, which is what
 * the user wanted.
 *
 * So the write runs INSIDE the vault gate (no save may interleave with it, and
 * the session's reopen happens before any queued save is let through), and
 * `localDirty` is set BEFORE the write, exactly as every other user write does.
 *
 * WHY THE BASELINE IS LEFT ALONE. `decideWakeAction` pushes on dirty AND moved
 * bytes; the stored sha names the pre-import file, so the imported bytes read
 * as moved and the next wake is 'retry-push'. Keeping the baseline is better
 * than clearing it in three ways:
 *   - `version` survives, so the push sends the right X-Base-Version (it
 *     extends what the server held; a 409 routes to the normal last-writer-wins
 *     recovery) instead of establishing against version 0.
 *   - `generation` survives, so nextPushGeneration stamps the imported vault at
 *     lastSyncGeneration + 1. An older export AirDropped from the Mac therefore
 *     goes up ABOVE what this phone last synced instead of landing on the
 *     server as something every other device reads as a replay.
 *   - `baselineKnown` stays true, so `hasUnpushedBytes` is true and a manual
 *     pull-to-refresh ASKS before replacing the freshly imported vault.
 * A fresh phone (no vault, no baseline) is also 'retry-push': dirty is checked
 * before baselineKnown, and with no stored sha the bytes read as moved.
 * If the imported bytes happen to hash to the baseline the wake decides
 * 'clear-dirty' and pushes nothing, which is correct: the server already holds
 * exactly those bytes.
 *
 * NEEDS ON-DEVICE VALIDATION: document picker flow, File.bytes() on a picked
 * content:// / file:// URI, and the AirDrop hand-off.
 */

export type ImportResult =
  | { ok: true; bytes: number; /** Where the replaced vault was kept, or null on a phone that had none. */ keptCopyAt: string | null }
  | { ok: false; reason: 'canceled' | 'not-a-vault' };

const NKV_MAGIC = [0x4e, 0x4b, 0x56, 0x31]; // "NKV1"

export interface ImportVaultOptions {
  /**
   * Run INSIDE the vault gate, immediately after the imported bytes are
   * installed and before any queued save can run: the session's
   * close-and-reopen, exactly like pullVaultMobile's afterInstall. Without it
   * the Vault instance opened from the PREVIOUS file could save its own
   * content back over the import. It must not call anything that takes the
   * gate again (the gate is not reentrant).
   */
  afterInstall?: () => Promise<void> | void;
}

export async function importVaultFile(options: ImportVaultOptions = {}): Promise<ImportResult> {
  // The pick and the shape check touch no vault file, so they stay outside the
  // gate: a document picker can sit open for as long as the user likes, and
  // holding the gate across it would block every save on the phone.
  const picked = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (picked.canceled || picked.assets.length === 0) return { ok: false, reason: 'canceled' };
  const asset = picked.assets[0]!;
  const bytes = Buffer.from(await new File(asset.uri).bytes());
  const looksLikeVault =
    bytes.length > NKV_MAGIC.length && NKV_MAGIC.every((b, i) => bytes[i] === b);
  if (!looksLikeVault) return { ok: false, reason: 'not-a-vault' };

  let kept: string | null = null;
  await vaultGate.run(async () => {
    // DIRTY FIRST, and this ordering is the fix. If the flag write lands and
    // the file write then fails, the next wake sees dirty with unmoved bytes
    // and simply clears the flag (no network). The reverse order leaves the
    // imported bytes on disk with nothing dirty, which is the exact torn-
    // baseline shape that fast-forwards the server's copy over the import.
    await saveLocalDirty(true);
    // Keep the vault being replaced at its own path. The rolling .bak is not
    // enough: the next automatic wake stamps the import's sync generation and
    // saves, which rewrites .bak with the import itself (tenth review). This
    // copy is written only here and only overwritten by the next import.
    const storage = getPlatform().storage;
    const target = vaultPath();
    let keptCopyAt: string | null = null;
    if (storage.exists(target)) {
      keptCopyAt = preImportBakPath(target);
      // writeAtomic rolls an existing file to `.bak`; remove the previous copy
      // first so the only copy is the documented one (no `.pre-import.bak.bak`).
      deleteIfExists(keptCopyAt);
      deleteIfExists(`${keptCopyAt}.bak`);
      storage.writeAtomic(keptCopyAt, storage.readBytes(target));
    }
    storage.writeAtomic(target, bytes);
    kept = keptCopyAt; // recorded before afterInstall so a throwing reopen cannot hide where the copy went
    await options.afterInstall?.();
  });
  return { ok: true, bytes: bytes.length, keptCopyAt: kept };
}
