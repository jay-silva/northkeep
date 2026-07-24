import type { ChatMessage, ChatOptions, ModelProvider } from '@northkeep/converse/dist/provider.js';
import type { LocalModel } from '@northkeep/platform-mobile/dist/local-model/index.js';

/**
 * On-device model as a Converse provider (M6-4): airplane-mode private chat.
 *
 * The reply is generated ENTIRELY on the phone by the LocalModel — no API key,
 * no network, nothing leaves the device. It plugs into the SAME runTurn pipeline
 * as the cloud providers by implementing ModelProvider.
 *
 * PRIVACY CLASSIFICATION: `baseUrl` is a localhost sentinel so runTurn's
 * classifyEndpoint() (which derives privacy from WHERE the endpoint lives, never
 * from a claim) returns 'private'. That lets the caller run this turn at redact
 * tier 0 — correct, because on-device inference has no egress to redact against.
 * The URL is never fetched; chat() ignores it and calls the model directly.
 */

/** Sentinel endpoint: classifyEndpoint() resolves localhost -> 'private'. */
export const ON_DEVICE_BASE_URL = 'http://localhost/on-device';

export function createLocalModelProvider(model: LocalModel): ModelProvider {
  return {
    // The interface's `kind` is a display/label discriminant only (runTurn keys
    // privacy off baseUrl, not this). 'openai-compatible' is the closest label
    // for a local chat endpoint; there is no on-device egress either way.
    kind: 'openai-compatible',
    baseUrl: ON_DEVICE_BASE_URL,
    async chat(messages: ChatMessage[], options: ChatOptions): Promise<string> {
      return model.generateText(
        messages.map((m) => ({ role: m.role, content: m.content })),
        {
          onToken: options.onToken,
          signal: options.signal,
          ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        },
      );
    },
    async listModels(): Promise<string[]> {
      return [model.label];
    },
  };
}
