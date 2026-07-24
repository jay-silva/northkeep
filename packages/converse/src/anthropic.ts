import Anthropic from '@anthropic-ai/sdk';
import type {
  ChatMessage,
  ChatOptions,
  ChatTurnResult,
  ModelProvider,
  StopReason,
  ToolCallRequest,
} from './provider.js';

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

/** One outbound message in the Anthropic Messages API shape. */
type AnthropicTurn = {
  role: 'user' | 'assistant';
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: unknown }
        | { type: 'tool_result'; tool_use_id: string; content: string }
      >;
};

/**
 * Map internal ChatMessages onto Anthropic turns (ADR 0027). Every role is
 * handled EXPLICITLY — the pre-M10a `role !== 'system'` filter would let a
 * 'tool' message through with a lying type predicate (or, filtered stricter,
 * silently DROP it, making the model forget the tool ever ran). Neither
 * failure mode is acceptable for the permission-gated tool loop.
 *
 * Exported for tests (the outbound-mapping unit tests exercise it directly);
 * not part of the package's public surface (not re-exported by index.ts).
 */
export function toAnthropicTurns(messages: ChatMessage[]): AnthropicTurn[] {
  const turns: AnthropicTurn[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue; // hoisted into the top-level `system` field by the caller
    if (m.role === 'tool') {
      // Anthropic wire convention: tool results ride in a USER-role message
      // as tool_result content blocks referencing the tool_use id.
      turns.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content }],
      });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls !== undefined && m.toolCalls.length > 0) {
      turns.push({
        role: 'assistant',
        content: [
          // An empty text block is invalid on this API — include it only when
          // the assistant actually said something alongside the tool calls.
          ...(m.content.length > 0 ? [{ type: 'text' as const, text: m.content }] : []),
          ...m.toolCalls.map((c) => ({
            type: 'tool_use' as const,
            id: c.id,
            name: c.name,
            input: parseArguments(c.arguments),
          })),
        ],
      });
      continue;
    }
    turns.push({ role: m.role, content: m.content });
  }
  return turns;
}

/**
 * ToolCallRequest.arguments is raw JSON TEXT (the OpenAI wire shape); this
 * API wants a parsed object. Guarded: on unparseable arguments we send `{}`
 * and keep going rather than fail the whole turn — the faithful raw text
 * still lives on the internal message, and the harness (not the provider) is
 * the layer that validates arguments and refuses loudly (ADR 0027). FLAG:
 * a `{}` here means history replay of a malformed call, not silent repair.
 */
function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

/** Anthropic stop_reason → the normalized StopReason (ADR 0027). */
function mapStopReason(reason: string | null | undefined): StopReason {
  if (reason === 'tool_use') return 'tool_use';
  if (reason === 'max_tokens') return 'max_tokens';
  return 'end';
}

export function createAnthropicProvider(config: AnthropicProviderConfig): ModelProvider {
  const baseUrl = config.baseUrl ?? ANTHROPIC_BASE_URL;
  const client = new Anthropic({ apiKey: config.apiKey, baseURL: baseUrl });

  const provider: ModelProvider = {
    kind: 'anthropic',
    baseUrl,

    // Thin wrapper: one stream path per provider (ADR 0027). Text-only
    // callers keep the old contract; tool calls surface only via chatTurn.
    chat(messages: ChatMessage[], options: ChatOptions): Promise<string> {
      return provider.chatTurn(messages, options).then((r) => r.text);
    },

    async chatTurn(messages: ChatMessage[], options: ChatOptions): Promise<ChatTurnResult> {
      const system = messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
      const turns = toAnthropicTurns(messages);

      try {
        const stream = client.messages.stream(
          {
            model: options.model || DEFAULT_ANTHROPIC_MODEL,
            max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
            thinking: { type: 'adaptive' },
            ...(system.length > 0 ? { system } : {}),
            messages: turns as Parameters<typeof client.messages.stream>[0]['messages'],
            ...(options.tools !== undefined && options.tools.length > 0
              ? {
                  tools: options.tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
                  })),
                }
              : {}),
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
        // Tool calls arrive as complete tool_use content blocks on the final
        // message (the SDK assembles streamed input_json deltas for us). The
        // internal shape carries `arguments` as JSON TEXT, so serialize —
        // symmetrical with parseArguments on the way out.
        const toolCalls: ToolCallRequest[] = finalMessage.content
          .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
          .map((block) => ({
            id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          }));
        return { text: full, toolCalls, stopReason: mapStopReason(finalMessage.stop_reason) };
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
  return provider;
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
