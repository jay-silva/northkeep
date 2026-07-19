import type { OllamaClient } from '@northkeep/librarian';
import { redact } from './index.js';
import type { EntityKind } from './types.js';

/**
 * Tier-2 NER evaluation harness — the M6-4 GATE (ADR 0020).
 *
 * Runs a seeded entity corpus through the REAL redact() pipeline at Tier-2 with a
 * given NER backend and measures recall against the desktop target (85-95%
 * in-domain). The SAME function scores:
 *   - the desktop Ollama baseline (pass createOllamaClient()), and
 *   - the on-device model (pass createLocalNerClient(localModel) — structurally an
 *     OllamaClient), from a device runner.
 * so parity is an apples-to-apples number, not a vibe.
 *
 * Deliberately NOT re-exported from the package index: it pulls the librarian
 * OllamaClient type into scope and is infra, not core API. Import via the subpath
 * '@northkeep/redact/dist/eval.js'.
 *
 * Scoring is STRICT and pessimistic (this is a privacy gate): an entity counts as
 * caught only when the structured Tier-2 output contains a replacement whose
 * `original` equals the whole expected span (case-insensitive) AND whose `kind`
 * matches. A partial catch ("John" of "John Smith") is a MISS, because "Smith"
 * would leak. We score from `result.replacements` (the structured entity output),
 * never from string-absence, which would over-credit partial catches.
 *
 * The corpus is fully synthetic/public: invented names, RFC-2606 example.* domains,
 * and 555-01xx reserved phone numbers. No real personal data.
 */

export interface NerEvalCase {
  text: string;
  /** Expected named-entity spans (person/org/location), exact substrings of `text`. */
  entities: Array<{ text: string; kind: EntityKind }>;
  /** Tier-1 secrets embedded in `text` that MUST be masked even at Tier-2. */
  secrets?: string[];
}

export interface KindMetric {
  total: number;
  caught: number;
  recall: number;
}

export interface NerEvalReport {
  cases: number;
  /** Strict recall: whole span + correct kind. The headline gate number. */
  entities: KindMetric;
  /** Looser: whole span detected regardless of kind (diagnostic only). */
  spanRecall: number;
  byKind: Record<EntityKind, KindMetric>;
  /** Every expected span not caught with the correct kind. */
  misses: Array<{ text: string; kind: EntityKind; detectedAnyKind: boolean; caseText: string }>;
  /**
   * Tier-1 floor proof: seeded secrets that survived into the redacted output.
   * MUST be empty — Tier-2 running (on any backend) never weakens the Tier-1
   * firewall (invariant: Tier-1 is the guaranteed floor).
   */
  tier1Leaks: string[];
  tier1SecretsChecked: number;
}

const KINDS: EntityKind[] = ['person', 'org', 'location'];

/**
 * Evaluate a NER backend. `ner` is an OllamaClient (desktop) or the on-device
 * LocalNerClient (structurally compatible). `null` measures the no-model floor
 * (recall 0, no leaks) — useful to prove the harness runs even when degraded.
 */
export async function evaluateNer(
  cases: NerEvalCase[],
  ner: OllamaClient | null,
  /** Called after each case completes — drives a progress bar on slow
   * on-device runs (a full corpus is 20+ sequential model calls). */
  onProgress?: (done: number, total: number) => void,
): Promise<NerEvalReport> {
  const byKind: Record<EntityKind, KindMetric> = {
    person: { total: 0, caught: 0, recall: 0 },
    org: { total: 0, caught: 0, recall: 0 },
    location: { total: 0, caught: 0, recall: 0 },
  };
  const misses: NerEvalReport['misses'] = [];
  const tier1Leaks: string[] = [];
  let total = 0;
  let caught = 0;
  let spanCaught = 0;
  let secretsChecked = 0;

  let casesDone = 0;
  for (const c of cases) {
    // Fresh pseudonym map per case: recall is a per-case property, not cross-case.
    const result = await redact(c.text, { tier: 2, pseudonyms: {} }, ner);
    casesDone += 1;
    onProgress?.(casesDone, cases.length);
    const detected = result.replacements.filter((r) => r.tier === 2);

    for (const expected of c.entities) {
      total += 1;
      byKind[expected.kind].total += 1;
      const wanted = expected.text.toLowerCase();
      const sameKind = detected.some(
        (r) => r.original.toLowerCase() === wanted && r.kind === expected.kind,
      );
      const anyKind = detected.some((r) => r.original.toLowerCase() === wanted);
      if (anyKind) spanCaught += 1;
      if (sameKind) {
        caught += 1;
        byKind[expected.kind].caught += 1;
      } else {
        misses.push({
          text: expected.text,
          kind: expected.kind,
          detectedAnyKind: anyKind,
          caseText: c.text,
        });
      }
    }

    for (const secret of c.secrets ?? []) {
      secretsChecked += 1;
      if (result.redacted.includes(secret)) tier1Leaks.push(secret);
    }
  }

  for (const k of KINDS) {
    byKind[k].recall = byKind[k].total === 0 ? 1 : byKind[k].caught / byKind[k].total;
  }

  return {
    cases: cases.length,
    entities: { total, caught, recall: total === 0 ? 1 : caught / total },
    spanRecall: total === 0 ? 1 : spanCaught / total,
    byKind,
    misses,
    tier1Leaks,
    tier1SecretsChecked: secretsChecked,
  };
}

/**
 * Seeded NER evaluation corpus. ~2-3 entities/case across person/org/location,
 * in realistic sentences, several also carrying a Tier-1 secret so the device
 * run proves the floor holds while Tier-2 runs on-device. All values synthetic.
 */
export const NER_EVAL_CORPUS: NerEvalCase[] = [
  {
    text: 'Draft a letter to John Whitfield at Brightwater Logistics about the delayed shipment.',
    entities: [
      { text: 'John Whitfield', kind: 'person' },
      { text: 'Brightwater Logistics', kind: 'org' },
    ],
  },
  {
    text: 'Maria Delgado from Cascade Analytics is flying into Portland next Tuesday.',
    entities: [
      { text: 'Maria Delgado', kind: 'person' },
      { text: 'Cascade Analytics', kind: 'org' },
      { text: 'Portland', kind: 'location' },
    ],
  },
  {
    text: 'Forward the invoice to Devin Ashby; his email is d.ashby@example.com.',
    entities: [{ text: 'Devin Ashby', kind: 'person' }],
    secrets: ['d.ashby@example.com'],
  },
  {
    text: 'The Harborview Clinic on Maple Street asked for the Q3 report.',
    entities: [
      { text: 'Harborview Clinic', kind: 'org' },
      { text: 'Maple Street', kind: 'location' },
    ],
  },
  {
    text: 'Please call Priya Nair back at 617-555-0182 regarding the Ellison account.',
    entities: [
      { text: 'Priya Nair', kind: 'person' },
      { text: 'Ellison', kind: 'org' },
    ],
    secrets: ['617-555-0182'],
  },
  {
    text: 'Set up a meeting between Thomas Beckett and the team at Northgate Partners in Denver.',
    entities: [
      { text: 'Thomas Beckett', kind: 'person' },
      { text: 'Northgate Partners', kind: 'org' },
      { text: 'Denver', kind: 'location' },
    ],
  },
  {
    text: 'Sofia Marchetti moved from Milan to head the Lumen Foundation office.',
    entities: [
      { text: 'Sofia Marchetti', kind: 'person' },
      { text: 'Milan', kind: 'location' },
      { text: 'Lumen Foundation', kind: 'org' },
    ],
  },
  {
    text: 'Remind Carl Ostrander that the Redwood Municipal Court hearing is in Sacramento.',
    entities: [
      { text: 'Carl Ostrander', kind: 'person' },
      { text: 'Redwood Municipal Court', kind: 'org' },
      { text: 'Sacramento', kind: 'location' },
    ],
  },
  {
    text: 'The lease for the unit on Bennington Avenue is signed by Rebecca Lindqvist.',
    entities: [
      { text: 'Bennington Avenue', kind: 'location' },
      { text: 'Rebecca Lindqvist', kind: 'person' },
    ],
  },
  {
    text: 'Ask Grigor Petrov whether Stellar Freight Co can deliver to Tucson by Friday.',
    entities: [
      { text: 'Grigor Petrov', kind: 'person' },
      { text: 'Stellar Freight Co', kind: 'org' },
      { text: 'Tucson', kind: 'location' },
    ],
  },
  {
    text: 'Wire the deposit for the Cedar Hollow property; contact agent Nadia Rahman.',
    entities: [
      { text: 'Cedar Hollow', kind: 'location' },
      { text: 'Nadia Rahman', kind: 'person' },
    ],
  },
  {
    text: 'Ingrid Solberg at Fjordline Maritime confirmed the Bergen route.',
    entities: [
      { text: 'Ingrid Solberg', kind: 'person' },
      { text: 'Fjordline Maritime', kind: 'org' },
      { text: 'Bergen', kind: 'location' },
    ],
  },
  {
    text: 'Send the intake form for patient Owen Fairbanks to records@example.org.',
    entities: [{ text: 'Owen Fairbanks', kind: 'person' }],
    secrets: ['records@example.org'],
  },
  {
    text: 'Kenji Watanabe presented the Aerie Robotics prototype in Osaka.',
    entities: [
      { text: 'Kenji Watanabe', kind: 'person' },
      { text: 'Aerie Robotics', kind: 'org' },
      { text: 'Osaka', kind: 'location' },
    ],
  },
  {
    text: 'The Silverbrook Homeowners Association elected Denise Kowalski as treasurer.',
    entities: [
      { text: 'Silverbrook Homeowners Association', kind: 'org' },
      { text: 'Denise Kowalski', kind: 'person' },
    ],
  },
  {
    text: 'Coordinate with Marcus Trent about the Harrison Boulevard renovation in Atlanta.',
    entities: [
      { text: 'Marcus Trent', kind: 'person' },
      { text: 'Harrison Boulevard', kind: 'location' },
      { text: 'Atlanta', kind: 'location' },
    ],
  },
  {
    text: 'Elena Vasquez signed on behalf of Coastline Insurance Group.',
    entities: [
      { text: 'Elena Vasquez', kind: 'person' },
      { text: 'Coastline Insurance Group', kind: 'org' },
    ],
  },
  {
    text: 'Book travel for Dr. Alistair Cho to the Riverside Medical Center in Cleveland.',
    entities: [
      { text: 'Alistair Cho', kind: 'person' },
      { text: 'Riverside Medical Center', kind: 'org' },
      { text: 'Cleveland', kind: 'location' },
    ],
  },
  {
    text: 'Have Yusuf Demir review the Pinnacle Ventures term sheet before Monday.',
    entities: [
      { text: 'Yusuf Demir', kind: 'person' },
      { text: 'Pinnacle Ventures', kind: 'org' },
    ],
  },
  {
    text: 'The shipment from Halifax was logged by Beatrice Nolan at Tidewater Depot.',
    entities: [
      { text: 'Halifax', kind: 'location' },
      { text: 'Beatrice Nolan', kind: 'person' },
      { text: 'Tidewater Depot', kind: 'org' },
    ],
  },
  {
    text: 'Confirm with Hassan Farouk that Meridian Bank approved the loan; ref 4111 1111 1111 1111.',
    entities: [
      { text: 'Hassan Farouk', kind: 'person' },
      { text: 'Meridian Bank', kind: 'org' },
    ],
    secrets: ['4111 1111 1111 1111'],
  },
  {
    text: 'Greta Lindholm relocated the Aurora Design Studio to Reykjavik.',
    entities: [
      { text: 'Greta Lindholm', kind: 'person' },
      { text: 'Aurora Design Studio', kind: 'org' },
      { text: 'Reykjavik', kind: 'location' },
    ],
  },
  {
    text: 'Notify Raymond Kessler that the Oakmont Estates board meets on Chestnut Lane.',
    entities: [
      { text: 'Raymond Kessler', kind: 'person' },
      { text: 'Oakmont Estates', kind: 'org' },
      { text: 'Chestnut Lane', kind: 'location' },
    ],
  },
  {
    text: 'Fatima Zahra of Sahara Textiles is meeting the buyer in Casablanca.',
    entities: [
      { text: 'Fatima Zahra', kind: 'person' },
      { text: 'Sahara Textiles', kind: 'org' },
      { text: 'Casablanca', kind: 'location' },
    ],
  },
];
