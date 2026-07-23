import { apple } from '@react-native-ai/apple';
import { generateText, streamText } from 'ai';
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
 * file to ship) and inference is NPU-accelerated. Guided generation (constrained
 * decoding) would be the ideal path for the Tier-2 NER JSON, but the 0.12.0 bridge
 * breaks it — see generateStructured below for the prompt-then-parse workaround.
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
   * JSON generation against `schema`.
   *
   * NOT guided generation, deliberately. @react-native-ai/apple 0.12.0 has a
   * bridge bug: for schema-constrained responses the native side serializes the
   * transcript segment with Swift's `String(describing:)`, which for a
   * StructuredSegment yields a struct debug-dump, not JSON (AppleLLMImpl.swift
   * toModelMessages). generateObject() then fails to parse it and throws on
   * EVERY call — measured 0/59 on the on-device NER eval, with applyTier2
   * silently degrading each case. Until the upstream fix (return
   * `content.jsonString` in the schema branch) lands or we patch the pod, we
   * use plain generation: the NER prompt already demands JSON-only output, and
   * detectEntities validates spans + kinds strictly, so a malformed reply
   * degrades that one call — same as today's floor, never worse.
   *
   * The reply is salvaged down to the outermost {...} and mechanically repaired
   * before returning, so the caller gets the SAME string contract Ollama's
   * generateJson returns.
   *
   * The schema parameter is deliberately NOT sent to the model. Appending the
   * raw JSON Schema to the prompt made Apple FM parrot schema keys into its
   * output ({"text": "text":"John Whitfield", ...} — invalid JSON, whole case
   * lost). The NER prompt from applyTier2 already shows the exact output shape
   * by example, which small models follow far better than a schema document.
   * The duplicated-key artifact is still repaired below in case it recurs.
   */
  async generateStructured(prompt: string, _schema: LocalJsonSchema): Promise<string> {
    const { text } = await generateText({
      model: apple(),
      messages: [{ role: 'user', content: prompt }],
    });
    // Salvage: strip code fences / stray prose down to the outermost object.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    const sliced = start >= 0 && end > start ? text.slice(start, end + 1) : text;
    // Repair the observed duplicated-key artifact: "text": "text":"value"
    return sliced.replace(/"(text|kind)":\s*"(?:text|kind)":/g, '"$1":');
  }
}
