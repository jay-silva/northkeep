import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { getPlatform } from '@northkeep/core';
import { vaultPath } from './paths';

/**
 * .nkv import via the document picker (M6-1 alternate path: usable without a
 * sync subscription; AirDrop a vault from the Mac, pick it here). The file is
 * ciphertext; opening it still requires the linked device secret AND the
 * passphrase, so importing a foreign .nkv yields nothing readable.
 *
 * NEEDS ON-DEVICE VALIDATION: document picker flow, File.bytes() on a picked
 * content:// / file:// URI, and the AirDrop hand-off.
 */

export type ImportResult =
  | { ok: true; bytes: number }
  | { ok: false; reason: 'canceled' | 'not-a-vault' };

const NKV_MAGIC = [0x4e, 0x4b, 0x56, 0x31]; // "NKV1"

export async function importVaultFile(): Promise<ImportResult> {
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
  // writeAtomic keeps any existing vault as .bak (storage seam contract), so a
  // bad import of the right shape is still recoverable.
  getPlatform().storage.writeAtomic(vaultPath(), bytes);
  return { ok: true, bytes: bytes.length };
}
