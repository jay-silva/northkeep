import { describe, expect, it } from 'vitest';
import type { OllamaClient } from '@northkeep/librarian';
import {
  NER_EVAL_CORPUS,
  evaluateNer,
  evaluateRedaction,
  evaluateTier3Monotonicity,
  findBelowFloorLeaks,
  type NerEvalCase,
} from '../src/eval.js';

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

/**
 * A fake NER client that returns exactly the provided target spans whenever they
 * appear in the (dict-masked) prompt. applyTier2 only accepts spans that occur
 * in the text, so a span the dictionary already masked simply is not present and
 * is never returned — the same constraint a real model runs under.
 */
function fakeReturning(targets: Array<{ text: string; kind: 'person' | 'org' | 'location' }>): OllamaClient {
  return {
    available: async () => true,
    generateJson: async (prompt: string) => {
      const entities = targets.filter((t) => prompt.includes(t.text));
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

describe('findBelowFloorLeaks (pure monotonicity detector)', () => {
  it('FLAGS a token the floor masked but the full pipeline left in plaintext', () => {
    // Reproduces the Ravindranathan bug class: the dictionary-only floor masked
    // the whole name, but a buggy NER-first ordering left the first name in.
    const leaks = findBelowFloorLeaks(
      ['Ravindranathan Kumar'],
      'Please call [Person-1] about the shipment.', // floor: whole span masked
      'Please call Ravindranathan [Person-1] about the shipment.', // full: first name leaked
    );
    expect(leaks).toEqual([{ expectedName: 'Ravindranathan Kumar', leakedToken: 'Ravindranathan' }]);
  });

  it('does NOT flag a token both outputs mask (full stayed at or above floor)', () => {
    expect(
      findBelowFloorLeaks(['Ravindranathan Kumar'], 'Call [Person-1].', 'Call [Person-1].'),
    ).toEqual([]);
  });

  it('does NOT flag a token the floor itself leaves in plaintext (not a below-floor regression)', () => {
    // If the floor never masked it, the full pipeline keeping it is not a
    // monotonicity violation — it is a floor gap, measured by fullLeaks instead.
    expect(
      findBelowFloorLeaks(['Zyler Quandril'], 'Meet Zyler Quandril.', 'Meet Zyler Quandril.'),
    ).toEqual([]);
  });

  it('is case-insensitive and whole-word (a substring is not a leak)', () => {
    // "Trent" is not present as a whole word inside "Trenton"; must not flag.
    expect(findBelowFloorLeaks(['Marcus Trent'], 'Call [Person-1].', 'Call [Person-1] in Trenton.')).toEqual([]);
    // Different casing of a real whole-word survival IS a leak.
    expect(
      findBelowFloorLeaks(['Marcus Trent'], 'Call [Person-1].', 'Call TRENT back.'),
    ).toEqual([{ expectedName: 'Marcus Trent', leakedToken: 'Trent' }]);
  });
});

describe('evaluateTier3Monotonicity (shipped pipeline)', () => {
  it('null client: full == floor, zero violations, equal no-leak rates', async () => {
    const report = await evaluateTier3Monotonicity(NER_EVAL_CORPUS, null);
    expect(report.violations).toEqual([]);
    expect(report.fullNoLeakRate).toBe(report.floorNoLeakRate);
    expect(report.personNames).toBeGreaterThan(0);
  });

  it('well-behaved NER ADDS masks over the floor with zero violations', async () => {
    // An off-dictionary name the deterministic floor cannot catch ("Zyler
    // Quandril" is on no census list), so the floor leaks it and a well-behaved
    // NER net lifts no-leak to 100% — strictly above the floor, never below.
    const corpus: NerEvalCase[] = [
      { text: 'Please call Zyler Quandril about the Vermeer account.', entities: [{ text: 'Zyler Quandril', kind: 'person' }] },
    ];
    const report = await evaluateTier3Monotonicity(corpus, fakeReturning([{ text: 'Zyler Quandril', kind: 'person' }]));
    expect(report.violations).toEqual([]);
    expect(report.floorNoLeakRate).toBe(0); // floor alone leaked the off-list name
    expect(report.fullNoLeakRate).toBe(1); // NER net closed the gap
    expect(report.fullNoLeakRate).toBeGreaterThan(report.floorNoLeakRate);
  });

  it('MALICIOUS surname-only NER cannot regress below the floor (dict-first holds)', async () => {
    // The old bug: NER masks a surname alone, breaking the dict pair rule and
    // leaking the first name. Dict-first means the whole name is already masked
    // before NER runs, so the surname is not even in the text to return — the
    // pipeline holds and the monotonicity check reports ZERO violations. This is
    // the regression test for commit 8435d12.
    const report = await evaluateTier3Monotonicity(
      NER_EVAL_CORPUS,
      fakeReturning(
        NER_EVAL_CORPUS.flatMap((c) =>
          c.entities
            .filter((e) => e.kind === 'person')
            .map((e) => ({ text: e.text.split(' ').slice(-1)[0]!, kind: 'person' as const })),
        ),
      ),
    );
    expect(report.violations).toEqual([]);
  });
});

describe('evaluateRedaction (both measurements)', () => {
  it('carries the tier-2 diagnostic AND the tier-3 production-truth numbers', async () => {
    const report = await evaluateRedaction(NER_EVAL_CORPUS, fakeReturning(
      NER_EVAL_CORPUS.flatMap((c) => c.entities),
    ));
    // Diagnostic: model-in-isolation recall (a real number, not the shipped one).
    expect(report.tier2Diagnostic.entities.total).toBeGreaterThan(0);
    // Production truth: no monotonicity violations, floor never above full.
    expect(report.tier3.violations).toEqual([]);
    expect(report.tier3.fullNoLeakRate).toBeGreaterThanOrEqual(report.tier3.floorNoLeakRate);
  });

  it('reports continuous progress across both halves', async () => {
    const seen: Array<{ done: number; total: number }> = [];
    await evaluateRedaction(NER_EVAL_CORPUS, null, (done, total) => seen.push({ done, total }));
    expect(seen[seen.length - 1]).toEqual({ done: NER_EVAL_CORPUS.length * 2, total: NER_EVAL_CORPUS.length * 2 });
  });
});
