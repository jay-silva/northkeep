import { describe, expect, it } from 'vitest';
import { redact } from '../src/index.js';
import { applyTier1 } from '../src/tier1.js';
import { LEAK_CORPUS } from './corpus.js';

/**
 * THE LEAK TEST (CLAUDE.md engineering standard). A corpus of seeded secrets
 * through Tier-1 — zero misses allowed. This is the CI gate that must pass on
 * every commit.
 */
describe('leak test — zero Tier-1 misses', () => {
  it('masks every seeded secret in isolation', () => {
    const missed: string[] = [];
    for (const { secret, sentence } of LEAK_CORPUS) {
      const { text } = applyTier1(sentence);
      if (text.includes(secret)) missed.push(`${secret}  (in: ${sentence})`);
    }
    expect(missed, `LEAKED ${missed.length} secrets:\n${missed.join('\n')}`).toEqual([]);
  });

  it('masks every secret when all 50 appear in one blob', () => {
    const blob = LEAK_CORPUS.map((s) => s.sentence).join('\n');
    const { text } = applyTier1(blob);
    const leaked = LEAK_CORPUS.filter((s) => text.includes(s.secret)).map((s) => s.secret);
    expect(leaked).toEqual([]);
  });

  it('reports one replacement per distinct secret kind at least', async () => {
    const blob = LEAK_CORPUS.map((s) => s.sentence).join('\n');
    const result = await redact(blob, { tier: 1 });
    const kinds = new Set(result.replacements.map((r) => r.kind));
    for (const kind of ['email', 'phone', 'ssn', 'credit_card', 'ip', 'api_key', 'iban']) {
      expect(kinds, `no ${kind} detected`).toContain(kind);
    }
  });
});
