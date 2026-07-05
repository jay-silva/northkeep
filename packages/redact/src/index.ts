import { createOllamaClient, type OllamaClient } from '@northkeep/librarian';
import { applyTier1 } from './tier1.js';
import { applyTier2 } from './tier2.js';
import type { PseudonymMap, RedactOptions, RedactionResult, Replacement } from './types.js';

export * from './types.js';
export { applyTier1, luhnValid } from './tier1.js';

/**
 * Redacts text before it goes to a cloud model. Tier-1 (deterministic
 * secrets) always runs; Tier-2 (entity pseudonymization) runs when requested
 * AND a local model is available — otherwise the result is flagged
 * `tier2Degraded` and the caller must say so out loud.
 *
 * Order: Tier-2 first (on the raw text, so the model sees real names to
 * classify), then Tier-1 over the result (so any secret the NER left behind
 * is still caught deterministically).
 */
export async function redact(
  text: string,
  options: RedactOptions = {},
  ollamaOverride?: OllamaClient | null,
): Promise<RedactionResult> {
  const wantTier2 = options.tier === 2;
  const pseudonyms: PseudonymMap = options.pseudonyms ?? {};
  const replacements: Replacement[] = [];
  let working = text;
  let tier2Degraded = false;

  if (wantTier2) {
    const ollama = ollamaOverride !== undefined ? ollamaOverride : createOllamaClient();
    const t2 = await applyTier2(working, ollama, pseudonyms);
    working = t2.text;
    replacements.push(...t2.replacements);
    tier2Degraded = t2.degraded;
  }

  const t1 = applyTier1(working);
  working = t1.text;
  replacements.push(...t1.replacements);

  return {
    redacted: working,
    replacements,
    tierApplied: wantTier2 && !tier2Degraded ? 2 : 1,
    tier2Degraded,
  };
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
