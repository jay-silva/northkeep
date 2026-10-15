# ADR 0032: Rendering assistant replies as Markdown without an HTML parser

Status: Accepted 2026-07-25 · Review: adversarial review during build; findings (emphasis DoS, test-shim gap) fixed, see full record

Superseded in part by ADR 0066 (accepted 2026-10-15): Converse is no longer presented as a product mode.

## Context
The GUI rendered replies with one `textContent` assignment. With web search on, replies arrive full of `**bold**`, `### headings` and lists shown as literal marks. Since M10b/M10d a reply can contain text copied from an arbitrary web page via `web_fetch`/`web_search`, and the GUI is a loopback page holding a live session token for an unlocked vault, so parsing reply text as HTML would give a page we never saw a script-injection path into the vault UI. A sanitizer narrows that; it does not remove the parser.

## Decision
- D1: A hand-written renderer (~130 lines, in `apps/web/static/index.html` between `md-render-start` / `md-render-end`) builds DOM with `createElement` and `textContent`. It never uses `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` or `setAttribute`. Tags: `div`, `p`, `strong`, `em`, `code`, `pre`, `ul`, `ol`, `li`, `hr`, `span`. Only `className` (a literal or digit 1 to 6) and an ordered list's numeric `start` are written. No dependency added.
- D2: `[text](url)` renders as plain `text (url)`, never an anchor or `href`. `![alt](url)` stays literal: loading a remote image would be a model-chosen outbound request.
- D3: Tables, raw HTML, blockquotes and images render as literal text.
- D4: Emphasis is stricter than CommonMark, because a wrong match deletes characters: emphasis may not span its own delimiter or a line break; underscore emphasis needs word boundaries; `__bold__` is unsupported; backslash escapes are honored (documented in KNOWN-LIMITS). This also keeps rendering linear: a 200 KB reply of unmatched `__` froze the tab ~12.7 s before, ~3 ms after.
- D5: Tokens stream as plain text; formatting replaces them on the `done` event.
- D6: `apps/web/test/markdown.test.ts` runs the extracted renderer against a fake DOM that throws on `innerHTML`, `outerHTML`, `insertAdjacentHTML`, any tag outside the vocabulary, and any property write outside `{className, start, textContent}`. `e2e/ui.test.ts` asserts the served page holds the renderer inside exactly one intact script element.

## Consequences
- Harder: formatting is only as good as a hand-written grammar; tables would mean more code, never a parser. Contributors tempted to use marked/DOMPurify must read this ADR.
- Limits (KNOWN-LIMITS, GUI): no tables, no clickable links, formatting appears at the end of the reply, stricter emphasis rules.

## Rejected
- A Markdown library or `innerHTML` with a sanitizer: keeps an HTML parser on model text that may come from an arbitrary page.
- Per-token rendering: rebuilds the tree constantly, breaks selection, flickers.
- CommonMark-faithful emphasis: eats `__init__`, `MAX_TOKENS`-style content.

## What leaves the machine
The original has no egress section. It keeps links inert and images literal because a remote image load would be a model-chosen outbound request, and its test shim throws on any property write outside `{className, start, textContent}` (the review caught that an `img.src` beacon would otherwise pass).

## Links
Parent: ADRs 0027, 0029, 0031 · Full record: docs/design/adr-0032-reply-markdown-rendering.md
