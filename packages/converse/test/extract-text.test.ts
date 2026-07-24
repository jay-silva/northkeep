import { describe, expect, it } from 'vitest';
import { extractText } from '../src/index.js';

/**
 * M10b — the zero-dep HTML→text extractor (ADR 0028), against deliberately
 * gnarly markup: nested/unclosed tags, bracketed attribute values, entity
 * soup, script/style payloads that must never surface.
 */

describe('extractText', () => {
  it('extracts readable text and drops the document chrome', () => {
    const html = `<!doctype html><html><head><title>T</title><meta x="y"><style>body{color:red}</style></head>
      <body><h1>Heading</h1><p>First para.</p><p>Second para.</p></body></html>`;
    const text = extractText(html);
    expect(text).toContain('Heading');
    expect(text).toContain('First para.');
    expect(text).toContain('Second para.');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('<');
  });

  it('drops script/style/template/svg/noscript content entirely', () => {
    const html = `<p>keep</p><script>var secret = "attack()";</script><style>.x{}</style>
      <template><p>ghost</p></template><svg><text>vector</text></svg><noscript>fallback</noscript><p>also keep</p>`;
    const text = extractText(html);
    expect(text).toContain('keep');
    expect(text).toContain('also keep');
    for (const gone of ['attack()', 'ghost', 'vector', 'fallback', '.x{}']) {
      expect(text).not.toContain(gone);
    }
  });

  it('survives attributes containing brackets and quotes (quote-aware scanner)', () => {
    const html = `<img alt="a > b" src="x.png"><p title='5 < 7 > 3'>content</p><div data-x="</div>">real</div>`;
    const text = extractText(html);
    expect(text).toContain('content');
    expect(text).toContain('real');
    expect(text).not.toContain('a > b'); // attribute values are not text
    expect(text).not.toContain('x.png');
  });

  it('keeps bare < in text without treating it as a tag', () => {
    expect(extractText('<p>x < y and y > z</p>')).toBe('x < y and y > z');
  });

  it('handles unclosed and nested tags without hanging or leaking markup', () => {
    const html = '<div><p>outer <b>bold <i>deep</p> trailing <span class="x">span text';
    const text = extractText(html);
    expect(text).toContain('outer bold deep');
    expect(text).toContain('trailing');
    expect(text).toContain('span text');
    expect(text).not.toContain('class=');
  });

  it('decodes named and numeric entities', () => {
    const html = '<p>&amp; &lt;tag&gt; &quot;q&quot; &#39;a&#39; x&nbsp;y &#65; &#x42; &bogus; &#xZZ;</p>';
    const text = extractText(html);
    expect(text).toContain('& <tag> "q" \'a\' x y A B');
    expect(text).toContain('&bogus;'); // unknown entities survive verbatim
    expect(text).toContain('&#xZZ;');
  });

  it('keeps link targets as "text (url)" for http(s) links only', () => {
    const html =
      '<p>See <a href="https://example.com/docs">the docs</a> or ' +
      '<a href=\'/relative\'>relative</a> or <a href="javascript:alert(1)">evil</a>.</p>';
    const text = extractText(html);
    expect(text).toContain('the docs (https://example.com/docs)');
    expect(text).toContain('relative'); // text kept, non-http target dropped
    expect(text).not.toContain('/relative)');
    expect(text).toContain('evil');
    expect(text).not.toContain('javascript:');
  });

  it('strips comments, including unterminated ones', () => {
    expect(extractText('a<!-- hidden -->b')).toBe('ab');
    expect(extractText('a<!-- runs off the end')).toBe('a');
  });

  it('turns block-level structure into line breaks and collapses whitespace', () => {
    const html = '<ul>\n  <li>one</li>\n  <li>two</li>\n</ul><table><tr><td>c1</td><td>c2</td></tr></table>';
    const text = extractText(html);
    expect(text).toMatch(/one\n{1,2}two/);
    expect(text).toContain('c1');
    expect(text).not.toMatch(/\n{3,}/);
    expect(text).not.toMatch(/[ \t]{2,}/);
  });
});
