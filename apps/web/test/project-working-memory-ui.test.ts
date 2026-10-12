import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROJECT_WORKING_MEMORY_MESSAGE } from '@northkeep/core';

const html = fs.readFileSync(fileURLToPath(new URL('../static/index.html', import.meta.url)), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

function functionSource(name: string) {
  const functionStart = script.indexOf(`function ${name}(`);
  if (functionStart < 0) throw new Error(`Missing function ${name}`);
  const brace = script.indexOf('{', functionStart);
  let depth = 0;
  for (let index = brace; index < script.length; index += 1) {
    if (script[index] === '{') depth += 1;
    if (script[index] === '}' && --depth === 0) return script.slice(functionStart, index + 1);
  }
  throw new Error(`Unclosed function ${name}`);
}

describe('Add memory warns before saving a working note into a project', () => {
  it('uses the same refusal as the server and does not call the API', () => {
    expect(script).toContain(PROJECT_WORKING_MEMORY_MESSAGE);
    const remember = script.slice(script.indexOf("$('addMemBtn').addEventListener"));
    const guard = remember.indexOf("const warning = projectWorkingMemoryWarning(type, scope);");
    const post = remember.indexOf("api('/api/memories'");
    expect(guard).toBeGreaterThan(-1);
    expect(post).toBeGreaterThan(guard);
    expect(remember.slice(guard, post)).toContain("$('addMemErr').textContent = warning; return;");
    expect(functionSource('openRescope')).toContain('projectWorkingMemoryWarning(type, scope)');
  });

  it('warns only for a working memory in a valid project scope', () => {
    const context = vm.createContext({});
    vm.runInContext(
      `${script.slice(script.indexOf('const PROJECT_WORKING_MEMORY_MESSAGE'), script.indexOf('function refreshProjectWorkingWarning'))}`,
      context,
    );
    const warn = (type: string, scope: string) =>
      vm.runInContext(`projectWorkingMemoryWarning(${JSON.stringify(type)}, ${JSON.stringify(scope)})`, context) as string;
    expect(warn('working', 'project:lantern')).toBe(PROJECT_WORKING_MEMORY_MESSAGE);
    expect(warn('semantic', 'project:lantern')).toBe('');
    expect(warn('working', 'personal')).toBe('');
    expect(warn('working', 'project:Not_A_Slug')).toBe('');
  });
});
