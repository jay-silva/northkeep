import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAnthropicProvider } from '../src/index.js';

const bodies: Array<Record<string, unknown>> = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
  req.on('end', () => {
    bodies.push(JSON.parse(body));
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'captured' } }));
  });
});
let baseUrl = '';
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

async function requestBodyFor(model: string): Promise<Record<string, unknown>> {
  bodies.length = 0;
  await createAnthropicProvider({ apiKey: 'test-key', baseUrl })
    .chat([{ role: 'user', content: 'hi' }], { model })
    .catch(() => {});
  expect(bodies).toHaveLength(1);
  return bodies[0]!;
}

describe('Anthropic thinking config per model', () => {
  it('sends no thinking field to claude-haiku-4-5', async () => {
    const body = await requestBodyFor('claude-haiku-4-5');
    expect(body.model).toBe('claude-haiku-4-5');
    expect('thinking' in body).toBe(false);
  });

  it('sends adaptive thinking to claude-opus-5-5', async () => {
    expect((await requestBodyFor('claude-opus-5-5')).thinking).toEqual({ type: 'adaptive' });
  });

  it('sends adaptive thinking to claude-opus-4-8', async () => {
    expect((await requestBodyFor('claude-opus-4-8')).thinking).toEqual({ type: 'adaptive' });
  });
});
