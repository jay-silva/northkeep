import { redact } from '@northkeep/redact';
import {
  createLocalNerClient,
  detectLocalModel,
  type LocalModel,
  type LocalModelResolution,
} from '@northkeep/platform-mobile/dist/local-model/index.js';

/**
 * App-side glue for the on-device model (M6-4). Two things Converse needs:
 *   - detect which backend (if any) is present, memoized;
 *   - a redactFn bound to the local NER client so runTurn's Tier-2 step
 *     pseudonymizes entities ON THE PHONE, producing the desktop-identical
 *     shape (createLocalNerClient -> applyTier2, unchanged).
 *
 * Detection is Apple-only for now: the llama.rn GGUF needs a model-download/store
 * flow (deferred; see the M6-4 report). When neither backend is ready, resolution
 * is { model: null, backend: 'none' } and Converse keeps Tier-1 as the floor with
 * the loud banner (invariant #6).
 */

let cached: Promise<LocalModelResolution> | null = null;

/** Memoized detection. Call `resetLocalModel()` after a model is downloaded. */
export function getLocalModel(): Promise<LocalModelResolution> {
  if (!cached) cached = detectLocalModel();
  return cached;
}

export function resetLocalModel(): void {
  cached = null;
}

/**
 * A `typeof redact` function bound to the on-device NER client. runTurn calls it
 * with (text, { tier: 2, pseudonyms }); we supply the third argument (the client)
 * so redact skips its default localhost Ollama and uses the phone's model. If the
 * model errors, applyTier2 marks the turn tier2Degraded and runTurn aborts a
 * bounded-endpoint send (loud, never silent).
 */
export function makeLocalTier2RedactFn(model: LocalModel): typeof redact {
  const client = createLocalNerClient(model);
  return (text, options) => redact(text, options, client);
}
