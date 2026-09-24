import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * No em dash (U+2014) in any string that can reach a user: CLI output, the
 * desktop web UI and its API messages, the phone app, and every package whose
 * messages, prompts or tool descriptions surface through them. Only comments
 * are exempt, so sources are parsed rather than grepped, and every spelling
 * counts: the character, a \u2014 or \u{2014} escape, an HTML entity
 * (&mdash; &#8212; &#x2014;) and a CSS \2014 escape.
 */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Every way an em dash can be spelled in source that renders it. */
export const EM_DASH_FORMS = /\u2014|\\u2014|\\u\{0*2014\}|&mdash;|&#0*8212;|&#x0*2014;|\\0*2014(?![0-9a-f])/i;

/** Source roots whose strings reach users. apps/connector-server belongs to another unit and is not scanned yet. */
const TS_ROOTS = [
  'packages/cli/src',
  'packages/converse/src',
  'packages/core/src',
  'packages/extract/src',
  'packages/importers/src',
  'packages/librarian/src',
  'packages/mcp-server/src',
  'packages/platform-mobile/src',
  'packages/platform-node/src',
  'packages/redact/src',
  'packages/sync/src',
  'apps/web/src',
  'apps/sync-server/src',
  'apps/mobile/app',
  'apps/mobile/src',
];
const TS_FILES = ['apps/mobile/app.config.ts'];
const HTML_FILES = ['apps/web/static/index.html', 'apps/desktop/frontend/index.html'];

function isStringNode(n: ts.Node): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateLiteralLikeNode | ts.JsxText {
  return (
    ts.isStringLiteral(n) ||
    ts.isNoSubstitutionTemplateLiteral(n) ||
    ts.isTemplateHead(n) ||
    ts.isTemplateMiddle(n) ||
    ts.isTemplateTail(n) ||
    ts.isJsxText(n)
  );
}

/** Strings, templates and JSX text in one source, checked both as written and as cooked. */
export function scriptHits(label: string, text: string, kind: ts.ScriptKind, lineOffset = 0): string[] {
  const sf = ts.createSourceFile(label, text, ts.ScriptTarget.Latest, true, kind);
  const hits: string[] = [];
  const visit = (n: ts.Node): void => {
    if (isStringNode(n)) {
      const raw = n.getText(sf);
      if (EM_DASH_FORMS.test(raw) || EM_DASH_FORMS.test(n.text)) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 + lineOffset;
        hits.push(`${label}:${line}: ${raw.trim().slice(0, 90)}`);
      }
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return hits;
}

function blank(s: string): string {
  return s.replace(/[^\n]/g, ' ');
}

function lineHits(label: string, text: string): string[] {
  const hits: string[] = [];
  text.split('\n').forEach((l, i) => {
    if (EM_DASH_FORMS.test(l)) hits.push(`${label}:${i + 1}: ${l.trim().slice(0, 90)}`);
  });
  return hits;
}

/** Markup, inline styles and scripts of one HTML page; HTML, CSS and JS comments are exempt. */
export function htmlHits(label: string, html: string): string[] {
  const hits: string[] = [];
  let rest = html.replace(/<!--[\s\S]*?-->/g, blank);
  rest = rest.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/g, (_all, open: string, css: string, close: string) => {
    return open + css.replace(/\/\*[\s\S]*?\*\//g, blank) + close; // CSS stays in place, minus comments
  });
  rest = rest.replace(/(<script[^>]*>)([\s\S]*?)(<\/script>)/g, (_all, open: string, body: string, close: string, offset: number) => {
    const lineOffset = rest.slice(0, offset + open.length).split('\n').length - 1;
    hits.push(...scriptHits(`${label}<script>`, body, ts.ScriptKind.JS, lineOffset));
    return open + blank(body) + close;
  });
  hits.push(...lineHits(label, rest));
  return hits;
}

function sources(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.(tsx?|mjs|js)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function fileHits(rel: string): string[] {
  const abs = path.join(repo, rel);
  const text = fs.readFileSync(abs, 'utf8');
  if (rel.endsWith('.html')) return htmlHits(rel, text);
  return scriptHits(rel, text, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : rel.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
}

describe('no em dash in user-facing text', () => {
  for (const root of TS_ROOTS) {
    it(root, () => {
      const files = sources(path.join(repo, root)).map((f) => path.relative(repo, f));
      expect(files.length).toBeGreaterThan(0);
      expect(files.flatMap(fileHits)).toEqual([]);
    });
  }
  for (const rel of [...TS_FILES, ...HTML_FILES]) {
    it(rel, () => {
      expect(fileHits(rel)).toEqual([]);
    });
  }
});

describe('the guard catches every spelling (mutation check)', () => {
  const EM = String.fromCharCode(0x2014);
  const js = (body: string) => scriptHits('probe.ts', body, ts.ScriptKind.TS);
  const tsx = (body: string) => scriptHits('probe.tsx', body, ts.ScriptKind.TSX);
  const page = (body: string) => htmlHits('probe.html', body);
  const cases: Array<[string, () => string[]]> = [
    ['M1 string literal', () => js(`const a = 'Remove ${EM} the content';`)],
    ['M2 \\u2014 escape in a string', () => js(`const a = 'Remove \\u2014 the content';`)],
    ['M3 markup literal', () => page(`<p>private by default ${EM} you share</p>`)],
    ['M4 markup &mdash;', () => page('<p>private by default &mdash; you share</p>')],
    ['M5 markup &#8212;', () => page('<p>private by default &#8212; you share</p>')],
    ['M5b markup &#x2014;', () => page('<p>private by default &#x2014; you share</p>')],
    ['M6 script \\u2014 escape', () => page(`<script>const m = 'Your vault is locked \\u2014 Unlock it';</script>`)],
    ['M7 script innerHTML &mdash;', () => page(`<script>x.innerHTML = '<p>No calls yet &mdash; none.</p>';</script>`)],
    ['M8 CSS content escape', () => page('<style>.x::after{content:"\\2014"}</style>')],
    ['M9 JSX text literal', () => tsx(`const v = <Text>Nothing is shared ${EM} Every scope</Text>;`)],
    ['M10 JSX text &mdash;', () => tsx('const v = <Text>Nothing is shared &mdash; Every scope</Text>;')],
    ['M11 JSX {"\\u2014"} expression', () => tsx(`const v = <Text>Nothing is shared{'\\u2014'} Every scope</Text>;`)],
    ['M12 template literal \\u{2014}', () => js('const a = `left \\u{2014} right`;')],
    ['M13 template middle', () => js(`const a = \`a \${x} ${EM} \${y} b\`;`)],
    ['M14 JSX attribute &#8212;', () => tsx('const v = <Button title="Sync &#8212; now" />;')],
  ];
  for (const [name, run] of cases) {
    it(`catches ${name}`, () => {
      expect(run().length).toBeGreaterThan(0);
    });
  }

  it('exempts comments in every language', () => {
    expect(js(`// a ${EM} comment\n/* and ${EM} this */ const a = 'clean';`)).toEqual([]);
    expect(tsx(`const v = <Text>{/* note ${EM} */}clean</Text>;`)).toEqual([]);
    expect(page(`<!-- ${EM} --><style>/* ${EM} */ .a{color:red}</style><script>// ${EM}\nconst a = 'clean';</script><p>clean</p>`)).toEqual([]);
  });
  it('README, KNOWN-LIMITS, the site and the upgrade guide', () => {
    const files = [
      'README.md',
      'KNOWN-LIMITS.md',
      'docs/update-memory-projects.md',
      ...fs.readdirSync(path.join(repo, 'site')).filter((f) => f.endsWith('.html')).map((f) => `site/${f}`),
    ];
    const hits = files.flatMap((f) =>
      fs.readFileSync(path.join(repo, f), 'utf8').split('\n').flatMap((l, i) =>
        l.includes(EM) || /&mdash;|&#8212;|&#x2014;/i.test(l) ? [`${f}:${i + 1}: ${l.trim().slice(0, 90)}`] : []),
    );
    expect(hits).toEqual([]);
  });
});
