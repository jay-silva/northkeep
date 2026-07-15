import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ExtractionError,
  extractText,
  MAX_OUTPUT_CHARS,
  UnsupportedFileTypeError,
} from '../src/index.js';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));

describe('plain-text extraction', () => {
  it('round-trips a known .txt byte-for-byte as UTF-8', async () => {
    const original = 'Patient: Jay. Notes: BP 120/80.\nAllergies: none.\n';
    const bytes = new TextEncoder().encode(original);
    const result = await extractText(bytes, 'note.txt');
    expect(result.kind).toBe('text');
    expect(result.text).toBe(original);
    expect(result.truncatedFrom).toBeUndefined();
  });

  it('accepts the other plain-text extensions and is case-insensitive', async () => {
    const bytes = new TextEncoder().encode('{"ok":true}');
    for (const name of ['data.json', 'data.MD', 'log.LOG', 'sheet.csv']) {
      const result = await extractText(bytes, name);
      expect(result.kind).toBe('text');
    }
  });

  it('caps very long text and reports the pre-truncation length', async () => {
    const original = 'a'.repeat(MAX_OUTPUT_CHARS + 500);
    const result = await extractText(new TextEncoder().encode(original), 'big.txt');
    expect(result.text.length).toBe(MAX_OUTPUT_CHARS);
    expect(result.truncatedFrom).toBe(MAX_OUTPUT_CHARS + 500);
  });

  it('throws a typed ExtractionError on invalid UTF-8', async () => {
    // 0xFF is not valid UTF-8; fatal decoding must reject it.
    const bad = new Uint8Array([0xff, 0xfe, 0x00]);
    await expect(extractText(bad, 'broken.txt')).rejects.toBeInstanceOf(ExtractionError);
  });
});

describe('PDF extraction (local, no network)', () => {
  // The fixture is a tiny hand-built PDF containing "Hello NorthKeep 42".
  // We stub global fetch to throw for the duration of these tests: if unpdf /
  // pdf.js tried any network I/O to parse an in-memory buffer, the call would
  // fail. It succeeds, which demonstrates by construction that extraction is
  // local-only (NorthKeep invariant #1).
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = (() => {
      throw new Error('network access is forbidden during extraction');
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('extracts expected text from a real PDF without touching the network', async () => {
    const result = await extractText(fixture('hello.pdf'), 'hello.pdf');
    expect(result.kind).toBe('pdf');
    expect(result.text).toContain('Hello NorthKeep 42');
    expect(result.truncatedFrom).toBeUndefined();
  });

  it('throws a typed ExtractionError on bytes that are not a valid PDF', async () => {
    const notAPdf = new TextEncoder().encode('this is plainly not a pdf');
    await expect(extractText(notAPdf, 'fake.pdf')).rejects.toBeInstanceOf(ExtractionError);
  });
});

describe('unsupported types', () => {
  it('throws UnsupportedFileTypeError for an unknown extension', async () => {
    const err = await extractText(new Uint8Array(), 'photo.png').catch((e) => e);
    expect(err).toBeInstanceOf(UnsupportedFileTypeError);
    expect((err as UnsupportedFileTypeError).extension).toBe('png');
    expect((err as Error).message).toMatch(/\.pdf/); // message names supported types
  });

  it('throws UnsupportedFileTypeError for .docx (deferred to future work)', async () => {
    const err = await extractText(new Uint8Array(), 'report.docx').catch((e) => e);
    expect(err).toBeInstanceOf(UnsupportedFileTypeError);
    expect((err as UnsupportedFileTypeError).extension).toBe('docx');
    expect((err as Error).message).toMatch(/not supported yet/i);
  });

  it('throws UnsupportedFileTypeError when the filename has no extension', async () => {
    await expect(extractText(new Uint8Array(), 'README')).rejects.toBeInstanceOf(
      UnsupportedFileTypeError,
    );
  });
});
