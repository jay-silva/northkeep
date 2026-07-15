/**
 * Typed errors the extract package throws. The UI can switch on `.name` (or
 * `instanceof`) to show the user a clear, actionable message instead of a
 * stack trace.
 */

/** The filename's extension is one we do not handle (or it has none). */
export class UnsupportedFileTypeError extends Error {
  /** The lowercased extension without a leading dot, e.g. `docx`. Empty when
   * the filename had no extension. */
  readonly extension: string;
  /** The filename we were asked to extract. */
  readonly filename: string;

  constructor(extension: string, filename: string, hint?: string) {
    const ext = extension ? `.${extension}` : '(no extension)';
    super(
      `Cannot extract text from ${ext} files.` +
        (hint ? ` ${hint}` : ' Supported: plain text (.txt, .md, .csv, .json, .log) and .pdf.'),
    );
    this.name = 'UnsupportedFileTypeError';
    this.extension = extension;
    this.filename = filename;
  }
}

/** The file matched a supported type but could not be parsed (corrupt PDF,
 * invalid UTF-8, an empty document, etc.). Wraps the underlying cause. */
export class ExtractionError extends Error {
  readonly filename: string;

  constructor(message: string, filename: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ExtractionError';
    this.filename = filename;
  }
}
