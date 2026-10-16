import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// ADR 0076: the requests Compact it and Shorten this summary copy name the
// memory or project and its size, and never carry the memory's text.
const html = fs.readFileSync(path.resolve(import.meta.dirname, '../static/index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;

function functionSource(name: string): string {
  const start = script.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing function ${name}`);
  let depth = 0;
  for (let i = script.indexOf('{', start); i < script.length; i += 1) {
    if (script[i] === '{') depth += 1;
    if (script[i] === '}' && --depth === 0) return script.slice(start, i + 1);
  }
  throw new Error(`Unclosed function ${name}`);
}

const context = vm.createContext({});
vm.runInContext(['compactRequest', 'shortenRequest', 'pushErrorText'].map(functionSource).join('\n') +
  ';this.f={compactRequest,shortenRequest,pushErrorText};', context);
const f = (context as unknown as { f: Record<string, (...a: unknown[]) => string> }).f;

const oversize = { id: 'e0547034-1111-4222-8333-444455556666', scope: 'conversations', bytes: 8853, cap: 8192, created_at: '2026-10-07T12:00:00.000Z' };

describe('Compact it request', () => {
  it('names the memory, its size and limit, and scopes the assistant to one edit', () => {
    const text = f.compactRequest!(oversize);
    expect(text).toContain('Memory e0547034-1111-4222-8333-444455556666 in "conversations", saved 2026-10-07, is 8.6 KB');
    expect(text).toContain('at most 8 KB');
    expect(text).toContain('memory_list using id e0547034-1111-4222-8333-444455556666');
    expect(text).toContain('memory_edit on the same id');
    expect(text).toContain('change nothing except this one memory');
    expect(text).toContain('masking is on');
  });

  it('drops the old last line only when Compact it replaces it', () => {
    const message = 'A shared memory in "conversations" is 8.6 KB. Shorten or forget that memory, then try again.';
    expect(f.pushErrorText!(message, oversize)).toBe('A shared memory in "conversations" is 8.6 KB.');
    expect(f.pushErrorText!(message, undefined)).toBe(message);
  });
});

describe('Shorten this summary request', () => {
  it('names the project and its length and points detail at For the Next Agent', () => {
    const text = f.shortenRequest!('northkeep', 1339);
    expect(text).toContain('project "northkeep"');
    expect(text).toContain('1,339 characters; keep it under 1,000');
    expect(text).toContain('project_update');
    expect(text).toContain('For the Next Agent');
  });

  it('shows the link and the agent section from the page code', () => {
    expect(script).toContain("const statusChars = [...String(project.status || '')].length;");
    expect(script).toContain('if (statusChars > PROJECT_SUMMARY_MAX)');
    expect(script).toContain("renderProjectAgentDetail(project.agent_detail)");
    expect(() => new Function(script)).not.toThrow();
  });
});
