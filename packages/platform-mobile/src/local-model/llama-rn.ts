import { initLlama, type LlamaContext } from 'llama.rn';
import type {
  LocalChatMessage,
  LocalGenerateOptions,
  LocalJsonSchema,
  LocalModel,
} from './types.js';

/**
 * LlamaRnModel — fallback backend + Android baseline (ADR 0020).
 *
 * Runs a GGUF model through llama.cpp via llama.rn. Used when Apple Intelligence
 * is unavailable (older iPhones, iPad without M-series, all Android). The model
 * file is downloaded post-install (NOT bundled — a ~1-2 GB GGUF would blow the app
 * size limit); that download is the one networked step in M6-4 and is called out
 * in ADR 0020 (it fetches a model artifact, not user content).
 *
 * Structured output uses llama.cpp's `response_format: { type: 'json_schema' }`,
 * which compiles the JSON Schema to a GBNF grammar and CONSTRAINS decoding — the
 * same reliability win Apple gets from native guided generation, and the reason a
 * 1-3B model can still emit parseable Tier-2 NER JSON.
 *
 * DEVICE-UNVERIFIED: not yet run on hardware, and the eval gate (leak-corpus recall)
 * decides whether a 1-3B GGUF is good enough to enable Tier-2, or whether llama is
 * private-chat-only. See types.ts and the eval harness.
 */

export interface LlamaRnModelConfig {
  /** file:// path to the downloaded GGUF (managed by the app's model store). */
  modelPath: string;
  /** Context window; keep modest on phones (memory). */
  contextSize?: number;
  /** Human label surfaced in the UI (e.g. "Llama 3.2 3B Q4"). */
  label?: string;
  /** Default cap for chat replies. */
  maxTokens?: number;
}

const DEFAULT_CONTEXT = 4096;
const DEFAULT_MAX_TOKENS = 1024;

export class LlamaRnModel implements LocalModel {
  readonly backend = 'llama' as const;
  readonly label: string;
  private readonly config: LlamaRnModelConfig;
  private context: LlamaContext | null = null;
  private loading: Promise<LlamaContext> | null = null;

  constructor(config: LlamaRnModelConfig) {
    this.config = config;
    this.label = config.label ?? 'Local model';
  }

  /** Ready once the GGUF is loadable into a context. Load is lazy + memoized. */
  async isReady(): Promise<boolean> {
    try {
      await this.ensureContext();
      return true;
    } catch {
      return false;
    }
  }

  private ensureContext(): Promise<LlamaContext> {
    if (this.context) return Promise.resolve(this.context);
    if (!this.loading) {
      this.loading = initLlama({
        model: this.config.modelPath,
        n_ctx: this.config.contextSize ?? DEFAULT_CONTEXT,
        // Offload to Metal/GPU where present; harmless on CPU-only.
        n_gpu_layers: 99,
        use_mlock: true,
      })
        .then((ctx) => {
          this.context = ctx;
          return ctx;
        })
        .catch((err) => {
          this.loading = null; // allow a later retry
          throw err;
        });
    }
    return this.loading;
  }

  async generateText(
    messages: LocalChatMessage[],
    options: LocalGenerateOptions = {},
  ): Promise<string> {
    const ctx = await this.ensureContext();
    const result = await ctx.completion(
      {
        messages,
        n_predict: options.maxTokens ?? this.config.maxTokens ?? DEFAULT_MAX_TOKENS,
      },
      options.onToken ? (data) => options.onToken?.(data.token) : undefined,
    );
    return result.text;
  }

  async generateStructured(prompt: string, schema: LocalJsonSchema): Promise<string> {
    const ctx = await this.ensureContext();
    const result = await ctx.completion({
      prompt,
      n_predict: this.config.maxTokens ?? DEFAULT_MAX_TOKENS,
      // Constrained decoding: llama.cpp compiles this JSON Schema to a GBNF grammar,
      // so the model can only emit tokens that keep the output schema-valid.
      response_format: { type: 'json_schema', json_schema: { schema } },
    });
    return result.text;
  }

  async dispose(): Promise<void> {
    try {
      await this.context?.release();
    } finally {
      this.context = null;
      this.loading = null;
    }
  }
}
