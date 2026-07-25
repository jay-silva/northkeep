# ADR 0032: Rendering assistant replies as Markdown without an HTML parser

- **Date:** 2026-07-25
- **Status:** Accepted
- **Deciders:** Jay (product owner), Claude Code
- **Parent:** ADR 0027 (harness umbrella), ADR 0029 (security model), ADR 0031

## Context

Until M10 the GUI rendered assistant replies with a single `textContent`
assignment. That was invisible in practice: a local model answering from the
vault writes plain prose, so there was nothing to format.

Web search changed the input. Search results push the model into
list-and-heading formatting, so with the Tools toggle on, every reply arrives
full of `**bold**`, `### headings` and numbered lists, and the chat bubble
showed those marks as literal characters. Jay hit this on the first live
acceptance run.

The obvious fix — a Markdown library, or `innerHTML` with a sanitizer — is the
wrong one here, and the reason is specific to this product rather than general
caution. Since M10b/M10d the model can call `web_fetch` (any URL) and
`web_search`, so **the text of a reply can contain content the model copied out
of an arbitrary web page**. The GUI is a loopback page holding a live session
token for an UNLOCKED vault; script running in it can read and write every
memory the user owns. Parsing reply text as HTML would therefore hand a page we
never saw a script-injection path into the vault UI — turning the exfiltration
risk ADR 0029's screens exist to bound into a direct one. A sanitizer only
narrows that; it does not remove the parser.

## Decision 1: construct DOM, never parse HTML

A hand-written renderer (~130 lines, in `apps/web/static/index.html` between
the `md-render-start` / `md-render-end` markers) builds real DOM nodes with
`createElement` and `textContent`. It never touches `innerHTML`, `outerHTML`,
`insertAdjacentHTML`, `document.write`, or `setAttribute`. No HTML is ever
parsed, only constructed, so every scrap of model text lands in a text node and
can only ever be characters. A literal script tag in a reply renders as visible
characters.

The vocabulary is fixed and small: `div`, `p`, `strong`, `em`, `code`, `pre`,
`ul`, `ol`, `li`, `hr`, `span`, plus text nodes. The only non-text properties
ever written are `className` (always a literal or a digit 1–6) and the numeric
`start` of an ordered list. **No dependency was added**, which also keeps
faith with the standing instruction to minimize dependency count.

## Decision 2: links render as inert text, images stay literal

`[text](url)` renders as `text (url)` in plain text — never an anchor, never an
`href`. A model relaying a URL out of a page it just fetched must not be one
click away from the user, which is the same threat ADR 0029's exfiltration
screen addresses on the outbound side. The URL stays visible so it can be read
and copied deliberately.

`![alt](url)` stays entirely literal for the same reason plus one more: loading
a remote image is itself an outbound request, chosen by the model, from an
unlocked vault UI.

## Decision 3: unsupported constructs degrade to literal text, never to markup

Tables, raw HTML, blockquotes and images are unrecognized, so their lines
render as plain text: readable, unformatted, never mangled. This is the honest
failure direction for the whole design — the renderer's job is to format what
it recognizes and get out of the way otherwise.

## Decision 4: fidelity outranks fidelity-to-CommonMark

Emphasis marks are **consumed**, so a wrong emphasis match does not merely look
wrong — it silently deletes characters and changes what the reply says. For a
product whose claim is that your memory and your model's words are yours, that
is a correctness bug, not a rendering nit. So the grammar is deliberately
stricter than CommonMark:

- emphasis content may not span its own delimiter or a line break;
- underscore emphasis requires word boundaries, so `some_long_name` and
  `MAX_TOKENS` survive;
- `__bold__` is not supported at all (models write `**bold**`, while
  `__init__` and `__name__` are everyday content that CommonMark would eat);
- backslash escapes are honored, the one place a character is intentionally
  consumed (documented in KNOWN-LIMITS).

The cost is that a few exotic constructs show their literal marks. That is the
right direction to fail: a stray asterisk is visible and harmless, a deleted
one is neither.

This same constraint is what keeps the renderer linear. An adversarial review
found a 200 KB reply of unmatched `__` delimiters froze the tab for ~12.7
seconds, because each delimiter was a match start whose lazy scan ran to the
end of the reply. Bounding emphasis content means an unmatched mark can only
scan to the next one; the same input now renders in ~3 ms. A fetched page could
have induced that reply, so this was a real denial-of-service on the main
thread, not a theoretical one.

## Decision 5: format at completion, not during streaming

Tokens stream as plain text; the formatted version replaces them on the `done`
event, riding the swap that already replaced wire-space text with restored
text. Rendering per token would rebuild the tree a thousand times, break text
selection mid-stream, and flicker as half-written `**bold**` closed. The cost
is that a long answer shows raw marks until it finishes.

## Testing

`apps/web/test/markdown.test.ts` extracts the renderer verbatim from the page
and runs it against a fake DOM that **throws** on `innerHTML`, `outerHTML`,
`insertAdjacentHTML`, on any tag outside the vocabulary above, and on any
property write outside `{className, start, textContent}`. That last rule came
from the review: the first shim forbade `innerHTML` and anchors, but would have
passed a renderer that added `img.src = <model-controlled url>` — a
model-controlled outbound GET from an unlocked vault UI. The hardened shim was
verified by patching exactly that beacon in and watching it fail.

One class of bug is structurally invisible to those tests, and it bit during
the build: the block lives inside the page's single `<script>` element, and a
literal closing tag in its own comment ended the script early and killed all of
the page's JavaScript while the entire suite stayed green. Tests that extract
source as text never parse HTML. Hence the e2e assertion in `e2e/ui.test.ts`
that the SERVED page contains the renderer inside exactly one intact script
element — which also makes the build's copy of `static/index.html` into
`dist/static/` a tested invariant.

## Consequences

- Formatting can only ever be as good as a hand-written grammar. Tables are the
  most likely thing to want next; adding them means more code, never a parser.
- Any future contributor tempted to "just use marked/DOMPurify" must read this
  ADR first. The renderer is not naive; the constraint is deliberate.
- KNOWN-LIMITS (GUI section) records the user-visible limits: no tables, no
  clickable links, formatting appears at the end of the reply, and the stricter
  emphasis rules.
