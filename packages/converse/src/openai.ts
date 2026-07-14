import type { ChatMessage, ChatOptions, ModelProvider } from './provider.js';

/**
 * The universal provider (ADR 0008): raw fetch against the OpenAI-compatible
 * protocol that nearly every runtime speaks — Ollama, LM Studio, vLLM,
 * llama.cpp server, text-generation-webui, DeepSeek, GLM/Zhipu, OpenAI,
 * Together, Groq, OpenRouter. No dependency. Configured by base URL +
 * model + optional key; that is the entire model-swap mechanism.
 *
 * Security posture:
 *  - redirect:'error' on every request — a redirect could re-send the
 *    (redacted, but still) prompt or the API key to an attacker's Location.
 *  - Error messages carry HTTP status only, never response bodies and never
 *    the key: bodies can echo the prompt, and errors end up in logs.
 */

const CHAT_TIMEOUT_MS = 300_000;
const DISCOVER_TIMEOUT_MS = 5_000;

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey?: string;
}

/** Accepts "http://host:1234", ".../", or ".../v1" — callers paste all three. */
export function normalizeBaseUrl(raw: string): string {
  let base = raw.trim().replace(/\/+$/, '');
  if (base.endsWith('/v1')) base = base.slice(0, -3).replace(/\/+$/, '');
  new URL(base); // validate; throws on garbage
  return base;
}

export function createOpenAICompatibleProvider(config: OpenAICompatibleConfig): ModelProvider {
  const base = normalizeBaseUrl(config.baseUrl);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiKey !== undefined && config.apiKey.length > 0) {
    headers['authorization'] = `Bearer ${config.apiKey}`;
  }

  return {
    kind: 'openai-compatible',
    baseUrl: base,

    async chat(messages: ChatMessage[], options: ChatOptions): Promise<string> {
      const signals = [AbortSignal.timeout(CHAT_TIMEOUT_MS)];
      if (options.signal) signals.push(options.signal);
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: options.model,
          messages,
          stream: true,
          // Ask for token usage in the final SSE chunk (OpenAI + compatible
          // servers that support it — others simply ignore it and we estimate).
          stream_options: { include_usage: true },
          ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
        }),
        signal: AbortSignal.any(signals),
        redirect: 'error',
      });
      if (!res.ok || res.body === null) {
        throw new Error(`Model endpoint returned HTTP ${res.status}.`);
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('text/event-stream')) {
        // Server ignored stream:true and answered plain JSON — accept it.
        const body = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const text = body.choices?.[0]?.message?.content ?? '';
        if (text.length > 0) options.onToken?.(text);
        reportUsage(body.usage, options.onUsage);
        return text;
      }

      return readSse(res.body, options.onToken, options.onUsage);
    },

    async listModels(): Promise<string[]> {
      // Standard discovery first…
      try {
        const res = await fetch(`${base}/v1/models`, {
          headers,
          signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS),
          redirect: 'error',
        });
        if (res.ok) {
          const body = (await res.json()) as { data?: Array<{ id?: string }> };
          const ids = (body.data ?? [])
            .map((m) => m.id)
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
          if (ids.length > 0) return ids;
        }
      } catch {
        // fall through to the Ollama-native form
      }
      // …then Ollama's native listing for runtimes that only offer that.
      const res = await fetch(`${base}/api/tags`, {
        headers,
        signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS),
        redirect: 'error',
      });
      if (!res.ok) throw new Error(`Model discovery failed: HTTP ${res.status}.`);
      const body = (await res.json()) as { models?: Array<{ name?: string }> };
      return (body.models ?? [])
        .map((m) => m.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0);
    },
  };
}

/** Parse an OpenAI-style SSE stream, invoking onToken per delta. */
async function readSse(
  body: ReadableStream<Uint8Array>,
  onToken?: (token: string) => void,
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  // With include_usage, the LAST data chunk before [DONE] carries usage and an
  // empty choices array; remember it and report once the stream ends.
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          reportUsage(usage, onUsage);
          return full;
        }
        let chunk: {
          choices?: Array<{ delta?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        try {
          chunk = JSON.parse(payload) as typeof chunk;
        } catch {
          continue; // partial or non-JSON keepalive — skip
        }
        if (chunk.usage) usage = chunk.usage;
        const token = chunk.choices?.[0]?.delta?.content;
        if (typeof token === 'string' && token.length > 0) {
          full += token;
          onToken?.(token);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  reportUsage(usage, onUsage);
  return full;
}

/** Forward an OpenAI usage block to onUsage, only when both counts are present. */
function reportUsage(
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined,
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void,
): void {
  if (!onUsage || !usage) return;
  const { prompt_tokens, completion_tokens } = usage;
  if (typeof prompt_tokens !== 'number' || typeof completion_tokens !== 'number') return;
  onUsage({ inputTokens: prompt_tokens, outputTokens: completion_tokens });
}
