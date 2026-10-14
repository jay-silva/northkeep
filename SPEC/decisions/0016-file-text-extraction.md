# ADR 0016: Local-only file text extraction (@northkeep/extract)

Status: Accepted 2026-07-15 · Review: none recorded

## Context
A user should be able to hand NorthKeep a file (a PDF patient care report, a `.txt` note, a `.csv` export) and have its text become a string the existing `@northkeep/redact` pipeline processes before anything reaches a cloud model. The sensitive part is the dependency: a PDF extractor that phones home for a font, a WASM blob or telemetry would ship plaintext, or a hash of it, off the machine and break invariant #1.

## Decision
- D1: New leaf package `packages/extract` (`@northkeep/extract`). Plain-text formats (`.txt`, `.md`, `.csv`, `.json`, `.log`) are decoded in memory with the built-in `TextDecoder` (`fatal: true`), no dependency.
- D2: PDFs are parsed by `unpdf` (v1.6.2, MIT): zero runtime dependencies (bundles pdf.js), no native build, and its optional peer `@napi-rs/canvas` is never loaded for text. We call `extractText(bytes, { mergePages: true })` on an in-memory `Uint8Array`. Verified: tests stub global `fetch` to throw and extraction still succeeds; nothing is written to disk.
- D3: `extractText(bytes, filename)` dispatches by extension only and never opens a path. `.docx`, unknown or missing extensions throw `UnsupportedFileTypeError` (carries `filename` and `extension`); a supported file that will not parse throws `ExtractionError`. Both carry plain-language messages for the UI.
- D4: Output is capped at `MAX_OUTPUT_CHARS = 200_000`, reporting `truncatedFrom` when it bites. This guards memory; the caller (a future `/api/extract` route) applies the tighter trim (about 32k chat cap) and tells the user.
- D5: Not wired to any app or endpoint by this ADR.

## Consequences
- Easier: uploading a file becomes a supported source of text for redaction without weakening the local-only guarantee; the redaction pipeline is unchanged.
- Cost: one new lockfile entry (`unpdf`), zero native builds, zero network reach.
- Deferred: DOCX. `mammoth` pulls a small dependency tree; the dispatcher tells the user to paste the text or save as PDF. `'docx'` is reserved in `ExtractKind`, and adding it later gets its own ADR if the dependency warrants it.
- Invariant #7 is not triggered (no network access); this ADR is written under the standing rule that consequential dependencies are documented.

## Rejected
- `pdfjs-dist` directly: same engine, but you manage worker setup and sometimes a canvas/DOM shim in Node.
- `pdf-parse`: less maintained; some versions read a bundled test PDF from disk when run as the entry point.
- A cloud extraction or OCR API: sends document plaintext off the machine, violating invariant #1.

## What leaves the machine
The original has no egress section. Its invariant check states extraction is in memory, makes no network call (verified with global `fetch` stubbed to throw), writes nothing to disk, and adds no telemetry. Extracted text is meant to go through the existing redaction pipeline; that route is not wired by this ADR.

## Links
Full record: docs/design/adr-0016-file-text-extraction.md
