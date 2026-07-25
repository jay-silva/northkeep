/**
 * Zero-dependency HTML → readable text (M10b, ADR 0028). Deliberately a
 * ~200-line lexer, not an HTML parser: the output feeds a language model
 * (which tolerates imperfect extraction), while a real DOM library would be
 * a new dependency on the most attacker-controlled input path in the product
 * (invariant #7 — dependency count is a metric to minimize). Upgrade path:
 * swap this file for a vetted readability library behind the same function
 * signature if extraction quality ever matters more than the dependency.
 *
 * What it does: drops <script>/<style>/<template>/<svg>/<head> (and
 * <noscript>) subtrees and comments, keeps link targets as "text (url)",
 * turns block-level tags into newlines, strips every remaining tag with a
 * quote-aware scanner (an attribute like alt="a > b" does not end the tag),
 * decodes the common named entities plus numeric references, and collapses
 * whitespace.
 */

/** Elements whose entire content is dropped (first matching close tag wins). */
const DROP_CONTENT = new Set(['script', 'style', 'template', 'svg', 'head', 'noscript']);

/** Elements that imply a line break in the extracted text. */
const BLOCK_TAGS = new Set([
  'p', 'div', 'br', 'li', 'ul', 'ol', 'tr', 'td', 'th', 'table', 'section', 'article',
  'header', 'footer', 'nav', 'aside', 'main', 'form', 'blockquote', 'pre', 'hr', 'dt', 'dd',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figcaption', 'figure', 'address', 'summary', 'details',
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  apos: "'",
  nbsp: ' ',
};

interface Tag {
  name: string;
  closing: boolean;
  raw: string;
  end: number; // index just past the '>'
}

/**
 * Scan one tag starting at `<` (index i). Quote-aware: '>' inside a quoted
 * attribute value does not terminate the tag. Returns null when the tag never
 * closes (malformed tail) — the caller drops the remainder as markup.
 */
function scanTag(input: string, i: number): Tag | null {
  let j = i + 1;
  let quote: string | null = null;
  while (j < input.length) {
    const c = input[j]!;
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      break;
    }
    j += 1;
  }
  if (j >= input.length) return null;
  const inner = input.slice(i + 1, j);
  const closing = inner.startsWith('/');
  // The name must IMMEDIATELY follow '<' or '</' (HTML rule): "a < b" is
  // text, not a tag, and must survive as text.
  const nameMatch = /^\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(inner);
  return {
    name: nameMatch?.[1]?.toLowerCase() ?? '',
    closing,
    raw: inner,
    end: j + 1,
  };
}

/** Pull an href="..." (or unquoted) value out of a raw tag body. */
function hrefOf(rawTag: string): string | null {
  const m = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(rawTag);
  return m?.[1] ?? m?.[2] ?? m?.[3] ?? null;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+|#39);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

function collapseWhitespace(text: string): string {
  return text
    .replace(/[ \t\f\v]+/g, ' ') // runs of spaces/tabs → one space
    .replace(/ ?\n ?/g, '\n') // trim spaces hugging newlines
    .replace(/\n{3,}/g, '\n\n') // at most one blank line
    .trim();
}

export function extractText(html: string): string {
  let out = '';
  let i = 0;
  /** Non-null while inside a <a href=...>; buffers the link text. */
  let link: { url: string; buffer: string } | null = null;
  const emit = (text: string): void => {
    if (link !== null) link.buffer += text;
    else out += text;
  };

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      emit(html.slice(i));
      break;
    }
    emit(html.slice(i, lt));

    // Comments (including unterminated ones — drop to the end).
    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4);
      i = close === -1 ? html.length : close + 3;
      continue;
    }

    const tag = scanTag(html, lt);
    if (tag === null) {
      i = html.length; // unclosed tag at the tail — treat the rest as markup
      break;
    }
    if (tag.name === '') {
      // Declarations/processing instructions (<!doctype>, <?xml>, CDATA)
      // are markup: drop them whole. Anything else after '<' is prose
      // ("a < b") — keep the character and move on.
      if (tag.raw.startsWith('!') || tag.raw.startsWith('?')) {
        i = tag.end;
        continue;
      }
      emit('<');
      i = lt + 1;
      continue;
    }
    i = tag.end;

    // Drop whole subtrees of non-content elements. Nesting is not tracked
    // (first close wins) — over-dropping is the safe direction for content
    // that was never prose anyway.
    if (!tag.closing && DROP_CONTENT.has(tag.name)) {
      const close = new RegExp(`</\\s*${tag.name}\\s*>`, 'i');
      const rest = html.slice(i);
      const m = close.exec(rest);
      i = m === null ? html.length : i + m.index + m[0].length;
      continue;
    }

    // Links: keep the destination as "text (url)" so the model can cite or
    // follow up — but only http(s) targets (javascript:/mailto:/#fragments
    // add noise, not information).
    if (tag.name === 'a') {
      if (!tag.closing) {
        // A dangling open link flushes its buffered text; start fresh.
        if (link !== null) {
          const dangling = link.buffer;
          link = null;
          emit(dangling);
        }
        const url = hrefOf(tag.raw);
        link = { url: url !== null && /^https?:\/\//i.test(url) ? url : '', buffer: '' };
        continue;
      }
      if (link !== null) {
        const { url, buffer } = link;
        link = null;
        const text = buffer.trim();
        emit(url !== '' && text !== '' ? `${text} (${url})` : text);
      }
      continue;
    }

    if (BLOCK_TAGS.has(tag.name)) emit('\n');
  }
  if (link !== null) out += link.buffer; // unclosed <a> at EOF — keep its text

  return collapseWhitespace(decodeEntities(out));
}
