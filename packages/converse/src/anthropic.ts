import Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, ChatOptions, ModelProvider } from './provider.js';

/**
 * Native Anthropic provider (ADR 0008) — the best-quality Claude path:
 * true streaming and adaptive thinking via @anthropic-ai/sdk (the one
 * network-capable dependency added by M6, ADR 0007 / invariant #7).
 * Optional: Claude is also reachable through the OpenAI-compatible provider;
 * this exists for quality, not necessity.
 *
 * Error hygiene: messages surfaced from here carry status/type only — never
 * response bodies (which can echo prompt content) and never the API key.
 */

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-8';
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_MAX_TOKENS = 64_000;

export interface AnthropicProviderConfig {
  apiKey: string;
  /** Override for tests/fakes only; defaults to the real API (bounded tier). */
  baseUrl?: string;
}

export function createAnthropicProvider(config: AnthropicProviderConfig): ModelProvider {
  const baseUrl = config.baseUrl ?? ANTHROPIC_BASE_URL;
  const client = new Anthropic({ apiKey: config.apiKey, baseURL: baseUrl });

  return {
    kind: 'anthropic',
    baseUrl,

    async chat(messages: ChatMessage[], options: ChatOptions): Promise<string> {
      const system = messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
      const turns = messages
        .filter((m): m is ChatMessage & { role: 'user' | 'assistant' } => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content }));

      try {
        const stream = client.messages.stream(
          {
            model: options.model || DEFAULT_ANTHROPIC_MODEL,
            max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
            thinking: { type: 'adaptive' },
            ...(system.length > 0 ? { system } : {}),
            messages: turns,
          },
          options.signal ? { signal: options.signal } : {},
        );
        let full = '';
        stream.on('text', (delta) => {
          full += delta;
          options.onToken?.(delta);
        });
        const finalMessage = await stream.finalMessage();
        // Real usage from the API: input_tokens / output_tokens (a count only).
        const usage = finalMessage.usage;
        if (
          options.onUsage &&
          usage &&
          typeof usage.input_tokens === 'number' &&
          typeof usage.output_tokens === 'number'
        ) {
          options.onUsage({ inputTokens: usage.input_tokens, outputTokens: usage.output_tokens });
        }
        return full;
      } catch (err) {
        throw sanitizeError(err);
      }
    },

    async listModels(): Promise<string[]> {
      try {
        const ids: string[] = [];
        for await (const model of client.models.list()) {
          ids.push(model.id);
        }
        return ids;
      } catch (err) {
        throw sanitizeError(err);
      }
    },
  };
}

/** Status/type only — no response bodies, no key material. */
function sanitizeError(err: unknown): Error {
  if (err instanceof Anthropic.APIError) {
    return new Error(`Anthropic API error (HTTP ${err.status ?? 'unknown'}).`);
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return new Error('Anthropic request was cancelled.');
  }
  return new Error('Could not reach the Anthropic API.');
}
