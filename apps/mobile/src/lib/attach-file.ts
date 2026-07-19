import * as DocumentPicker from 'expo-document-picker';
// SDK 54+ exposes the class-based File/Paths API on the MAIN entry (the old
// `expo-file-system/next` subpath is legacy); paths.ts and import-vault.ts
// import it the same way. `File#bytes()` returns a Uint8Array.
import { File } from 'expo-file-system';

/**
 * Converse file attach (mobile): pick a file and read it to text ON-DEVICE, so
 * the on-device Tier-1 firewall can redact it with the message before anything
 * is sent. Text formats cover notes, CSVs, JSON, and logs. PDFs go through the
 * NATIVE PdfText module (modules/pdf-text): Apple PDFKit for the text layer +
 * Vision OCR for scanned pages — chosen over pdf.js/unpdf, which fatally
 * crashed Hermes on an internal async tick in build 13 (uncatchable from JS).
 * Native errors arrive as coded promise rejections, so failure is always a
 * message, never a crash.
 *
 * LOCAL-ONLY by construction (invariant #1): the picked file is read from the
 * device cache and decoded/extracted in memory (PDFKit/Vision run on-device);
 * nothing is uploaded and nothing extra is written to disk. The PDF is never
 * sent anywhere — only its extracted text, after redaction, like any typed
 * message.
 *
 * NEEDS ON-DEVICE VALIDATION: document-picker flow + File.bytes() on a picked
 * content:// / file:// URI (same caveat as import-vault.ts), and the first
 * on-device PDF extraction (text-layer, scanned/OCR, and password-protected
 * cases).
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
  | { ok: false; reason: 'protected' }
  | { ok: false; reason: 'no-text' }
  /** detail = short diagnostic (error code/message), safe to show the user. */
  | { ok: false; reason: 'read-failed'; detail?: string };

/** Native on-device PDF extractor (modules/pdf-text): PDFKit + Vision OCR. */
type PdfTextNative = {
  extractText(uri: string): Promise<{
    text: string;
    pages: number;
    ocrPages: number;
    ocrLimited: boolean;
  }>;
};

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
  if (!TEXT_EXTENSIONS.has(ext) && ext !== 'pdf') {
    return { ok: false, reason: 'unsupported', ext };
  }
  try {
    let text: string;
    if (ext === 'pdf') {
      const { requireNativeModule } = await import('expo');
      const PdfText = requireNativeModule<PdfTextNative>('PdfText');
      let result;
      try {
        result = await PdfText.extractText(asset.uri);
      } catch (err) {
        const e = err as { code?: string; message?: string };
        if (e.code === 'ERR_PDF_PROTECTED') return { ok: false, reason: 'protected' };
        const detail = [e.code, e.message].filter(Boolean).join(': ').slice(0, 160);
        return { ok: false, reason: 'read-failed', detail: detail || undefined };
      }
      text = result.text.trim();
      if (text.length === 0) return { ok: false, reason: 'no-text' };
      if (result.ocrLimited) {
        text += `\n\n[Note: this scanned PDF is long; text was recognized from the first pages only.]`;
      }
    } else {
      const bytes = await new File(asset.uri).bytes();
      // Web-standard decoder (built into Hermes); avoids relying on a Buffer
      // polyfill. Non-fatal so a slightly-malformed text file still attaches.
      text = new TextDecoder('utf-8').decode(bytes);
    }
    let truncatedFrom: number | null = null;
    if (text.length > MAX_OUTPUT_CHARS) {
      truncatedFrom = text.length;
      text = text.slice(0, MAX_OUTPUT_CHARS);
    }
    return { ok: true, attachment: { name, text, truncatedFrom } };
  } catch (err) {
    const detail = err instanceof Error ? err.message.slice(0, 160) : undefined;
    return { ok: false, reason: 'read-failed', detail };
  }
}
