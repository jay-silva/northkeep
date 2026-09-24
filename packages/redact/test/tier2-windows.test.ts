import { describe, expect, it } from 'vitest';
import type { OllamaClient } from '@northkeep/librarian';
import { NER_WINDOW_CHARS, nerWindows, redact } from '../src/index.js';

/**
 * ADR 0060 Decision 8 (D9). The name model used to read only the first 6000
 * characters, so a name later in a long text went out unmasked while the call
 * reported Tier 2. This stub finds a name only in the text it is actually given.
 */
const NAMES = ['Quennell Abernathy-Vos', 'Zyler Okonkwo-Brandt'];

function windowStub(opts: { failCall?: number } = {}): OllamaClient & { calls: number } {
  const stub = {
    calls: 0,
    available: async () => true,
    generateJson: async (prompt: string) => {
      stub.calls += 1;
      if (opts.failCall === stub.calls) throw new Error('name model timed out');
      const seen = prompt.slice(prompt.lastIndexOf('\nText:\n') + 7);
      return JSON.stringify({
        entities: NAMES.filter((n) => seen.includes(n)).map((text) => ({ text, kind: 'person' })),
      });
    },
  };
  return stub as unknown as OllamaClient & { calls: number };
}

function filler(n: number): string {
  let s = '';
  while (s.length < n) s += 'the patient rested well and ate lunch. ';
  return s.slice(0, n);
}

describe('ADR 0060 D9: the name model reads the whole text', () => {
  it('C35: masks a name at character 6,100 of a 6,200-character memory', async () => {
    const text = `${filler(6100)} ${NAMES[0]} has the biopsy results. ${filler(40)}`;
    expect(text.indexOf(NAMES[0]!)).toBeGreaterThan(NER_WINDOW_CHARS);
    const r = await redact(text, { tier: 2 }, windowStub());
    expect(r.tier2Degraded).toBe(false);
    expect(r.tierApplied).toBe(2);
    expect(r.redacted).not.toContain('Quennell');
    expect(r.redacted).toMatch(/Person-\d+ has the biopsy results/);
  });

  it('C36: masks a name straddling a window boundary', async () => {
    // Punctuation, not a space, before the name: the cut lands inside it.
    const before = `${'x'.repeat(NER_WINDOW_CHARS - 11)}.`;
    const text = `${before}${NAMES[1]} called. ${filler(300)}`;
    const start = text.indexOf(NAMES[1]!);
    expect(start).toBeLessThan(NER_WINDOW_CHARS);
    expect(start + NAMES[1]!.length).toBeGreaterThan(NER_WINDOW_CHARS);
    const r = await redact(text, { tier: 2 }, windowStub());
    expect(r.redacted).not.toContain('Okonkwo');
    expect(r.tier2Degraded).toBe(false);
  });

  it('C37: one window failing marks the whole text degraded, never a partial Tier 2', async () => {
    const text = `${NAMES[1]} first. ${filler(6400)} ${NAMES[0]} last.`;
    const r = await redact(text, { tier: 2 }, windowStub({ failCall: 2 }));
    expect(r.tier2Degraded).toBe(true);
    expect(r.tierApplied).toBe(1);
  });

  it('windows cover every character, overlap, and never split a surrogate pair', () => {
    const text = `${'a'.repeat(5999)}😀${'b '.repeat(4000)}`;
    const windows = nerWindows(text);
    expect(windows.length).toBeGreaterThan(1);
    let covered = 0;
    for (const w of windows) {
      expect(w.start).toBeLessThanOrEqual(covered);
      expect(text.slice(w.start, w.start + w.text.length)).toBe(w.text);
      expect(/[\uD800-\uDBFF]$/.test(w.text)).toBe(false);
      expect(/^[\uDC00-\uDFFF]/.test(w.text)).toBe(false);
      covered = Math.max(covered, w.start + w.text.length);
    }
    expect(covered).toBe(text.length);
    expect(windows[0]!.text.length).toBeLessThanOrEqual(NER_WINDOW_CHARS);
  });

  it('a short text is still one call', async () => {
    const stub = windowStub();
    await redact(`${NAMES[0]} is here.`, { tier: 2 }, stub);
    expect(stub.calls).toBe(1);
  });
});
