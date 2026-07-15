# @northkeep/extract

Local-only text extraction. Turns an uploaded file's bytes into a string for the
redaction pipeline, with **zero network I/O and zero disk writes** (NorthKeep
invariant #1). See SPEC/decisions/0016-file-text-extraction.md.

```ts
import { extractText } from '@northkeep/extract';

const { text, kind, truncatedFrom } = await extractText(bytes, filename);
```

- Plain text (`.txt`, `.md`, `.csv`, `.json`, `.log`) → decoded as UTF-8, no dependency.
- `.pdf` → parsed by [`unpdf`](https://github.com/unjs/unpdf) (bundled pdf.js, no native build).
- `.docx` → **deferred**; throws `UnsupportedFileTypeError` (future work in ADR 0016).
- Unknown/missing extension → throws `UnsupportedFileTypeError`.
- Unparseable supported file → throws `ExtractionError`.

Output is capped at `MAX_OUTPUT_CHARS` (200,000); `truncatedFrom` reports the
original length when the cap bit. The caller applies the tighter downstream trim.
