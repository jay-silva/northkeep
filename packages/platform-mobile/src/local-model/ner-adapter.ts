import {
  NerPassTimeoutError,
  extractNerText,
  runPerKindNer,
  type NerPassEvent,
} from './per-kind-ner.js';
import { ENTITY_JSON_SCHEMA, type LocalModel } from './types.js';

/**
 * The Tier-2 NER seam: adapt a LocalModel into the SAME shape the desktop uses,
 * so `packages/redact` applyTier2 runs UNCHANGED on the phone and emits the
 * identical entity/pseudonym output.
 *
 * `packages/redact` calls its Ollama client with only two methods during Tier-2:
 * `available()` and `generateJson(prompt)`. This adapter implements the full
 * @northkeep/librarian `OllamaClient` surface so it drops straight into
 * `redact(text, opts, client)` (structurally — platform-mobile deliberately does
 * NOT depend on librarian). `embed`/`pull` are never reached by applyTier2 and
 * throw loudly if some future caller does reach them, rather than pretending to
 * work.
 *
 * The prompt applyTier2 passes already contains the NER instructions and the text.
 * Since the per-kind change (see per-kind-ner.ts), `generateJson` does NOT send
 * that prompt to the model verbatim: it recovers the text at the 'Text:' marker
 * and runs K focused per-kind passes sequentially, merging the entity lists into
 * the ONE {"entities":[{text,kind}]} reply applyTier2 parses. From redact()'s
 * point of view nothing changed: one call in, one JSON string out, same schema.
 * If the marker is ever absent (unexpected prompt shape), the adapter falls back
 * to the legacy single pass so behavior never regresses. ENTITY_JSON_SCHEMA is
 * still handed to generateStructured for backends with working guided generation.
 */

/** Progress record shape mirrored from librarian's PullProgress (unused here). */
export interface LocalPullProgress {
  status: string;
  completedBytes?: number;
  totalBytes?: number;
}

/** Structurally equals @northkeep/librarian's OllamaClient. */
export interface LocalNerClient {
  available(): Promise<boolean>;
  generateJson(prompt: string): Promise<string>;
  embed(text: string): Promise<number[]>;
  pull(model: string, onProgress?: (p: LocalPullProgress) => void): Promise<void>;
}

/** Hard per-call ceilings. An in-process Apple FM call has no transport layer
 * to time out for us; if the model session wedges, an unguarded await hangs
 * the ENTIRE turn forever (field report 2026-07-19). A rejection here flows
 * through applyTier2 as tier2Degraded, and at tier 3 the send PROCEEDS on the
 * deterministic shield — bounded latency, never a frozen chat. */
const GENERATE_TIMEOUT_MS = 25_000;
const READY_TIMEOUT_MS = 5_000;

/** NOTE: this is a bare Promise.race, not a cancellation: generateStructured
 * takes no abort signal, so on timeout the underlying native call KEEPS
 * RUNNING. `makeError` lets the per-pass path reject with NerPassTimeoutError,
 * which runPerKindNer treats as "the bridge is wedged, abandon this run"
 * rather than "try the next pass" (stacking calls on the single-call-only
 * Apple FM bridge is what wedges a whole turn). */
function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  what: string,
  makeError: (message: string) => Error = (message) => new Error(message),
): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(makeError(`${what} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

/** Optional observer hooks. `onNerPass` fires after each internal per-kind
 * model pass (or the legacy fallback pass, id 'single'); the eval screen uses
 * it for per-kind calls/errors/latency diagnostics. */
export interface LocalNerHooks {
  onNerPass?: (event: NerPassEvent) => void;
}

export function createLocalNerClient(model: LocalModel, hooks?: LocalNerHooks): LocalNerClient {
  return {
    available: () =>
      withTimeout(Promise.resolve(model.isReady()), READY_TIMEOUT_MS, 'local model isReady').catch(
        () => false,
      ),
    generateJson: async (prompt: string) => {
      const text = extractNerText(prompt);
      if (text === null) {
        // Not the applyTier2 NER prompt shape: keep the original single-call
        // behavior, still visible to diagnostics as pass 'single'.
        const start = Date.now();
        try {
          const raw = await withTimeout(
            model.generateStructured(prompt, ENTITY_JSON_SCHEMA),
            GENERATE_TIMEOUT_MS,
            'local NER',
          );
          hooks?.onNerPass?.({ pass: 'single', ok: true, ms: Date.now() - start, raw });
          return raw;
        } catch (err) {
          hooks?.onNerPass?.({
            pass: 'single',
            ok: false,
            ms: Date.now() - start,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      }
      // Per-kind decomposition: K sequential focused passes, merged into the
      // one {"entities":[...]} string applyTier2 expects. A parse-failed pass
      // is recorded and the others continue; a TIMED-OUT pass abandons the
      // remaining passes (NerPassTimeoutError, see withTimeout above); only
      // zero successful passes throws (-> degraded).
      return runPerKindNer(
        text,
        (passPrompt, timeoutMs) =>
          withTimeout(
            model.generateStructured(passPrompt, ENTITY_JSON_SCHEMA),
            timeoutMs,
            'local NER pass',
            (message) => new NerPassTimeoutError(message),
          ),
        { onPass: hooks?.onNerPass },
      );
    },
    embed: () => {
      throw new Error('LocalNerClient does not provide embeddings (Tier-2 NER only).');
    },
    pull: () => {
      throw new Error('LocalNerClient does not pull models (managed by the app model store).');
    },
  };
}
