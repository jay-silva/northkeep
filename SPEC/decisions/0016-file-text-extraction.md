# ADR 0016 — Local-only file text extraction (@northkeep/extract)

- **Date:** 2026-07-15
- **Status:** Accepted
- **Deciders:** Jay (wants to upload a file — e.g. a patient care report — and
  have its text flow into the redaction pipeline), Claude Code

## Context

A user should be able to hand NorthKeep a file (a PDF patient care report, a
`.txt` note, a `.csv` export) and have its text become a string the existing
`@northkeep/redact` pipeline can process before anything is shown to a cloud
model. This ADR introduces a new leaf package, `@northkeep/extract`, that
performs that bytes-to-string step, and records the dependency choice.

The sensitive part is the dependency. A PDF text extractor that phones home —
to fetch a font, a WASM blob, or "telemetry" — would ship the document's
plaintext, or a hash of it, off the machine and break invariant #1 (plaintext
never leaves the box except to the model the user chose, after redaction). Per
CLAUDE.md, new dependencies must be minimal, boring, popular, audited, and must
not make network calls; every consequential dependency gets an ADR.

## Decision 1: `unpdf` for PDF, no dependency for plain text

Plain-text formats (`.txt`, `.md`, `.csv`, `.json`, `.log`) are decoded in
memory with the built-in `TextDecoder` (`fatal: true`, so invalid UTF-8 is a
clear error, not silent mojibake). No dependency.

PDFs are parsed by [`unpdf`](https://github.com/unjs/unpdf) (v1.6.2, MIT):

- **Zero runtime dependencies.** It bundles a serverless build of Mozilla's
  pdf.js internally rather than pulling it in as a dependency tree. Its only
  peer dependency, `@napi-rs/canvas`, is **optional** and used only for
  rendering pages to images — text extraction never loads it. So the whole
  feature adds exactly one package to the lockfile.
- **No native build.** Pure JS/WASM shipped in the package; nothing compiles on
  install. (Contrast the native modules we already gate in `pnpm-workspace.yaml`.)
- **No network I/O for buffer input.** We call `extractText(bytes, { mergePages: true })`
  on an in-memory `Uint8Array`; pdf.js parses the buffer locally. Verified: the
  package's PDF tests stub global `fetch` to throw for the duration of the test
  and extraction still succeeds, demonstrating by construction that no network
  call happens. Nothing is written to disk either — the bytes stay in memory.
- Minimal, popular, audited: `unpdf` is an unjs project, MIT-licensed, widely
  used in serverless runtimes precisely because it is self-contained.

Because `unpdf` makes no network calls, invariant #7 ("dependencies **with
network access** require an ADR and Jay's explicit OK") is not triggered — but
we write this ADR anyway under the standing rule that consequential
dependencies are documented, and record the privacy verification here.

## Decision 2: dispatch by extension; typed errors the UI can show

`extractText(bytes, filename)` picks the parser from the filename's extension
only (it never opens the file by path):

- known text extension → UTF-8 decode, `kind: 'text'`
- `.pdf` → `unpdf`, `kind: 'pdf'`
- `.docx` → `UnsupportedFileTypeError` (see Future work)
- anything else, or no extension → `UnsupportedFileTypeError`
- a supported file that will not parse → `ExtractionError` (wraps the cause)

Both error types carry `filename` (and `UnsupportedFileTypeError` carries the
offending `extension`) and a plain-language message, so the calling UI can show
the user something useful instead of a stack trace.

Signature:

```ts
export async function extractText(
  bytes: Uint8Array | Buffer,
  filename: string,
): Promise<{ text: string; kind: 'text' | 'pdf' | 'docx'; truncatedFrom?: number }>;
```

## Decision 3: generous output cap, caller does the tight trim

Output is capped at `MAX_OUTPUT_CHARS = 200_000`; when the cap bites, the result
reports `truncatedFrom` (the original length). This is deliberately far above
the ~32k downstream chat-message cap: the extractor's job is to guard against a
pathologically large document exhausting memory in the pipeline, not to decide
the final size. The caller (the future `/api/extract` route) applies the tighter
trim and can tell the user a large document was shortened.

## Rejected alternatives

- **`pdfjs-dist`** (Mozilla, the upstream `unpdf` re-bundles). Equally local and
  well maintained, but heavier to consume directly: you manage the worker setup
  and, for some paths, a `canvas`/DOM shim in Node. `unpdf` exists to paper over
  exactly that friction and exposes a one-call `extractText`. We get the same
  pdf.js engine with less integration surface and one lockfile entry instead of
  a dependency subtree.
- **`pdf-parse`.** Simpler API but older and less actively maintained; some
  published versions run debug code that reads a bundled test PDF from disk when
  the module is the entry point — a disk-side surprise we would rather not audit
  around. `unpdf` is the more modern, self-contained choice.
- **A cloud extraction API (e.g. hosted OCR).** Disqualified outright: it would
  send the document plaintext off the machine, violating invariant #1.

## Future work: DOCX

`.docx` is intentionally deferred for v1. The standard library is `mammoth`,
which pulls in a small dependency tree (a zip reader plus XML handling) for a
file type EMS reports rarely arrive in. Rather than add that surface now, the
dispatcher throws `UnsupportedFileTypeError` for `.docx` with a message telling
the user to paste the text or save as PDF. The `ExtractKind` union already
reserves `'docx'` so adding `mammoth` later is a local change to one branch,
covered by its own ADR if the dependency warrants it.

## Surfaces

- **New package:** `packages/extract` (`@northkeep/extract`) — `extractText`,
  `ExtractKind`, `ExtractResult`, `TEXT_EXTENSIONS`, `MAX_OUTPUT_CHARS`,
  `UnsupportedFileTypeError`, `ExtractionError`. Wired into the workspace
  automatically via `packages/*`; `pnpm build` and `pnpm test` include it.
- **Not wired to any app or endpoint by this ADR.** The lead will call
  `extractText` from a new `/api/extract` route; that route is out of scope here.

## Consequences

- One new lockfile entry (`unpdf`), zero native builds, zero network reach.
- Uploading a file is now a supported source of text for redaction, without
  weakening the local-only guarantee.
- The redaction pipeline is unchanged: extraction hands it an ordinary string.

## Invariants check

- **#1 (plaintext never leaves the machine):** upheld — extraction is in-memory,
  makes no network call (verified with `fetch` stubbed to throw), and writes
  nothing to disk.
- **#5 (no telemetry):** `unpdf` sends nothing; we add no telemetry.
- **#2/#3/#4/#6:** untouched — no crypto, no schema, no sync, no redaction-tier
  behavior is changed by this package.
- **Dependency discipline (CLAUDE.md):** one minimal, popular, audited, MIT,
  zero-network, no-native-build package; the plain-text path adds none.
