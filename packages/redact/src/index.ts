import { createOllamaClient, type OllamaClient } from '@northkeep/librarian';
import { generalizeDates } from './dates.js';
import { scrubNames } from './names.js';
import { applyTier1 } from './tier1.js';
import { applyTier2, boundaryFriendly } from './tier2.js';
import type { PseudonymMap, RedactOptions, RedactionResult, Replacement } from './types.js';

export * from './types.js';
export { applyTier1, luhnValid } from './tier1.js';
export { generalizeDates } from './dates.js';
export { findNameSpans, scrubNames } from './names.js';

/**
 * Redacts text before it goes to a cloud model. Tier-1 (deterministic
 * secrets) always runs. Tier-2 adds NER pseudonymization and DOB-labeled
 * date generalization. Tier-3 (ADR 0022) adds blanket date generalization,
 * deterministic dictionary/anchor name scrubbing, and a strict-gated NER
 * residual pass over the already-masked text.
 *
 * NER needs the local model: when it is unavailable the result is flagged
 * `tier2Degraded` and the caller must degrade LOUDLY (a degraded tier ≥ 2
 * toward a bounded endpoint must refuse to send). Tier-3's deterministic
 * layers (dates, dictionary names) run regardless — they need no model.
 *
 * Order (deliberate):
 *   Tier-1 secrets FIRST → dates → [tier 3: deterministic dictionary names,
 *   which glue multi-token names on pristine text and form a STRUCTURAL floor]
 *   → NER pass (tier 2: full recall over real names; tier 3: strict-gated
 *   residual ADD over the dict-masked text, which can only ADD masks).
 *
 * WHY the dictionary runs BEFORE the NER pass at tier 3: running NER first let
 * it mask a surname alone to a placeholder, which broke the dictionary's
 * multi-token pair rule and leaked the off-list first name to the cloud
 * ("Ravindranathan Person-1"). Dictionary-first keeps the deterministic layer
 * a true floor the NER pass can never regress below (adversarial review
 * 2026-07-21). It also collapses the old two NER passes (main + verify) into
 * the single strict-gated residual pass strictGate was designed for.
 */
export async function redact(
  text: string,
  options: RedactOptions = {},
  ollamaOverride?: OllamaClient | null,
): Promise<RedactionResult> {
  const tier = options.tier ?? 1;
  const pseudonyms: PseudonymMap = options.pseudonyms ?? {};
  const replacements: Replacement[] = [];
  let working = text;
  let tier2Degraded = false;

  // Tier-1 runs FIRST: its labeled detectors (record ids, SSNs) depend on
  // label context ("Care Report Number:") that the name scrubber may mask —
  // ordering bug found on a real ePCR (2026-07-17). Tier-1 placeholders are
  // protected from every later layer by the placeholder guards.
  const t1 = applyTier1(working);
  working = t1.text;
  replacements.push(...t1.replacements);

  if (tier >= 2) {
    const dated = generalizeDates(working, tier === 3 ? 'all' : 'dob-labeled');
    working = dated.text;
    replacements.push(...dated.replacements);

    // Known entities replay instantly from the map — no model needed. This is
    // both a correctness net for replay-only calls and a cheap first pass.
    const replayed = replayPseudonyms(working, pseudonyms);
    working = replayed.text;
    replacements.push(...replayed.replacements);

    // Tier 3: the deterministic dictionary runs FIRST so it glues multi-token
    // names on pristine text and becomes a structural floor. See the header
    // note (the NER-first ordering leaked off-list first names to the cloud).
    if (tier === 3) {
      const scrubbed = scrubNames(working, pseudonyms);
      working = scrubbed.text;
      replacements.push(...scrubbed.replacements);
    }

    if (options.nerMode !== 'replay-only') {
      const ollama = ollamaOverride !== undefined ? ollamaOverride : createOllamaClient();
      // Tier 2: NER is the only name layer, full recall over real names.
      // Tier 3: strict-gated residual pass over the dict-masked text (the
      // deterministic layer already owns common names) — a union-only ADD that
      // can only add masks, never remove one the dictionary placed.
      const t2 = await applyTier2(working, ollama, pseudonyms, tier === 3);
      working = t2.text;
      replacements.push(...t2.replacements);
      tier2Degraded = t2.degraded;
    }
  }

  return {
    redacted: working,
    replacements,
    // Convention: Tier 2's name layer IS the NER, so degraded drops it to 1.
    // Tier 3's guarantee is the DETERMINISTIC layers (leak-tested with the
    // model absent), so it stays 3 with the degraded flag marking that the
    // NER bonus net was offline (ADR 0022, field report 2026-07-18).
    tierApplied: tier === 3 ? 3 : tier === 2 && !tier2Degraded ? 2 : 1,
    tier2Degraded,
  };
}

/**
 * Deterministic-only redaction for platforms with NO local model (mobile —
 * ADR 0022 mirror): Tier-1 secrets + ALL dates to year + the deterministic
 * name layers (anchors, dictionaries, caps, pairs), with the NER union
 * simply absent rather than "degraded" — the platform never promised NER, so
 * nothing degrades and nothing refuses. Strictly stronger than Tier-1 alone.
 * Signature-compatible with runTurn's injectable redactFn, so the WHOLE
 * prompt (system + history + memories + message) passes through it per turn.
 * tierApplied reports 1: the deterministic extras are a bonus on top of the
 * Tier-1 contract, never a claim of Tier-2/3 NER parity.
 */
export async function redactDeterministic(
  text: string,
  options: RedactOptions = {},
): Promise<RedactionResult> {
  const pseudonyms: PseudonymMap = options.pseudonyms ?? {};
  const replacements: Replacement[] = [];

  const t1 = applyTier1(text);
  let working = t1.text;
  replacements.push(...t1.replacements);

  const dated = generalizeDates(working, 'all');
  working = dated.text;
  replacements.push(...dated.replacements);

  const scrubbed = scrubNames(working, pseudonyms);
  working = scrubbed.text;
  replacements.push(...scrubbed.replacements);

  return { redacted: working, replacements, tierApplied: 1, tier2Degraded: false };
}

/**
 * Replay KNOWN pseudonyms over text with no model: every original already in
 * the map is replaced wherever it appears (whole-word, case-insensitive,
 * longest-first so "Bob Henderson" wins over "Bob").
 */
export function replayPseudonyms(
  text: string,
  pseudonyms: PseudonymMap,
): { text: string; replacements: Replacement[] } {
  const entries = Object.entries(pseudonyms).sort((a, b) => b[0].length - a[0].length);
  const replacements: Replacement[] = [];
  let out = text;
  for (const [original, placeholder] of entries) {
    if (original.length < 2) continue;
    // Unicode-aware boundaries (not ASCII \b) so non-Latin pseudonyms replay too.
    const esc = original.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])`, 'giu');
    if (re.test(out)) {
      out = out.replace(re, placeholder);
    } else if (!boundaryFriendly(original) && out.includes(original)) {
      // Non-space-delimited / unlisted script: boundaries unreliable; mask the
      // exact span (over-masking is the safe direction; see boundaryFriendly).
      out = out.split(original).join(placeholder);
    } else {
      continue;
    }
    if (!replacements.some((r) => r.placeholder === placeholder)) {
      replacements.push({ placeholder, original, tier: 2, kind: 'person', restorable: true });
    }
  }
  return { text: out, replacements };
}

/**
 * Restores a model's response by putting restorable originals (Tier-2
 * pseudonyms) back. Tier-1 secrets are one-way and stay masked. Longest
 * placeholders first so `Person-1` isn't clobbered by a `Person-1` prefix of
 * `Person-10`.
 */
export function restore(text: string, replacements: Replacement[]): string {
  const restorable = replacements
    .filter((r) => r.restorable)
    .sort((a, b) => b.placeholder.length - a.placeholder.length);
  let out = text;
  for (const r of restorable) {
    out = out.split(r.placeholder).join(r.original);
  }
  return out;
}
