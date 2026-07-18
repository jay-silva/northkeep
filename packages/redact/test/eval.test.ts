import { describe, expect, it } from 'vitest';
import type { OllamaClient } from '@northkeep/librarian';
import { NER_EVAL_CORPUS, evaluateNer } from '../src/eval.js';

/**
 * Tests the Tier-2 NER eval HARNESS (not a model). We drive evaluateNer with
 * synthetic NER backends whose behavior we control, so we can prove the scorer
 * discriminates: a perfect backend must score 1.0, and — critically for a
 * privacy gate — a partial or wrong-kind backend must be penalized, not
 * over-credited. A perfect-fake-only test could not tell a correct scorer from
 * one that always returns 100%.
 */

/**
 * Build a fake NER client. For each corpus entity present in the prompt, `pick`
 * decides what the "model" returns (or null to drop it). applyTier2 only accepts
 * spans that actually occur in the text, so returned spans must be real
 * substrings — exactly what a real model is constrained to.
 */
function makeFake(
  pick: (e: { text: string; kind: 'person' | 'org' | 'location' }) =>
    | { text: string; kind: 'person' | 'org' | 'location' }
    | null,
): OllamaClient {
  return {
    available: async () => true,
    generateJson: async (prompt: string) => {
      const entities: Array<{ text: string; kind: string }> = [];
      for (const c of NER_EVAL_CORPUS) {
        for (const e of c.entities) {
          if (!prompt.includes(e.text)) continue;
          const t = pick(e);
          if (t && prompt.includes(t.text)) entities.push(t);
        }
      }
      return JSON.stringify({ entities });
    },
    embed: async () => {
      throw new Error('unused');
    },
    pull: async () => {
      throw new Error('unused');
    },
  };
}

const SECRETS_IN_CORPUS = NER_EVAL_CORPUS.reduce((n, c) => n + (c.secrets?.length ?? 0), 0);

describe('evaluateNer (harness)', () => {
  it('scores a perfect backend at recall 1.0 with zero Tier-1 leaks', async () => {
    const report = await evaluateNer(NER_EVAL_CORPUS, makeFake((e) => e));
    expect(report.entities.recall).toBe(1);
    expect(report.spanRecall).toBe(1);
    expect(report.misses).toHaveLength(0);
    expect(report.tier1Leaks).toEqual([]);
    expect(report.tier1SecretsChecked).toBe(SECRETS_IN_CORPUS);
    expect(SECRETS_IN_CORPUS).toBeGreaterThan(0);
  });

  it('penalizes PARTIAL catches (first word only) as misses, not catches', async () => {
    // Return only the first whitespace token of any span (e.g. "John" of
    // "John Whitfield"). The rest of the name would leak, so it MUST be a miss.
    const report = await evaluateNer(
      NER_EVAL_CORPUS,
      makeFake((e) => {
        const first = e.text.split(' ')[0]!;
        return first === e.text ? e : { text: first, kind: e.kind };
      }),
    );
    expect(report.entities.recall).toBeLessThan(1);
    // Multi-word spans became misses with the full span never detected.
    const partialMiss = report.misses.find((m) => m.text === 'John Whitfield');
    expect(partialMiss).toBeDefined();
    expect(partialMiss?.detectedAnyKind).toBe(false);
    // Single-word spans (e.g. cities) are unaffected and still caught.
    expect(report.byKind.location.recall).toBeGreaterThan(0);
  });

  it('penalizes WRONG-KIND detections under strict recall but not span recall', async () => {
    const report = await evaluateNer(
      NER_EVAL_CORPUS,
      makeFake((e) => ({ text: e.text, kind: e.kind === 'person' ? 'org' : 'person' })),
    );
    // Every span found, but every kind wrong: strict recall collapses, span
    // recall stays perfect. This is what distinguishes the two metrics.
    expect(report.spanRecall).toBe(1);
    expect(report.entities.recall).toBeLessThan(1);
    expect(report.misses.every((m) => m.detectedAnyKind)).toBe(true);
  });

  it('degrades safely with no model: recall 0, Tier-1 floor still holds', async () => {
    const report = await evaluateNer(NER_EVAL_CORPUS, null);
    expect(report.entities.caught).toBe(0);
    expect(report.entities.recall).toBe(0);
    // The whole point of the floor: secrets are STILL masked by Tier-1 even when
    // Tier-2 has no backend.
    expect(report.tier1Leaks).toEqual([]);
    expect(report.tier1SecretsChecked).toBe(SECRETS_IN_CORPUS);
  });
});
