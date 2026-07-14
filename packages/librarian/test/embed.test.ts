import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createOllamaClient, createOllamaEmbedder } from '../src/ollama.js';

/** embed() over a loopback stub — no live Ollama, respects the loopback guard. */

const prevUrl = process.env.NORTHKEEP_OLLAMA_URL;
const servers: http.Server[] = [];

afterEach(async () => {
  if (prevUrl === undefined) delete process.env.NORTHKEEP_OLLAMA_URL;
  else process.env.NORTHKEEP_OLLAMA_URL = prevUrl;
  // Always close every server started this test, even if an assertion threw
  // mid-test — a leaked listener can keep Vitest from exiting cleanly.
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

/** Starts a loopback server, registers it for afterEach cleanup, returns its port. */
async function serve(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

describe('OllamaClient.embed', () => {
  it('reads the /api/embed batch shape ({embeddings:[[...]]})', async () => {
    // Capture the request URL and assert it OUTSIDE the handler — an assertion
    // that throws inside the handler is swallowed by http.Server and surfaces
    // as a confusing socket error instead of a clear failure.
    let seenUrl: string | undefined;
    const port = await serve((req, res) => {
      seenUrl = req.url;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }));
    });
    process.env.NORTHKEEP_OLLAMA_URL = `http://127.0.0.1:${port}`;
    const vec = await createOllamaClient().embed('hello');
    expect(seenUrl).toBe('/api/embed');
    expect(vec).toEqual([0.1, 0.2, 0.3]);
  });

  it('also reads the legacy shape ({embedding:[...]})', async () => {
    const port = await serve((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ embedding: [1, 2, 3, 4] }));
    });
    process.env.NORTHKEEP_OLLAMA_URL = `http://127.0.0.1:${port}`;
    const vec = await createOllamaEmbedder().embed('hi');
    expect(vec).toEqual([1, 2, 3, 4]);
  });

  it('throws on an HTTP error so callers can fall back', async () => {
    const port = await serve((_req, res) => {
      res.statusCode = 500;
      res.end('nope');
    });
    process.env.NORTHKEEP_OLLAMA_URL = `http://127.0.0.1:${port}`;
    await expect(createOllamaClient().embed('x')).rejects.toThrow(/HTTP 500/);
  });

  it('throws when the vector is missing', async () => {
    const port = await serve((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ embeddings: [] }));
    });
    process.env.NORTHKEEP_OLLAMA_URL = `http://127.0.0.1:${port}`;
    await expect(createOllamaClient().embed('x')).rejects.toThrow(/no embedding/i);
  });
});
