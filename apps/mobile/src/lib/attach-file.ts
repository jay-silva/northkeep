import * as DocumentPicker from 'expo-document-picker';
// SDK 54+ exposes the class-based File/Paths API on the MAIN entry (the old
// `expo-file-system/next` subpath is legacy); paths.ts and import-vault.ts
// import it the same way. `File#bytes()` returns a Uint8Array.
import { File } from 'expo-file-system';

/**
 * Converse file attach (mobile): pick a file and read it to text ON-DEVICE, so
 * the on-device Tier-1 firewall can redact it with the message before anything
 * is sent. Mirrors the desktop attach, with one honest difference: the desktop
 * extracts server-side with pdf.js (@northkeep/extract), which we do NOT bundle
 * into the phone, so PDFs are desktop-only for now. Text formats cover notes,
 * CSVs, JSON, and logs.
 *
 * LOCAL-ONLY by construction (invariant #1): the picked file is read from the
 * device cache and decoded in memory; nothing is uploaded (there is no server
 * on the phone) and nothing extra is written to disk.
 *
 * NEEDS ON-DEVICE VALIDATION: document-picker flow + File.bytes() on a picked
 * content:// / file:// URI (same caveat as import-vault.ts).
 */

/** Text formats we read directly (mirror of @northkeep/extract TEXT_EXTENSIONS). */
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'csv', 'json', 'log']);
/** Generous in-memory cap; the composer applies the tighter ~32k message cap. */
const MAX_OUTPUT_CHARS = 200_000;

export type PickedAttachment = { name: string; text: string; truncatedFrom: number | null };
export type PickResult =
  | { ok: true; attachment: PickedAttachment }
  | { ok: false; reason: 'canceled' }
  | { ok: false; reason: 'unsupported'; ext: string }
  | { ok: false; reason: 'read-failed' };

function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

export async function pickAttachment(): Promise<PickResult> {
  let picked;
  try {
    picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
  } catch {
    return { ok: false, reason: 'read-failed' };
  }
  if (picked.canceled || picked.assets.length === 0) return { ok: false, reason: 'canceled' };
  const asset = picked.assets[0]!;
  const name = asset.name ?? 'file';
  const ext = extensionOf(name);
  if (!TEXT_EXTENSIONS.has(ext)) return { ok: false, reason: 'unsupported', ext };
  try {
    const bytes = await new File(asset.uri).bytes();
    // Web-standard decoder (built into Hermes); avoids relying on a Buffer
    // polyfill. Non-fatal so a slightly-malformed text file still attaches.
    let text = new TextDecoder('utf-8').decode(bytes);
    let truncatedFrom: number | null = null;
    if (text.length > MAX_OUTPUT_CHARS) {
      truncatedFrom = text.length;
      text = text.slice(0, MAX_OUTPUT_CHARS);
    }
    return { ok: true, attachment: { name, text, truncatedFrom } };
  } catch {
    return { ok: false, reason: 'read-failed' };
  }
}
