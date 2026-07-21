import type { OllamaClient } from '@northkeep/librarian';
import { redact } from './index.js';
import { noSpaceScript } from './tier2.js';
import type { EntityKind } from './types.js';

/**
 * Redaction evaluation harness — the M6-4 GATE (ADR 0020).
 *
 * Two distinct measurements live here; keeping them apart is the whole point
 * (adversarial review 2026-07-21):
 *
 *  1. TIER-2 MODEL-IN-ISOLATION recall (evaluateNer) — a DIAGNOSTIC of the NER
 *     model ALONE, with NO deterministic dictionary floor under it. This is
 *     where the old "Apple FM 35-39%" number came from. It is NOT the shipped
 *     posture and must NEVER be read as production recall: mobile cloud chat
 *     ships redactTier: 3, where a deterministic name dictionary runs FIRST as a
 *     structural floor and the NER model is only an additive net on top. This
 *     number is kept ONLY so a silent NER-model regression stays visible.
 *
 *  2. TIER-3 PIPELINE truth (evaluateTier3Monotonicity) — the SHIPPED tier-3
 *     pipeline (dictionary floor + NER net). It reports the production wire-leak
 *     metric (per person name, does any token survive in the redacted output)
 *     AND, load-bearing, FLOOR-MONOTONICITY: the full pipeline must never leave
 *     in plaintext a name token that the dictionary-only floor masks. A tier-3
 *     "high recall" number alone would NOT have caught the Ravindranathan leak
 *     (commit 8435d12, where NER-before-dictionary ordering broke the dict's
 *     multi-token pair rule and leaked an off-list first name to the cloud).
 *
 * evaluateRedaction(cases, ner) returns BOTH so a report never confuses the
 * model-in-isolation diagnostic for the production-truth number.
 *
 * The SAME evaluateNer scores the desktop Ollama baseline (createOllamaClient())
 * and the on-device net (createNLTaggerNerClient / createLocalNerClient —
 * structurally an OllamaClient), from a device runner, so parity is
 * apples-to-apples, not a vibe.
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
 * DIAGNOSTIC: evaluate a NER backend IN ISOLATION at Tier-2 (no dictionary
 * floor). `ner` is an OllamaClient (desktop) or the on-device NER client
 * (structurally compatible). `null` measures the no-model floor (recall 0, no
 * leaks) — useful to prove the harness runs even when degraded.
 *
 * The returned recall is the NER MODEL'S standalone recall, NOT the shipped
 * production posture (production ships Tier-3, where the deterministic
 * dictionary is the floor and NER is only an additive net). Use
 * evaluateTier3Monotonicity for the production-truth no-leak number. This path
 * exists so a silent NER-model regression stays visible even when the Tier-3
 * dictionary would otherwise mask the same names.
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

// ---------------------------------------------------------------------------
// TIER-3 PIPELINE EVAL: production truth + floor-monotonicity (the safety check)
// ---------------------------------------------------------------------------

/** A single below-floor leak: the dictionary-only floor masked this token of an
 * expected person name, yet the full pipeline (dict + NER) left it in plaintext.
 * ANY of these is a MONOTONICITY VIOLATION — the NER net regressed below the
 * deterministic floor, the exact class of the Ravindranathan leak. */
export interface Tier3MonotonicityViolation {
  /** The full expected person-name span the leaked token belongs to. */
  expectedName: string;
  /** The whole-word token that survived in the full output but not the floor. */
  leakedToken: string;
  /** The case text, so the violation is reproducible from the report alone. */
  caseText: string;
}

/** A person name with at least one token surviving as a whole word in an output
 * (the plain wire-leak metric, reported for both floor and full separately). */
export interface Tier3NameLeak {
  name: string;
  survivingTokens: string[];
  caseText: string;
}

export interface Tier3MonotonicityReport {
  cases: number;
  /** Expected person-name spans scored across the corpus. */
  personNames: number;
  /**
   * The load-bearing safety metric. MUST be empty: a non-empty list means the
   * full pipeline left in plaintext a name token the deterministic floor masked
   * (a real leak class the naive "tier-3 = high recall" eval would hide).
   */
  violations: Tier3MonotonicityViolation[];
  /** Production truth: fraction of person names with NO token surviving in the
   * FULL (dict + NER) output. This is the shipped no-leak posture. */
  fullNoLeakRate: number;
  /** Same metric for the dictionary-ONLY floor, so the two are directly
   * comparable — the NER net can only push this up, never down. */
  floorNoLeakRate: number;
  /** Names that still leak a token through the full pipeline (should be rare;
   * these lean on residual NER and are the honest KNOWN-LIMITS surface). */
  fullLeaks: Tier3NameLeak[];
  /** Names the floor alone leaks — the gap the NER net exists to close. */
  floorLeaks: Tier3NameLeak[];
}

/** Combined report: the model-in-isolation DIAGNOSTIC and the production-truth
 * tier-3 numbers, side by side, so a reader can never mistake one for the other. */
export interface RedactionEvalReport {
  /** DIAGNOSTIC ONLY — NER model alone at Tier-2, NOT the shipped posture. */
  tier2Diagnostic: NerEvalReport;
  /** PRODUCTION TRUTH — the shipped Tier-3 pipeline (dict floor + NER net). */
  tier3: Tier3MonotonicityReport;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whitespace-split tokens of a name span, minus initials/punctuation (a bare
 * "J." is not a leakable name token). Kept pure and exported-adjacent so the
 * monotonicity detector and the wire-leak metric agree on "token". */
function nameTokens(name: string): string[] {
  return name
    .split(/\s+/)
    // Strip leading/trailing NON-LETTER (any script) chars, not just non-Latin,
    // so a non-Latin token ("Пётр", "田中") is kept whole instead of stripped to
    // "" and the leak becoming invisible to the gate (adversarial review
    // 2026-07-21).
    .map((t) => t.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''))
    .filter((t) => t.length >= 2);
}

/** Whole-word (case-insensitive) presence of `token` in `text`. This is the wire
 * test: a name token that survives as a whole word in the redacted string is
 * plaintext going to the cloud. */
function tokenSurvives(token: string, text: string): boolean {
  // No-space / clitic scripts (CJK/Thai/Arabic/Hebrew/Hangul, all caseless):
  // word boundaries are unreliable, so substring PRESENCE is the leak signal —
  // otherwise the gate reports leaking scriptio-continua text as clean
  // (adversarial re-review 2026-07-21).
  if (noSpaceScript(token)) return text.includes(token);
  // Latin/Cyrillic/Greek: case-insensitive Unicode WHOLE-WORD, so a token is
  // caught regardless of case ("TRENT") but not flagged inside a longer word
  // ("Ann" in "Anna").
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(token)}(?![\\p{L}\\p{N}_])`, 'iu').test(text);
}

/** Tokens of `name` that survive as whole words in `redacted` (empty = no leak). */
function survivingTokens(name: string, redacted: string): string[] {
  return nameTokens(name).filter((t) => tokenSurvives(t, redacted));
}

/**
 * PURE monotonicity detector — the check that would have caught Ravindranathan.
 *
 * Contract: for each expected person-name span, a token is a BELOW-FLOOR LEAK
 * when it is ABSENT (as a whole word, case-insensitive) from `floorRedacted`
 * but PRESENT in `fullRedacted`. In words: the deterministic dictionary-only
 * floor masked that token, yet the full dict+NER pipeline left it in plaintext.
 * Because the dictionary runs first and identically in both, and the NER net can
 * only ADD masks, a correct pipeline yields ZERO such tokens; any hit means the
 * NER layer somehow un-masked what the floor guaranteed — a regression below the
 * floor. Exported so tests can drive it directly with crafted floor/full strings.
 */
export function findBelowFloorLeaks(
  personNames: string[],
  floorRedacted: string,
  fullRedacted: string,
): Array<{ expectedName: string; leakedToken: string }> {
  const leaks: Array<{ expectedName: string; leakedToken: string }> = [];
  for (const name of personNames) {
    for (const token of nameTokens(name)) {
      const inFloor = tokenSurvives(token, floorRedacted);
      const inFull = tokenSurvives(token, fullRedacted);
      if (!inFloor && inFull) leaks.push({ expectedName: name, leakedToken: token });
    }
  }
  return leaks;
}

/**
 * Evaluate the SHIPPED Tier-3 pipeline. For each case it computes two redactions
 * of the SAME text with a fresh pseudonym map:
 *   - floor = redact(text, {tier:3}, null)  — dictionary only, NO NER
 *   - full  = redact(text, {tier:3}, ner)   — dictionary + the NER net
 * then (a) collects floor-monotonicity violations via findBelowFloorLeaks (the
 * safety metric — MUST be empty) and (b) records the per-name wire-leak metric
 * for both floor and full so the NER net's contribution is legible and the full
 * number is never confused with the model-in-isolation diagnostic.
 *
 * Pure over the injected `ner` (OllamaClient shape). `null` makes full == floor
 * (0 violations, equal no-leak rates) — the degraded-but-safe case.
 */
export async function evaluateTier3Monotonicity(
  cases: NerEvalCase[],
  ner: OllamaClient | null,
  onProgress?: (done: number, total: number) => void,
): Promise<Tier3MonotonicityReport> {
  const violations: Tier3MonotonicityViolation[] = [];
  const fullLeaks: Tier3NameLeak[] = [];
  const floorLeaks: Tier3NameLeak[] = [];
  let personNames = 0;
  let fullNoLeak = 0;
  let floorNoLeak = 0;
  let done = 0;

  for (const c of cases) {
    const persons = c.entities.filter((e) => e.kind === 'person').map((e) => e.text);
    // Fresh pseudonym maps: floor and full must be independent measurements.
    const floor = await redact(c.text, { tier: 3, pseudonyms: {} }, null);
    const full = await redact(c.text, { tier: 3, pseudonyms: {} }, ner);
    done += 1;
    onProgress?.(done, cases.length);

    for (const leak of findBelowFloorLeaks(persons, floor.redacted, full.redacted)) {
      violations.push({ ...leak, caseText: c.text });
    }

    for (const name of persons) {
      personNames += 1;
      const fullSurv = survivingTokens(name, full.redacted);
      const floorSurv = survivingTokens(name, floor.redacted);
      if (fullSurv.length === 0) fullNoLeak += 1;
      else fullLeaks.push({ name, survivingTokens: fullSurv, caseText: c.text });
      if (floorSurv.length === 0) floorNoLeak += 1;
      else floorLeaks.push({ name, survivingTokens: floorSurv, caseText: c.text });
    }
  }

  return {
    cases: cases.length,
    personNames,
    violations,
    fullNoLeakRate: personNames === 0 ? 1 : fullNoLeak / personNames,
    floorNoLeakRate: personNames === 0 ? 1 : floorNoLeak / personNames,
    fullLeaks,
    floorLeaks,
  };
}

/**
 * Run BOTH measurements against the same NER backend: the Tier-2
 * model-in-isolation DIAGNOSTIC and the Tier-3 PRODUCTION-truth pipeline eval.
 * Progress spans both halves so a device UI shows one continuous bar.
 */
export async function evaluateRedaction(
  cases: NerEvalCase[],
  ner: OllamaClient | null,
  onProgress?: (done: number, total: number) => void,
): Promise<RedactionEvalReport> {
  const total = cases.length * 2;
  let done = 0;
  const bump = () => {
    done += 1;
    onProgress?.(done, total);
  };
  const tier2Diagnostic = await evaluateNer(cases, ner, bump);
  const tier3 = await evaluateTier3Monotonicity(cases, ner, bump);
  return { tier2Diagnostic, tier3 };
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
