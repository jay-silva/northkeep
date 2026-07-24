/**
 * Pure span -> entities mapping for the on-device NLTagger name net (M6-4
 * follow-up, replaces the Apple FM NER path 2026-07-21).
 *
 * NLTagger (NaturalLanguage) returns structured name spans directly, so there
 * is NO LLM and NO model JSON to salvage/parse: the native module hands back an
 * array of { text, kind } and this module validates it into the exact
 * {"entities":[{"text","kind"}]} string that packages/redact applyTier2 already
 * parses. That means the redact pipeline runs UNCHANGED behind the same
 * OllamaClient-shaped seam (available() / generateJson()).
 *
 * This file is deliberately pure (no React Native / Expo / native imports) so
 * the mapping is unit-tested under Node in apps/mobile/test/nltagger-spans.test.ts.
 * The native call and the requireNativeModule edge live in nltagger-ner.ts.
 *
 * Validation is intentionally light: applyTier2 re-validates every span
 * downstream (span-must-appear-in-text, the strict plausibility gate, and
 * longest-first pseudonym assignment), so this only needs to drop obvious junk
 * and hand over a clean, deduped list.
 */

/** One raw span as returned by the native NlTagger.tagNames call. */
export interface NlTaggerSpan {
  text: string;
  kind: string;
}

/** The three kinds the pipeline pseudonymizes; NLTagger only emits these, but
 * we still guard so an unexpected tag never reaches applyTier2 as a bogus
 * kind. applyTier2 would coerce an unknown kind to 'person'; dropping it here
 * is cleaner and keeps the wire contract honest. */
const VALID_KINDS = new Set(['person', 'org', 'location']);

/**
 * Map/validate NLTagger spans to the {"entities":[{text,kind}]} JSON string.
 * Drops empty/blank spans and any span whose kind is not person/org/location,
 * and collapses case-insensitive EXACT duplicates (the same span tagged twice),
 * keeping the first occurrence. Overlapping-but-different spans are ALL kept:
 * applyTier2 sorts longest-first and masks whole-word, so nested spans are
 * handled correctly there (dropping a contained span here would leak a
 * standalone occurrence elsewhere).
 */
export function spansToEntitiesJson(spans: readonly NlTaggerSpan[]): string {
  const seen = new Set<string>();
  const entities: NlTaggerSpan[] = [];
  for (const span of spans) {
    if (span == null || typeof span.text !== 'string' || typeof span.kind !== 'string') continue;
    const text = span.text.trim();
    if (text.length === 0) continue;
    if (!VALID_KINDS.has(span.kind)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entities.push({ text, kind: span.kind });
  }
  return JSON.stringify({ entities });
}
