import { fetch as expoFetch } from 'expo/fetch';
import type { ChatMessage, ChatOptions, ModelProvider } from '@northkeep/converse/dist/provider.js';
import type { ProviderConfig } from './providers-store';

/**
 * React Native model providers for M6-3 Converse, built on `expo/fetch`
 * (SDK 54+). RN's global `fetch` does NOT expose a streaming response body;
 * expo/fetch does (`response.body` is a real ReadableStream), so tokens arrive
 * incrementally. If a server ignores streaming and returns one JSON body, we
 * fall through and read it whole.
 *
 * These implement the SAME `ModelProvider` interface as
 * packages/converse/src/{openai,anthropic}.ts and are handed to the REAL
 * runTurn pipeline (see converse-run.ts). We do not reuse those files verbatim
 * because their `chat()` uses Node/global fetch (openai.ts) and the Node
 * @anthropic-ai/sdk (anthropic.ts), neither of which streams on Hermes; the
 * wire protocol and SSE shape here mirror them exactly.
 *
 * Security/error hygiene (mirrors the desktop providers):
 *  - The API key is sent only as a request header; it is NEVER placed in a
 *    thrown message, and the outbound-capture callback receives the message
 *    body ONLY (no headers), so the "what left this device" view can never
 *    surface the key.
 *  - Errors carry HTTP status only — never response bodies (which can echo the
 *    prompt) and never key material.
 *  - `redirect: 'error'` blocks a redirect from re-sending the key/prompt to an
 *    attacker's Location.
 */

const CHAT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_TOKENS = 4096;
const ANTHROPIC_VERSION = '2023-06-01';

/** The exact bytes handed to the endpoint's request body — post-redaction, no key. */
export interface OutboundCapture {
  kind: ProviderConfig['kind'];
  endpoint: string;
  model: string;
  /** The redacted wire prompt (system + history + new message). */
  messages: ChatMessage[];
}

export function createMobileProvider(
  cfg: ProviderConfig,
  apiKey: string,
  onOutbound?: (capture: OutboundCapture) => void,
): ModelProvider {
  return cfg.kind === 'anthropic'
    ? createAnthropicProvider(cfg, apiKey, onOutbound)
    : createOpenAIProvider(cfg, apiKey, onOutbound);
}

// --- Anthropic (native Messages API over expo/fetch) ---

function createAnthropicProvider(
  cfg: ProviderConfig,
  apiKey: string,
  onOutbound?: (capture: OutboundCapture) => void,
): ModelProvider {
  const base = stripTrailingSlash(cfg.baseUrl);
  return {
    kind: 'anthropic',
    baseUrl: base,
    async chat(messages: ChatMessage[], options: ChatOptions): Promise<string> {
      onOutbound?.({ kind: 'anthropic', endpoint: `${base}/v1/messages`, model: options.model, messages: clone(messages) });
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      const turns = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content }));
      const res = await expoFetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: options.model,
          max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
          stream: true,
          ...(system.length > 0 ? { system } : {}),
          messages: turns,
        }),
        signal: withTimeout(options.signal),
        redirect: 'error',
      });
      if (!res.ok) throw new Error(`Anthropic API returned HTTP ${res.status}.`);
      if (!res.body) return readAnthropicJson(await res.json(), options);
      return readSse(res.body, (payload) => parseAnthropicEvent(payload, options));
    },
    async listModels(): Promise<string[]> {
      const res = await expoFetch(`${base}/v1/models`, {
        method: 'GET',
        headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
        redirect: 'error',
      });
      if (!res.ok) throw new Error(`Anthropic model list returned HTTP ${res.status}.`);
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
    },
  };
}

function parseAnthropicEvent(payload: string, options: ChatOptions): string {
  let chunk: {
    type?: string;
    delta?: { type?: string; text?: string };
    usage?: { input_tokens?: number; output_tokens?: number };
    message?: { usage?: { input_tokens?: number } };
  };
  try {
    chunk = JSON.parse(payload);
  } catch {
    return '';
  }
  if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta' && chunk.delta.text) {
    options.onToken?.(chunk.delta.text);
    return chunk.delta.text;
  }
  // Anthropic reports output tokens on message_delta; input tokens on message_start.
  // These arrive in separate events, so runTurn's last-write-wins usage handler
  // keeps only the later one (output). Harmless today: converse-run passes
  // catalog:[] and the UI surfaces no cost, so onUsage is a dead path. Revisit
  // (accumulate both counts) if per-turn cost metering is ever enabled on mobile.
  const input = chunk.message?.usage?.input_tokens;
  const output = chunk.usage?.output_tokens;
  if (typeof input === 'number' || typeof output === 'number') {
    options.onUsage?.({ inputTokens: input ?? 0, outputTokens: output ?? 0 });
  }
  return '';
}

function readAnthropicJson(body: unknown, options: ChatOptions): string {
  const b = body as {
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = (b.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  if (text.length > 0) options.onToken?.(text);
  if (b.usage && typeof b.usage.input_tokens === 'number' && typeof b.usage.output_tokens === 'number') {
    options.onUsage?.({ inputTokens: b.usage.input_tokens, outputTokens: b.usage.output_tokens });
  }
  return text;
}

// --- OpenAI-compatible (chat/completions over expo/fetch) ---

function createOpenAIProvider(
  cfg: ProviderConfig,
  apiKey: string,
  onOutbound?: (capture: OutboundCapture) => void,
): ModelProvider {
  const base = normalizeOpenAiBase(cfg.baseUrl);
  return {
    kind: 'openai-compatible',
    baseUrl: base,
    async chat(messages: ChatMessage[], options: ChatOptions): Promise<string> {
      const endpoint = `${base}/v1/chat/completions`;
      onOutbound?.({ kind: 'openai', endpoint, model: options.model, messages: clone(messages) });
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (apiKey.length > 0) headers['authorization'] = `Bearer ${apiKey}`;
      const res = await expoFetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: options.model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
        }),
        signal: withTimeout(options.signal),
        redirect: 'error',
      });
      if (!res.ok) throw new Error(`Model endpoint returned HTTP ${res.status}.`);
      if (!res.body) return readOpenAiJson(await res.json(), options);
      return readSse(res.body, (payload) => parseOpenAiEvent(payload, options));
    },
    async listModels(): Promise<string[]> {
      const headers: Record<string, string> = {};
      if (apiKey.length > 0) headers['authorization'] = `Bearer ${apiKey}`;
      // Mirror the desktop OpenAICompatibleProvider (packages/converse/openai.ts):
      // standard /v1/models discovery first, then Ollama's native /api/tags for
      // local runtimes that only offer that. redirect:'error' as elsewhere.
      try {
        const res = await expoFetch(`${base}/v1/models`, {
          method: 'GET',
          headers,
          signal: withTimeout(undefined),
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
      const res = await expoFetch(`${base}/api/tags`, {
        method: 'GET',
        headers,
        signal: withTimeout(undefined),
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

function parseOpenAiEvent(payload: string, options: ChatOptions): string {
  if (payload === '[DONE]') return '';
  let chunk: {
    choices?: Array<{ delta?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  try {
    chunk = JSON.parse(payload);
  } catch {
    return '';
  }
  if (chunk.usage && typeof chunk.usage.prompt_tokens === 'number' && typeof chunk.usage.completion_tokens === 'number') {
    options.onUsage?.({ inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens });
  }
  const token = chunk.choices?.[0]?.delta?.content;
  if (typeof token === 'string' && token.length > 0) {
    options.onToken?.(token);
    return token;
  }
  return '';
}

function readOpenAiJson(body: unknown, options: ChatOptions): string {
  const b = body as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = b.choices?.[0]?.message?.content ?? '';
  if (text.length > 0) options.onToken?.(text);
  if (b.usage && typeof b.usage.prompt_tokens === 'number' && typeof b.usage.completion_tokens === 'number') {
    options.onUsage?.({ inputTokens: b.usage.prompt_tokens, outputTokens: b.usage.completion_tokens });
  }
  return text;
}

// --- shared SSE reader ---

/**
 * Read an SSE stream from an expo/fetch ReadableStream body, invoking
 * `onData(payload)` for each `data:` line's payload and accumulating whatever
 * text it returns. Provider-agnostic framing; the per-provider parser decides
 * what a payload means.
 */
async function readSse(
  body: ReadableStream<Uint8Array>,
  onData: (payload: string) => string,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue; // ignore SSE `event:`/comment lines
        full += onData(line.slice(5).trim());
      }
    }
  } finally {
    reader.releaseLock();
  }
  return full;
}

// --- helpers ---

function clone(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

function stripTrailingSlash(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/** Accepts "http://host:1234", ".../", or ".../v1" (mirrors openai.ts). */
function normalizeOpenAiBase(raw: string): string {
  let base = stripTrailingSlash(raw);
  if (base.endsWith('/v1')) base = base.slice(0, -3).replace(/\/+$/, '');
  return base;
}

/**
 * Combine the caller's abort signal with a hard timeout. AbortSignal.timeout /
 * .any are not guaranteed on Hermes, so feature-detect and degrade to the
 * caller's signal (or none) rather than throwing.
 */
function withTimeout(signal?: AbortSignal): AbortSignal | undefined {
  const hasTimeout = typeof (AbortSignal as { timeout?: unknown }).timeout === 'function';
  const hasAny = typeof (AbortSignal as { any?: unknown }).any === 'function';
  if (!hasTimeout) return signal;
  const timeout = AbortSignal.timeout(CHAT_TIMEOUT_MS);
  if (!signal) return timeout;
  return hasAny ? AbortSignal.any([signal, timeout]) : signal;
}
