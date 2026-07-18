import { createOllamaClient, type OllamaClient } from '@northkeep/librarian';
import { generalizeDates } from './dates.js';
import { scrubNames } from './names.js';
import { applyTier1 } from './tier1.js';
import { applyTier2 } from './tier2.js';
import type { PseudonymMap, RedactOptions, RedactionResult, Replacement } from './types.js';

export * from './types.js';
export { applyTier1, luhnValid } from './tier1.js';
export { generalizeDates } from './dates.js';
export { findNameSpans, scrubNames } from './names.js';

/**
 * Redacts text before it goes to a cloud model. Tier-1 (deterministic
 * secrets) always runs. Tier-2 adds NER pseudonymization and DOB-labeled
 * date generalization. Tier-3 (ADR 0022) adds blanket date generalization,
 * deterministic dictionary/anchor name scrubbing, and an NER verify pass.
 *
 * NER needs the local model: when it is unavailable the result is flagged
 * `tier2Degraded` and the caller must degrade LOUDLY (a degraded tier ≥ 2
 * toward a bounded endpoint must refuse to send). Tier-3's deterministic
 * layers (dates, dictionary names) run regardless — they need no model.
 *
 * Order (deliberate):
 *   dates → NER pass (sees real names) → deterministic names → NER verify
 *   (tier 3 only; can only ADD masks) → Tier-1 secrets over the result.
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

  if (tier >= 2) {
    const dated = generalizeDates(working, tier === 3 ? 'all' : 'dob-labeled');
    working = dated.text;
    replacements.push(...dated.replacements);

    const ollama = ollamaOverride !== undefined ? ollamaOverride : createOllamaClient();
    const t2 = await applyTier2(working, ollama, pseudonyms, tier === 3);
    working = t2.text;
    replacements.push(...t2.replacements);
    tier2Degraded = t2.degraded;

    if (tier === 3) {
      const scrubbed = scrubNames(working, pseudonyms);
      working = scrubbed.text;
      replacements.push(...scrubbed.replacements);
      if (!tier2Degraded) {
        // Verify pass: NER over the already-masked text — union only, so it
        // can catch what both the first pass and the dictionaries missed.
        const verify = await applyTier2(working, ollama, pseudonyms, true);
        working = verify.text;
        replacements.push(...verify.replacements);
        tier2Degraded = verify.degraded;
      }
    }
  }

  const t1 = applyTier1(working);
  working = t1.text;
  replacements.push(...t1.replacements);

  return {
    redacted: working,
    replacements,
    // Convention: tierApplied is the highest tier whose FULL pipeline ran.
    // A degraded NER drops it to 1 even though Tier-3's deterministic layers
    // still applied (their masks are in `replacements` regardless); the
    // degraded flag is what callers must act on.
    tierApplied: tier >= 2 && !tier2Degraded ? tier : 1,
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

  const dated = generalizeDates(text, 'all');
  let working = dated.text;
  replacements.push(...dated.replacements);

  const scrubbed = scrubNames(working, pseudonyms);
  working = scrubbed.text;
  replacements.push(...scrubbed.replacements);

  const t1 = applyTier1(working);
  working = t1.text;
  replacements.push(...t1.replacements);

  return { redacted: working, replacements, tierApplied: 1, tier2Degraded: false };
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
