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

export function createLocalNerClient(model: LocalModel): LocalNerClient {
  return {
    available: () => model.isReady(),
    generateJson: (prompt: string) => model.generateStructured(prompt, ENTITY_JSON_SCHEMA),
    embed: () => {
      throw new Error('LocalNerClient does not provide embeddings (Tier-2 NER only).');
    },
    pull: () => {
      throw new Error('LocalNerClient does not pull models (managed by the app model store).');
    },
  };
}
