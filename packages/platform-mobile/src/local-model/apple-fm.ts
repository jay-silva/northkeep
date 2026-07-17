import { apple } from '@react-native-ai/apple';
import { generateObject, generateText, jsonSchema, streamText } from 'ai';
import type {
  LocalChatMessage,
  LocalGenerateOptions,
  LocalJsonSchema,
  LocalModel,
} from './types.js';

/**
 * AppleFMModel — primary on-device backend (ADR 0020).
 *
 * Bridges Apple's Foundation Models (Apple Intelligence, iOS 26+, A17 Pro / M-series
 * hardware) to our LocalModel seam via @react-native-ai/apple, which exposes an
 * AI-SDK LanguageModel. We drive it with the Vercel AI SDK `ai` package so we get
 * streaming + native guided generation for free.
 *
 * Why Apple is primary: the model is part of the OS (no gigabyte download, no model
 * file to ship), inference is NPU-accelerated, and generateObject uses Apple's NATIVE
 * guided generation (constrained decoding), which is far more reliable for the Tier-2
 * NER JSON than prompt-then-parse on a small model.
 *
 * REQUIREMENTS (verified July 2026): iOS 26+, Apple Intelligence enabled, capable
 * hardware (iPhone 15 Pro / A17 Pro or newer, or M-series iPad). `isAvailable()`
 * returns false on everything else — the loud path to LlamaRnModel or Tier-1.
 *
 * DEVICE-UNVERIFIED: not yet run on hardware. See types.ts.
 */
export class AppleFMModel implements LocalModel {
  readonly backend = 'apple' as const;
  readonly label = 'Apple Intelligence';

  /** Synchronous native capability probe; wrapped async to fit the interface. */
  async isReady(): Promise<boolean> {
    try {
      return apple.isAvailable();
    } catch {
      return false;
    }
  }

  async generateText(
    messages: LocalChatMessage[],
    options: LocalGenerateOptions = {},
  ): Promise<string> {
    const model = apple();
    if (options.onToken) {
      const result = streamText({
        model,
        messages,
        abortSignal: options.signal,
        ...(options.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
      });
      let full = '';
      for await (const delta of result.textStream) {
        full += delta;
        options.onToken(delta);
      }
      return full;
    }
    const { text } = await generateText({
      model,
      messages,
      abortSignal: options.signal,
      ...(options.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
    });
    return text;
  }

  /**
   * Guided generation against `schema` (native constrained decoding on iOS 26+).
   * We hand the AI SDK a JSON Schema via `jsonSchema()` rather than a zod object so
   * the redact side (which owns ENTITY_JSON_SCHEMA) stays schema-library-agnostic.
   * The result is re-serialized so callers get the SAME string contract Ollama's
   * generateJson returns — applyTier2 then parses it unchanged.
   */
  async generateStructured(prompt: string, schema: LocalJsonSchema): Promise<string> {
    const { object } = await generateObject({
      model: apple(),
      schema: jsonSchema(schema),
      prompt,
    });
    return JSON.stringify(object);
  }
}
