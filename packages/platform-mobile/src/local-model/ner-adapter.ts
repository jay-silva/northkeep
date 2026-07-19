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
 * The prompt applyTier2 passes already contains the NER instructions and the text;
 * we additionally hand the model ENTITY_JSON_SCHEMA so Apple's / llama's guided
 * generation constrains the output to the exact {"entities":[{text,kind}]} shape.
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

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

export function createLocalNerClient(model: LocalModel): LocalNerClient {
  return {
    available: () =>
      withTimeout(Promise.resolve(model.isReady()), READY_TIMEOUT_MS, 'local model isReady').catch(
        () => false,
      ),
    generateJson: (prompt: string) =>
      withTimeout(
        model.generateStructured(prompt, ENTITY_JSON_SCHEMA),
        GENERATE_TIMEOUT_MS,
        'local NER',
      ),
    embed: () => {
      throw new Error('LocalNerClient does not provide embeddings (Tier-2 NER only).');
    },
    pull: () => {
      throw new Error('LocalNerClient does not pull models (managed by the app model store).');
    },
  };
}
