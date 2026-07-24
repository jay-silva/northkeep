import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOpenAICompatibleProvider } from '../packages/converse/dist/index.js';

/**
 * M10a acceptance — provider-layer tool-call plumbing (ADR 0027) — against a
 * FAKE OpenAI-compatible endpoint, driving the BUILT @northkeep/converse
 * provider (dist, same code every app surface loads). Proves over the wire:
 *  - a tool_call streamed in fragments (id/name first, arguments split
 *    across chunks) is assembled into one ToolCallRequest and surfaced with
 *    stopReason 'tool_use';
 *  - a follow-up chatTurn carrying the assistant's toolCalls + the tool-role
 *    result round-trips: the internal messages are mapped to the OpenAI wire
 *    shapes (tool_calls / tool_call_id — never internal field names) and the
 *    model's final text answer comes back;
 *  - BACKWARD COMPAT: a plain text chat() turn behaves exactly as before
 *    M10a — tokens stream in order, final text intact, no tools key sent.
 *
 * M10a ships NO user-visible behavior change; the agent loop that uses this
 * plumbing is M10b+.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distPath = path.join(repoRoot, 'packages', 'converse', 'dist', 'index.js');

let fakeProvider: http.Server;
let fakeProviderUrl: string;
/** Parsed JSON of every body POSTed to the fake chat endpoint. */
const outbound: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  expect(fs.existsSync(distPath), 'run pnpm build first').toBe(true);

  // Fake OpenAI-compatible endpoint. First tools-bearing request: stream a
  // tool_call split across chunks. Request carrying a tool-role result: stream
  // the final answer. Anything else: a plain two-token text stream.
  fakeProvider = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const parsed = JSON.parse(body) as {
        messages: Array<{ role: string }>;
        tools?: unknown[];
      };
      outbound.push(parsed as unknown as Record<string, unknown>);
      res.setHeader('content-type', 'text/event-stream');
      const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

      if (parsed.messages.some((m) => m.role === 'tool')) {
        // Round 2: the tool result came back — answer in text.
        send({ choices: [{ delta: { content: 'It is ' } }] });
        send({ choices: [{ delta: { content: '12°C in Boston.' } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      } else if ((parsed.tools ?? []).length > 0) {
        // Round 1: ask for the tool — id/name first, arguments split across
        // chunks, exactly how OpenAI-compatible servers stream them.
        send({ choices: [{ delta: { content: 'Let me check.' } }] });
        send({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_w1', function: { name: 'get_weather', arguments: '' } },
                ],
              },
            },
          ],
        });
        send({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] } }],
        });
        send({
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { arguments: ':"Boston"}' } }] } },
          ],
        });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        // Plain chat, exactly as the pre-M10a fake endpoints replied.
        send({ choices: [{ delta: { content: 'Hello ' } }] });
        send({ choices: [{ delta: { content: 'world.' } }] });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => fakeProvider.listen(0, '127.0.0.1', r));
  fakeProviderUrl = `http://127.0.0.1:${(fakeProvider.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise((r) => fakeProvider.close(r));
});

describe('M10a acceptance — provider tool-call plumbing', () => {
  const weatherTool = {
    name: 'get_weather',
    description: 'Get the weather for a city',
    inputSchema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    } as Record<string, unknown>,
  };

  it('assembles a fragment-streamed tool_call and round-trips the tool result to a final answer', async () => {
    outbound.length = 0;
    const provider = createOpenAICompatibleProvider({ baseUrl: fakeProviderUrl });

    // Round 1: the model wants the tool.
    const tokens: string[] = [];
    const first = await provider.chatTurn(
      [{ role: 'user', content: 'What is the weather in Boston?' }],
      { model: 'fake-model', tools: [weatherTool], onToken: (t) => tokens.push(t) },
    );
    expect(first.text).toBe('Let me check.');
    expect(tokens).toEqual(['Let me check.']);
    expect(first.stopReason).toBe('tool_use');
    expect(first.toolCalls).toEqual([
      { id: 'call_w1', name: 'get_weather', arguments: '{"city":"Boston"}' },
    ]);
    // The endpoint was offered the tool in the OpenAI function shape.
    expect(outbound[0]!['tools']).toEqual([
      { type: 'function', function: { name: 'get_weather', description: 'Get the weather for a city', parameters: weatherTool.inputSchema } },
    ]);

    // Round 2: hand back the tool result on a tool-role message.
    const second = await provider.chatTurn(
      [
        { role: 'user', content: 'What is the weather in Boston?' },
        { role: 'assistant', content: first.text, toolCalls: first.toolCalls },
        { role: 'tool', content: '{"temp_c": 12}', toolCallId: first.toolCalls[0]!.id },
      ],
      { model: 'fake-model', tools: [weatherTool] },
    );
    expect(second.text).toBe('It is 12°C in Boston.');
    expect(second.stopReason).toBe('end');
    expect(second.toolCalls).toEqual([]);

    // The internal message shapes were mapped, not passed verbatim: the wire
    // carries tool_calls / tool_call_id, never the internal field spellings.
    const round2 = outbound[1]! as {
      messages: Array<Record<string, unknown>>;
    };
    expect(round2.messages[1]!['tool_calls']).toEqual([
      { id: 'call_w1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Boston"}' } },
    ]);
    expect(round2.messages[2]).toEqual({ role: 'tool', content: '{"temp_c": 12}', tool_call_id: 'call_w1' });
    const wireText = JSON.stringify(outbound);
    expect(wireText).not.toContain('toolCalls');
    expect(wireText).not.toContain('toolCallId');
  });

  it('BACKWARD COMPAT: a plain chat() turn streams tokens and returns intact text, no tools key', async () => {
    outbound.length = 0;
    const provider = createOpenAICompatibleProvider({ baseUrl: fakeProviderUrl });
    const tokens: string[] = [];
    const text = await provider.chat([{ role: 'user', content: 'hi' }], {
      model: 'fake-model',
      onToken: (t) => tokens.push(t),
    });
    expect(text).toBe('Hello world.');
    expect(tokens).toEqual(['Hello ', 'world.']);
    expect(outbound[0]).not.toHaveProperty('tools');
    // The request body is byte-shape-identical to pre-M10a plain chats:
    // role/content messages only, stream on, usage requested.
    expect(outbound[0]!['messages']).toEqual([{ role: 'user', content: 'hi' }]);
    expect(outbound[0]!['stream']).toBe(true);
  });
});
