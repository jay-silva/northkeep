import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

function functionSource(name: string): string {
  const start = script.indexOf(`function ${name}(`);
  const brace = script.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < script.length; i += 1) {
    if (script[i] === '{') depth += 1;
    if (script[i] === '}' && --depth === 0) return script.slice(start, i + 1);
  }
  throw new Error(`Missing function ${name}`);
}

describe('ADR 0065 conflict view text', () => {
  it('gives milestones_changed its own reason', () => {
    const ctx = vm.createContext({ devicePlace: () => 'this Mac' });
    vm.runInContext(functionSource('decisionReason'), ctx);
    expect(vm.runInContext("decisionReason({ reason: 'milestones_changed' })", ctx)).toBe(
      'A connected app saved a version that changes which milestones have passed. Only you can decide that.',
    );
  });

  it('lists every pass change and the Shared mark in the take theirs panel', () => {
    const panel = functionSource('renderProjectDecision');
    expect(panel).toContain("'Milestone changes if you take theirs'");
    expect(panel).toContain('for (const p of passChanges) list.appendChild(el(\'li\', undefined, p.text));');
    expect(panel).toContain("'Taking theirs also marks this project Shared, so your connected AI apps can read everything in it.'");
  });
});
