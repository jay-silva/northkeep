import { extname } from 'node:path';
import { extractText as extractPdfText } from 'unpdf';
import { ExtractionError, UnsupportedFileTypeError } from './errors.js';

export { ExtractionError, UnsupportedFileTypeError } from './errors.js';

/** Where the extracted text came from. `text` = decoded directly as UTF-8;
 * `pdf` = parsed with the bundled pdf.js; `docx` is reserved for a future
 * version (see ADR 0016) and is not produced today. */
export type ExtractKind = 'text' | 'pdf' | 'docx';

export interface ExtractResult {
  /** The extracted text, capped at {@link MAX_OUTPUT_CHARS}. */
  text: string;
  kind: ExtractKind;
  /** Present only when the text was longer than the cap: the original,
   * pre-truncation character count. The caller (which has its own, tighter
   * downstream cap) can surface "we truncated a large document". */
  truncatedFrom?: number;
}

/** File extensions we decode straight to UTF-8 text with no dependency. */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'txt',
  'md',
  'csv',
  'json',
  'log',
]);

/**
 * Upper bound on returned text length. Deliberately generous: the chat message
 * cap downstream is ~32k, but a full patient care report can be large and the
 * caller is responsible for the final trim. We only guard against a patholog-
 * ically huge document exhausting memory in the redaction pipeline.
 */
export const MAX_OUTPUT_CHARS = 200_000;

/** Lowercased extension without the leading dot; `''` when there is none. */
function extensionOf(filename: string): string {
  return extname(filename).replace(/^\./, '').toLowerCase();
}

/** Cap `text` at {@link MAX_OUTPUT_CHARS}, recording the original length when
 * we actually cut it. */
function capText(text: string, kind: ExtractKind): ExtractResult {
  if (text.length > MAX_OUTPUT_CHARS) {
    return { text: text.slice(0, MAX_OUTPUT_CHARS), kind, truncatedFrom: text.length };
  }
  return { text, kind };
}

/**
 * Extract plain text from an uploaded file's bytes so the redaction pipeline
 * can process it. Dispatch is by file extension.
 *
 * This function is LOCAL-ONLY by construction (NorthKeep invariant #1): it
 * makes NO network request and writes NOTHING to disk. Plain-text formats are
 * decoded in-memory; PDFs are parsed by `unpdf`, which bundles a serverless
 * build of pdf.js and operates entirely on the in-memory buffer (verified in
 * tests by extracting with global `fetch` stubbed to throw). No native build
 * step is required.
 *
 * @param bytes    The file contents. A Node `Buffer` is a `Uint8Array`, so
 *                 either works.
 * @param filename Used ONLY to pick the parser by extension; never opened.
 * @throws {UnsupportedFileTypeError} for any extension we do not handle
 *         (including `.docx`, deferred per ADR 0016) or a missing extension.
 * @throws {ExtractionError} when a supported file cannot be parsed.
 */
export async function extractText(
  bytes: Uint8Array | Buffer,
  filename: string,
): Promise<ExtractResult> {
  const ext = extensionOf(filename);

  if (TEXT_EXTENSIONS.has(ext)) {
    let text: string;
    try {
      // `fatal: true` so invalid UTF-8 is a clear error, not silent mojibake.
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (cause) {
      throw new ExtractionError(
        `Could not decode ${filename} as UTF-8 text.`,
        filename,
        { cause },
      );
    }
    return capText(text, 'text');
  }

  if (ext === 'pdf') {
    let text: string;
    try {
      // unpdf accepts a Uint8Array and never touches the network or disk for a
      // buffer input. mergePages:true returns one string across all pages.
      const result = await extractPdfText(new Uint8Array(bytes), { mergePages: true });
      text = result.text;
    } catch (cause) {
      throw new ExtractionError(
        `Could not read ${filename} as a PDF. The file may be corrupt or password-protected.`,
        filename,
        { cause },
      );
    }
    return capText(text, 'pdf');
  }

  if (ext === 'docx') {
    // DOCX is deferred to a future version (ADR 0016, "Future work"). Throw a
    // typed error so the UI can tell the user plainly rather than failing oddly.
    throw new UnsupportedFileTypeError(
      ext,
      filename,
      'Word (.docx) extraction is not supported yet; paste the text or save as PDF.',
    );
  }

  throw new UnsupportedFileTypeError(ext, filename);
}
