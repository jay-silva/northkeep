import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * No em dash (U+2014) in anything a user reads: CLI help and messages, the
 * desktop web UI, and the phone app. Code comments are exempt, so strings are
 * found by parsing, not by grepping lines.
 */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EM = '—';

function stringHits(label: string, text: string, kind: ts.ScriptKind, lineOffset = 0): string[] {
  const sf = ts.createSourceFile(label, text, ts.ScriptTarget.Latest, true, kind);
  const hits: string[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n) ||
      ts.isJsxText(n)
    ) {
      const t = n.getText(sf);
      if (t.includes(EM)) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 + lineOffset;
        hits.push(`${label}:${line}: ${t.trim().slice(0, 90)}`);
      }
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return hits;
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function tsHits(dir: string): string[] {
  return sources(path.join(repo, dir)).flatMap((f) =>
    stringHits(path.relative(repo, f), fs.readFileSync(f, 'utf8'), f.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS),
  );
}

function blank(s: string): string {
  return s.replace(/[^\n]/g, ' ');
}

function webHits(): string[] {
  const file = 'apps/web/static/index.html';
  const html = fs.readFileSync(path.join(repo, file), 'utf8');
  const hits: string[] = [];
  let markup = html.replace(/<!--[\s\S]*?-->/g, blank).replace(/<style>[\s\S]*?<\/style>/g, blank);
  markup = markup.replace(/(<script>)([\s\S]*?)(<\/script>)/g, (_all, open: string, body: string, close: string, offset: number) => {
    const lineOffset = html.slice(0, offset + open.length).split('\n').length - 1;
    hits.push(...stringHits(`${file}<script>`, body, ts.ScriptKind.JS, lineOffset));
    return open + blank(body) + close;
  });
  markup.split('\n').forEach((l, i) => {
    if (l.includes(EM)) hits.push(`${file}:${i + 1}: ${l.trim().slice(0, 90)}`);
  });
  return hits;
}

describe('no em dash in user-facing text', () => {
  it('CLI help and runtime messages', () => {
    expect(tsHits('packages/cli/src')).toEqual([]);
  });
  it('desktop web UI', () => {
    expect(webHits()).toEqual([]);
  });
  it('phone app', () => {
    expect([...tsHits('apps/mobile/app'), ...tsHits('apps/mobile/src')]).toEqual([]);
  });
});
