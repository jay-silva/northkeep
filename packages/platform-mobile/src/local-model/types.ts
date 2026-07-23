/**
 * LocalModel — the on-device LLM seam (M6-4, ADR 0020).
 *
 * This is the mobile substitute for the desktop Ollama loopback. Two purposes,
 * both fully on-device (no network, so invariant #7's network trigger does not
 * apply to inference — the model-file download for the llama backend is the one
 * networked step, called out in ADR 0020):
 *
 *   1. Tier-2 NER pseudonymization on the phone (via `generateStructured`), so
 *      the existing `packages/redact` applyTier2 runs UNCHANGED and emits the
 *      SAME desktop entity shape ({"entities":[{"text","kind"}]}).
 *   2. Airplane-mode private chat (via `generateText`), so Converse can select an
 *      on-device provider and run with NO cloud key and NO egress.
 *
 * Two implementations satisfy this interface:
 *   - AppleFMModel  (primary; iOS 26+ Apple Intelligence hardware) — apple-fm.ts
 *   - LlamaRnModel  (fallback + Android baseline; GGUF via llama.cpp) — llama-rn.ts
 *
 * DEGRADE LOUDLY (invariant #6): when no backend is present, detection returns
 * null and the caller keeps Tier-1 as the guaranteed floor with a visible
 * banner — it NEVER silently drops a privacy tier.
 *
 * DEVICE-UNVERIFIED: every implementation here compiles against ambient module
 * declarations (rn-modules.d.ts) and has NOT been run on a device. The upstream
 * native APIs (@react-native-ai/apple, llama.rn) are pinned from their published
 * docs/types as of July 2026; the on-device compile inside apps/mobile plus a
 * real device run (ADR 0020 acceptance) are the second and third lines of
 * defense before any of this is trusted with real vault content.
 */

export type LocalBackend = 'apple' | 'llama';

export interface LocalChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LocalGenerateOptions {
  /** Streamed tokens as they are produced (Converse live typing). */
  onToken?: (token: string) => void;
  signal?: AbortSignal;
  maxTokens?: number;
}

/**
 * A minimal JSON-Schema object describing the desired structured output. Kept
 * deliberately loose (not a full JSON-Schema type) so the redact side can hand
 * over the entity schema without this package importing a schema library. Apple
 * feeds it to the AI SDK's guided generation; llama feeds it to a JSON grammar
 * so the tokens are constrained at decode time.
 */
export type LocalJsonSchema = Record<string, unknown>;

export interface LocalModel {
  readonly backend: LocalBackend;
  /** Human label for the UI, e.g. "Apple Intelligence" or "Llama 3.2 3B". */
  readonly label: string;

  /**
   * True when this backend is present AND ready to generate on THIS device
   * (Apple Intelligence enabled + model resident; or a GGUF file loaded into a
   * llama context). Cheap to call; used by availability detection and the
   * loud-degradation check.
   */
  isReady(): Promise<boolean>;

  /**
   * Free-form chat completion for the on-device Converse provider. Returns the
   * complete reply; streams via `options.onToken` when the backend supports it.
   */
  generateText(messages: LocalChatMessage[], options?: LocalGenerateOptions): Promise<string>;

  /**
   * Constrained generation: produce JSON matching `schema` for `prompt`,
   * returned as a STRING (so it drops straight into the OllamaClient-shaped
   * adapter's `generateJson`, which `applyTier2` already parses). Apple uses
   * native guided generation; llama uses a JSON grammar; both fall back to
   * prompt-then-parse when guided generation is unavailable.
   */
  generateStructured(prompt: string, schema: LocalJsonSchema): Promise<string>;

  /** Release native resources (llama context); no-op for Apple. */
  dispose?(): Promise<void>;
}

/**
 * The desktop-identical NER output shape. Kept next to the interface that
 * produces it so the schema and the wire contract never drift apart. Matches
 * the prompt in packages/redact/src/tier2.ts.
 */
export const ENTITY_JSON_SCHEMA: LocalJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['entities'],
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'kind'],
        properties: {
          text: { type: 'string' },
          kind: { type: 'string', enum: ['person', 'org', 'location'] },
        },
      },
    },
  },
};
