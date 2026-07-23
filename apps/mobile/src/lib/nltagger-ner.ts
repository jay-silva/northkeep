import { extractNerText } from '@northkeep/platform-mobile/dist/local-model/index.js';
import { spansToEntitiesJson, type NlTaggerSpan } from './nltagger-spans';

/**
 * The on-device NLTagger name net, shaped as the OllamaClient the redact()
 * pipeline calls at Tier 2/3 (available() + generateJson()). This REPLACES the
 * fragile Apple Foundation Models NER client (createLocalNerClient +
 * per-kind-ner) as the mobile name net (retired 2026-07-21, kept for rollback).
 *
 * Why NLTagger: it ships in every iOS (NaturalLanguage framework), needs NO
 * download and NO Apple Intelligence, is free, and returns structured name
 * spans directly. So unlike the Apple FM path there are no per-kind passes, no
 * JSON salvage, no dup-key repair, and no model-detection/download gate: the
 * net is ALWAYS available on iOS once the native module is compiled in.
 *
 * The pipeline is unchanged behind the seam: redact() runs its deterministic
 * dictionary floor first, then hands the dict-masked text here as one
 * strict-gated pass. generateJson recovers that text at the '\nText:\n' marker
 * (extractNerText, shared with the retired client), calls the native tagNames
 * once, and maps the spans via the pure spansToEntitiesJson. applyTier2 then
 * validates every span (span-in-text, strict plausibility gate, longest-first
 * pseudonyms) exactly as before.
 *
 * DEGRADE LOUDLY (invariant #6): available() guards requireNativeModule in a
 * try/catch, so on Android or any device where the module is absent it resolves
 * false and applyTier2 falls to the deterministic Tier-1 floor + degraded flag
 * (the audit warns). If the native call itself throws mid-turn, generateJson
 * rejects and applyTier2 marks tier2Degraded and PROCEEDS on the deterministic
 * layers (redact tier-3 semantics) — never a silently dropped tier.
 *
 * Only generateJson's native tagNames call needs a device/EAS build to verify;
 * the mapping (spansToEntitiesJson) and prompt extraction are unit-tested.
 */

/** Structural shape of the native NlTagger module (modules/nl-tagger). */
interface NlTaggerNative {
  tagNames(text: string): Promise<NlTaggerSpan[]>;
}

/** Progress record shape mirrored from librarian's PullProgress (unused here). */
interface LocalPullProgress {
  status: string;
  completedBytes?: number;
  totalBytes?: number;
}

/** Structurally equals @northkeep/librarian's OllamaClient, so it drops
 * straight into redact(text, options, client). applyTier2 only reaches
 * available()/generateJson(); embed/pull throw loudly if some future caller
 * ever reaches them, rather than pretending to work. */
export interface NLTaggerNerClient {
  available(): Promise<boolean>;
  generateJson(prompt: string): Promise<string>;
  embed(text: string): Promise<number[]>;
  pull(model: string, onProgress?: (p: LocalPullProgress) => void): Promise<void>;
}

const EMPTY_ENTITIES = '{"entities":[]}';

/**
 * True when the native NlTagger module is present on THIS device. On iOS with
 * the module compiled in this is always true (NLTagger is part of the OS); on
 * Android or any platform without the module, requireNativeModule throws and
 * this resolves false. Used both by the client's available() and by the UI tier
 * badge, so the badge reflects the exact condition the send path keys on.
 */
export async function isNLTaggerNerAvailable(): Promise<boolean> {
  try {
    const { requireNativeModule } = await import('expo');
    requireNativeModule<NlTaggerNative>('NlTagger');
    return true;
  } catch {
    return false;
  }
}

export function createNLTaggerNerClient(): NLTaggerNerClient {
  return {
    available: () => isNLTaggerNerAvailable(),
    generateJson: async (prompt: string) => {
      const text = extractNerText(prompt);
      // No marker (unexpected prompt shape) or empty text: nothing to tag. The
      // deterministic layers already ran; returning "no entities" is correct
      // and never degrades the turn.
      if (text === null || text.trim().length === 0) return EMPTY_ENTITIES;
      const { requireNativeModule } = await import('expo');
      const NlTagger = requireNativeModule<NlTaggerNative>('NlTagger');
      const spans = await NlTagger.tagNames(text);
      return spansToEntitiesJson(spans ?? []);
    },
    embed: () => {
      throw new Error('NLTaggerNerClient does not provide embeddings (Tier-2 name net only).');
    },
    pull: () => {
      throw new Error('NLTaggerNerClient does not pull models (NLTagger is part of iOS).');
    },
  };
}
