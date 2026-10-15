import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// The project page leads with one sentence of the summary; the rest opens on request.
const html = fs.readFileSync(path.resolve(import.meta.dirname, '../static/index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
const start = script.indexOf('function projectFirstSentence(');
const end = script.indexOf('\n  }\n', start) + 4;
const context = vm.createContext({});
vm.runInContext(script.slice(start, end) + ';this.first = projectFirstSentence;', context);
const first = (text: string) => (context as unknown as { first: (t: string) => string }).first(text);

describe('project summary first sentence', () => {
  it('stops at the first sentence end, not at a version number', () => {
    expect(first('NorthKeep 0.24.0 is out (v0.24.0 at 6bebcf3). Release 0.25.0 is next.')).toBe('NorthKeep 0.24.0 is out (v0.24.0 at 6bebcf3).');
  });
  it('uses only the first line', () => {
    expect(first('Shipped the beta\nThen more detail.')).toBe('Shipped the beta');
  });
  it('cuts a long run-on line at a word, with an ellipsis', () => {
    const out = first('word '.repeat(80).trim());
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(241);
  });
  it('returns a short summary whole', () => {
    expect(first('All done.')).toBe('All done.');
  });
});
