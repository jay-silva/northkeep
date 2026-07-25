import type {
  ChatMessage,
  ChatOptions,
  ChatTurnResult,
  ModelProvider,
  StopReason,
  ToolCallRequest,
} from './provider.js';

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
 *  - Internal ChatMessage fields never hit the wire verbatim: toOpenAIWire
 *    maps them to the protocol's shapes (ADR 0027) so a future internal field
 *    cannot leak by default.
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

/** An outbound message in the OpenAI chat/completions wire shape. */
interface OpenAIWireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

/**
 * Map internal ChatMessages onto the OpenAI wire (ADR 0027). Explicit
 * field-by-field so the widened internal type can NEVER leak extra fields
 * onto the wire — passing `messages` verbatim (the pre-M10a behavior) would
 * ship whatever the internal type grows next.
 */
export function toOpenAIWire(messages: ChatMessage[]): OpenAIWireMessage[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      // A tool result answers a specific call; the protocol requires the id.
      return { role: 'tool' as const, content: m.content, tool_call_id: m.toolCallId ?? '' };
    }
    if (m.role === 'assistant' && m.toolCalls !== undefined && m.toolCalls.length > 0) {
      return {
        role: 'assistant' as const,
        content: m.content,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          // `arguments` is the raw JSON text as the model produced it — the
          // provider transports it byte-faithfully (ADR 0027).
          function: { name: c.name, arguments: c.arguments },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

export function createOpenAICompatibleProvider(config: OpenAICompatibleConfig): ModelProvider {
  const base = normalizeBaseUrl(config.baseUrl);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiKey !== undefined && config.apiKey.length > 0) {
    headers['authorization'] = `Bearer ${config.apiKey}`;
  }

  const provider: ModelProvider = {
    kind: 'openai-compatible',
    baseUrl: base,

    // Thin wrapper: exactly ONE SSE parser per provider (ADR 0027). Text-only
    // callers keep the old contract; tool calls surface only via chatTurn.
    chat(messages: ChatMessage[], options: ChatOptions): Promise<string> {
      return provider.chatTurn(messages, options).then((r) => r.text);
    },

    async chatTurn(messages: ChatMessage[], options: ChatOptions): Promise<ChatTurnResult> {
      const signals = [AbortSignal.timeout(CHAT_TIMEOUT_MS)];
      if (options.signal) signals.push(options.signal);
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: options.model,
          messages: toOpenAIWire(messages),
          stream: true,
          // Ask for token usage in the final SSE chunk (OpenAI + compatible
          // servers that support it — others simply ignore it and we estimate).
          stream_options: { include_usage: true },
          ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
          ...(options.tools !== undefined && options.tools.length > 0
            ? {
                tools: options.tools.map((t) => ({
                  type: 'function',
                  function: { name: t.name, description: t.description, parameters: t.inputSchema },
                })),
              }
            : {}),
        }),
        signal: AbortSignal.any(signals),
        redirect: 'error',
      });
      if (!res.ok || res.body === null) {
        // Status-only, as everywhere in this file. For a tools-bearing request
        // an HTTP 400 typically means the endpoint does not speak tools; the
        // future agent loop maps that to TOOLS_UNSUPPORTED (loud, invariant #6)
        // rather than degrading to prompt parsing.
        throw new Error(`Model endpoint returned HTTP ${res.status}.`);
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('text/event-stream')) {
        // Server ignored stream:true and answered plain JSON — accept it.
        const body = (await res.json()) as {
          choices?: Array<{
            message?: {
              content?: string;
              tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
            };
            finish_reason?: string;
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const choice = body.choices?.[0];
        const text = choice?.message?.content ?? '';
        if (text.length > 0) options.onToken?.(text);
        reportUsage(body.usage, options.onUsage);
        const toolCalls: ToolCallRequest[] = (choice?.message?.tool_calls ?? []).map((c) => ({
          id: c.id ?? '',
          name: c.function?.name ?? '',
          arguments: c.function?.arguments ?? '',
        }));
        return { text, toolCalls, stopReason: mapFinishReason(choice?.finish_reason) };
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
  return provider;
}

/** OpenAI finish_reason → the normalized StopReason (ADR 0027). */
function mapFinishReason(reason: string | undefined | null): StopReason {
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  return 'end';
}

/**
 * Parse an OpenAI-style SSE stream, invoking onToken per text delta and
 * accumulating streamed tool calls (M10a, ADR 0027). Tool-call fragments
 * arrive keyed by `index`: the first fragment carries `id` and
 * `function.name`, later ones carry `function.arguments` string pieces to
 * concatenate. We finalize at [DONE] or stream end. Accumulated arguments are
 * passed through AS-IS even if the JSON is malformed/incomplete — the harness
 * validates and refuses loudly; a provider silently dropping a tool call
 * would make the model look like it answered without tools.
 */
async function readSse(
  body: ReadableStream<Uint8Array>,
  onToken?: (token: string) => void,
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void,
): Promise<ChatTurnResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  // With include_usage, the LAST data chunk before [DONE] carries usage and an
  // empty choices array; remember it and report once the stream ends.
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
  // Streamed tool calls, keyed by their delta `index` (arrival order is the
  // call order, but sparse/out-of-order indexes are tolerated).
  const pending = new Map<number, { id: string; name: string; arguments: string }>();
  let finishReason: string | undefined;
  const finalize = (): ChatTurnResult => {
    reportUsage(usage, onUsage);
    const toolCalls = [...pending.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, c]) => ({ id: c.id, name: c.name, arguments: c.arguments }));
    return { text: full, toolCalls, stopReason: mapFinishReason(finishReason) };
  };
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
          return finalize();
        }
        let chunk: {
          choices?: Array<{
            delta?: {
              content?: string;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string | null;
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        try {
          chunk = JSON.parse(payload) as typeof chunk;
        } catch {
          continue; // partial or non-JSON keepalive — skip
        }
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
        const token = choice?.delta?.content;
        if (typeof token === 'string' && token.length > 0) {
          full += token;
          onToken?.(token);
        }
        for (const frag of choice?.delta?.tool_calls ?? []) {
          const index = frag.index ?? 0;
          let call = pending.get(index);
          if (call === undefined) {
            call = { id: '', name: '', arguments: '' };
            pending.set(index, call);
          }
          // id / name arrive once on the first fragment; arguments accumulate.
          if (typeof frag.id === 'string' && frag.id.length > 0) call.id = frag.id;
          if (typeof frag.function?.name === 'string' && frag.function.name.length > 0) {
            call.name = frag.function.name;
          }
          if (typeof frag.function?.arguments === 'string') {
            call.arguments += frag.function.arguments;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return finalize();
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
