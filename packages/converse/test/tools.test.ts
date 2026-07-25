import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAnthropicProvider,
  createOpenAICompatibleProvider,
  type ChatMessage,
  type ChatTurnResult,
  type ToolSpec,
} from '../src/index.js';
import { toOpenAIWire } from '../src/openai.js';
import { toAnthropicTurns } from '../src/anthropic.js';

/**
 * M10a — provider-layer tool-call plumbing (ADR 0027). These tests pin the
 * wire mappings (internal ChatMessage fields must never leak onto the wire),
 * the streamed tool-call accumulation, and the chat()-wraps-chatTurn contract
 * that keeps one SSE parser per provider.
 */

const WEATHER_TOOL: ToolSpec = {
  name: 'get_weather',
  description: 'Get the weather for a city',
  inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};

// ---------- OpenAI wire mapping (outbound) ----------

describe('toOpenAIWire', () => {
  it('maps a tool-role message to {role:"tool", tool_call_id, content}', () => {
    const wire = toOpenAIWire([
      { role: 'tool', content: '{"temp": 12}', toolCallId: 'call_1' },
    ]);
    expect(wire).toEqual([{ role: 'tool', content: '{"temp": 12}', tool_call_id: 'call_1' }]);
  });

  it('maps assistant toolCalls to the tool_calls wire shape, arguments byte-faithful', () => {
    const wire = toOpenAIWire([
      {
        role: 'assistant',
        content: 'Checking…',
        toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"Boston"}' }],
      },
    ]);
    expect(wire).toEqual([
      {
        role: 'assistant',
        content: 'Checking…',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Boston"}' },
          },
        ],
      },
    ]);
  });

  it('never leaks internal fields onto plain wire messages', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    // Simulate an internal field riding on a message (the widened type will
    // keep growing; verbatim pass-through would ship whatever comes next).
    (messages[1] as unknown as Record<string, unknown>)['internalNote'] = 'secret';
    const wire = toOpenAIWire(messages);
    expect(wire).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    expect(JSON.stringify(wire)).not.toContain('internalNote');
    expect(JSON.stringify(wire)).not.toContain('toolCalls'); // internal spelling
  });
});

// ---------- Anthropic wire mapping (outbound) ----------

describe('toAnthropicTurns', () => {
  it('maps assistant toolCalls to text + tool_use content blocks with parsed input', () => {
    const turns = toAnthropicTurns([
      {
        role: 'assistant',
        content: 'Checking…',
        toolCalls: [{ id: 'toolu_1', name: 'get_weather', arguments: '{"city":"Boston"}' }],
      },
    ]);
    expect(turns).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking…' },
          { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Boston' } },
        ],
      },
    ]);
  });

  it('omits the text block when the assistant said nothing alongside the calls', () => {
    const turns = toAnthropicTurns([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'toolu_1', name: 'get_weather', arguments: '{}' }],
      },
    ]);
    expect(turns[0]!.content).toEqual([
      { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
    ]);
  });

  it('maps a tool-role message to a USER-role tool_result (never dropped)', () => {
    const turns = toAnthropicTurns([
      { role: 'user', content: 'weather?' },
      { role: 'tool', content: '{"temp": 12}', toolCallId: 'toolu_1' },
    ]);
    expect(turns).toEqual([
      { role: 'user', content: 'weather?' },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"temp": 12}' }],
      },
    ]);
  });

  it('guards unparseable arguments with {} instead of failing the turn', () => {
    const turns = toAnthropicTurns([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'toolu_1', name: 'get_weather', arguments: '{"city": "Bos' }],
      },
    ]);
    expect(turns[0]!.content).toEqual([
      { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
    ]);
  });

  it('hoists nothing for system messages (they ride the top-level system field)', () => {
    expect(toAnthropicTurns([{ role: 'system', content: 'be brief' }])).toEqual([]);
  });
});

// ---------- OpenAI provider: streamed tool calls over a real SSE server ----------

type SseScript = string[];

/**
 * Minimal OpenAI-compatible chat endpoint: replays a scripted list of SSE
 * data payloads (already JSON strings) and records every request body.
 */
function fakeOpenAIServer(): {
  start(): Promise<string>;
  stop(): Promise<void>;
  setScript(script: SseScript): void;
  setJsonBody(body: unknown): void;
  requests: string[];
} {
  let script: SseScript = [];
  let jsonBody: unknown = null;
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      requests.push(body);
      if (jsonBody !== null) {
        // Non-stream fallback: plain JSON despite stream:true.
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(jsonBody));
        return;
      }
      res.setHeader('content-type', 'text/event-stream');
      for (const payload of script) res.write(`data: ${payload}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return {
    requests,
    setScript: (s) => {
      script = s;
      jsonBody = null;
    },
    setJsonBody: (b) => {
      jsonBody = b;
    },
    start: () =>
      new Promise((resolve) =>
        server.listen(0, '127.0.0.1', () =>
          resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`),
        ),
      ),
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe('OpenAI-compatible provider — chatTurn tool plumbing', () => {
  const fake = fakeOpenAIServer();
  let baseUrl = '';
  beforeAll(async () => {
    baseUrl = await fake.start();
  });
  afterAll(() => fake.stop());

  const provider = () => createOpenAICompatibleProvider({ baseUrl });
  const ask = (options: Partial<Parameters<ReturnType<typeof provider>['chatTurn']>[1]> = {}) =>
    provider().chatTurn([{ role: 'user', content: 'weather?' }], {
      model: 'fake-model',
      ...options,
    });

  it('accumulates a tool call split across argument fragments and maps finish_reason', async () => {
    fake.requests.length = 0;
    fake.setScript([
      JSON.stringify({ choices: [{ delta: { content: 'Let me check. ' } }] }),
      // First fragment carries id + name; arguments arrive in pieces.
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '' } },
              ],
            },
          },
        ],
      }),
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }],
      }),
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Boston"}' } }] } }],
      }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ]);

    const tokens: string[] = [];
    const result = await ask({ tools: [WEATHER_TOOL], onToken: (t) => tokens.push(t) });
    expect(result.text).toBe('Let me check. ');
    expect(tokens).toEqual(['Let me check. ']);
    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'get_weather', arguments: '{"city":"Boston"}' },
    ]);
    expect(result.stopReason).toBe('tool_use');

    // The request advertised the tools in the OpenAI function shape.
    const sent = JSON.parse(fake.requests[0]!) as {
      tools?: Array<{ type: string; function: { name: string; parameters: unknown } }>;
    };
    expect(sent.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the weather for a city',
          parameters: WEATHER_TOOL.inputSchema,
        },
      },
    ]);
  });

  it('keeps multiple interleaved indexes as separate calls, in index order', async () => {
    fake.setScript([
      JSON.stringify({
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'tool_a' } }] } },
        ],
      }),
      JSON.stringify({
        choices: [
          { delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'tool_b' } }] } },
        ],
      }),
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"b":2}' } }] } }],
      }),
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] } }],
      }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ]);
    const result = await ask({ tools: [WEATHER_TOOL] });
    expect(result.toolCalls).toEqual([
      { id: 'call_a', name: 'tool_a', arguments: '{"a":1}' },
      { id: 'call_b', name: 'tool_b', arguments: '{"b":2}' },
    ]);
  });

  it('passes malformed accumulated arguments through as-is (harness validates, never drop)', async () => {
    fake.setScript([
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"cit' } },
              ],
            },
          },
        ],
      }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ]);
    const result = await ask({ tools: [WEATHER_TOOL] });
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'get_weather', arguments: '{"cit' }]);
  });

  it("maps finish_reason 'length' to 'max_tokens' and absence to 'end'", async () => {
    fake.setScript([
      JSON.stringify({ choices: [{ delta: { content: 'truncat' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }),
    ]);
    expect((await ask()).stopReason).toBe('max_tokens');

    fake.setScript([JSON.stringify({ choices: [{ delta: { content: 'plain' } }] })]);
    const plain = await ask();
    expect(plain.stopReason).toBe('end');
    expect(plain.toolCalls).toEqual([]);
  });

  it('reads tool_calls and finish_reason from the non-stream JSON fallback', async () => {
    fake.setJsonBody({
      choices: [
        {
          message: {
            content: 'One sec.',
            tool_calls: [
              { id: 'call_9', function: { name: 'get_weather', arguments: '{"city":"Bourne"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    });
    const usages: Array<{ inputTokens: number; outputTokens: number }> = [];
    const result = await ask({ tools: [WEATHER_TOOL], onUsage: (u) => usages.push(u) });
    expect(result.text).toBe('One sec.');
    expect(result.toolCalls).toEqual([
      { id: 'call_9', name: 'get_weather', arguments: '{"city":"Bourne"}' },
    ]);
    expect(result.stopReason).toBe('tool_use');
    expect(usages).toEqual([{ inputTokens: 7, outputTokens: 3 }]);
  });

  it('sends tool/assistant-toolCalls history through the wire mapper, not verbatim', async () => {
    fake.requests.length = 0;
    fake.setScript([JSON.stringify({ choices: [{ delta: { content: '12°C.' } }] })]);
    await provider().chatTurn(
      [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"Boston"}' }],
        },
        { role: 'tool', content: '{"temp":12}', toolCallId: 'call_1' },
      ],
      { model: 'fake-model' },
    );
    const sent = JSON.parse(fake.requests[0]!) as { messages: Array<Record<string, unknown>> };
    expect(sent.messages[1]!['tool_calls']).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Boston"}' } },
    ]);
    expect(sent.messages[2]).toEqual({ role: 'tool', content: '{"temp":12}', tool_call_id: 'call_1' });
    // Internal spellings never on the wire.
    expect(fake.requests[0]).not.toContain('toolCalls');
    expect(fake.requests[0]).not.toContain('toolCallId');
  });

  it('chat() is a thin wrapper over chatTurn (one SSE parser)', async () => {
    const p = provider();
    let sawChatTurn = 0;
    p.chatTurn = async (): Promise<ChatTurnResult> => {
      sawChatTurn += 1;
      return { text: 'stubbed', toolCalls: [], stopReason: 'end' };
    };
    await expect(p.chat([{ role: 'user', content: 'hi' }], { model: 'm' })).resolves.toBe('stubbed');
    expect(sawChatTurn).toBe(1);
  });

  it('chat() over a plain text stream behaves exactly as before M10a', async () => {
    fake.requests.length = 0;
    fake.setScript([
      JSON.stringify({ choices: [{ delta: { content: 'Hello ' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'world.' } }] }),
    ]);
    const tokens: string[] = [];
    const text = await provider().chat([{ role: 'user', content: 'hi' }], {
      model: 'fake-model',
      onToken: (t) => tokens.push(t),
    });
    expect(text).toBe('Hello world.');
    expect(tokens).toEqual(['Hello ', 'world.']);
    // No tools option → no tools key in the request at all.
    expect(JSON.parse(fake.requests[0]!)).not.toHaveProperty('tools');
  });
});

// ---------- Anthropic provider: tool_use blocks over a fake Messages API ----------

// There was no pre-existing SDK-fake pattern in this repo; the pattern here
// mirrors the OpenAI fake above — the REAL @anthropic-ai/sdk pointed at a
// local server speaking the Messages SSE protocol — so the SDK's own stream
// assembly (input_json deltas → complete tool_use blocks) is exercised, not
// stubbed around.
function fakeAnthropicServer(events: Array<{ event: string; data: unknown }>): {
  start(): Promise<string>;
  stop(): Promise<void>;
  requests: string[];
} {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      requests.push(body);
      res.setHeader('content-type', 'text/event-stream');
      for (const e of events) {
        res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
      }
      res.end();
    });
  });
  return {
    requests,
    start: () =>
      new Promise((resolve) =>
        server.listen(0, '127.0.0.1', () =>
          resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`),
        ),
      ),
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe('Anthropic provider — chatTurn tool plumbing', () => {
  const fake = fakeAnthropicServer([
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 11, output_tokens: 1 },
        },
      },
    },
    {
      event: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Checking the weather.' },
      },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"city":' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '"Boston"}' },
      },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 9 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
  let baseUrl = '';
  beforeAll(async () => {
    baseUrl = await fake.start();
  });
  afterAll(() => fake.stop());

  it('streams text, assembles the tool_use block, maps stop_reason, sends tools', async () => {
    const provider = createAnthropicProvider({ apiKey: 'test-key', baseUrl });
    const tokens: string[] = [];
    const result = await provider.chatTurn(
      [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'weather in Boston?' },
      ],
      { model: 'claude-test', tools: [WEATHER_TOOL], onToken: (t) => tokens.push(t) },
    );
    expect(result.text).toBe('Checking the weather.');
    expect(tokens.join('')).toBe('Checking the weather.');
    expect(result.toolCalls).toEqual([
      { id: 'toolu_1', name: 'get_weather', arguments: '{"city":"Boston"}' },
    ]);
    expect(result.stopReason).toBe('tool_use');

    // Outbound: tools in the Anthropic shape (input_schema), system hoisted.
    const sent = JSON.parse(fake.requests[0]!) as {
      system?: string;
      tools?: Array<{ name: string; input_schema: unknown }>;
    };
    expect(sent.system).toBe('be brief');
    expect(sent.tools).toEqual([
      {
        name: 'get_weather',
        description: 'Get the weather for a city',
        input_schema: WEATHER_TOOL.inputSchema,
      },
    ]);
  });
});
