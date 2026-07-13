import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createOllamaClient,
  ollamaState,
  parseOllamaProgressLine,
  type PullProgress,
} from '../src/ollama.js';

/** Streaming pull + Ollama-state detection (M9c, ADR 0014). */

const prevUrl = process.env.NORTHKEEP_OLLAMA_URL;
afterEach(() => {
  if (prevUrl === undefined) delete process.env.NORTHKEEP_OLLAMA_URL;
  else process.env.NORTHKEEP_OLLAMA_URL = prevUrl;
});

async function listen(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('parseOllamaProgressLine', () => {
  it('parses a status line with byte counts', () => {
    expect(parseOllamaProgressLine('{"status":"downloading","completed":50,"total":100}')).toEqual({
      status: 'downloading',
      completedBytes: 50,
      totalBytes: 100,
    });
  });

  it('ignores blank, unparseable, and statusless lines', () => {
    expect(parseOllamaProgressLine('')).toBeNull();
    expect(parseOllamaProgressLine('   ')).toBeNull();
    expect(parseOllamaProgressLine('not json')).toBeNull();
    expect(parseOllamaProgressLine('{"digest":"abc"}')).toBeNull();
  });

  it('throws on an explicit error line', () => {
    expect(() => parseOllamaProgressLine('{"error":"model not found"}')).toThrow(/model not found/);
  });
});

describe('pull — NDJSON stream, partial lines across chunks', () => {
  it('reassembles a line split across two chunks and reports every tick', async () => {
    const server = await listen((req, res) => {
      expect(req.url).toBe('/api/pull');
      res.setHeader('content-type', 'application/x-ndjson');
      // A line is deliberately split across write() boundaries.
      res.write('{"status":"pulling manifest"}\n{"status":"downloading","comple');
      res.write('ted":10,"total":100}\n');
      res.end('{"status":"success"}\n'); // final line still terminated
    });
    process.env.NORTHKEEP_OLLAMA_URL = `http://127.0.0.1:${server.port}`;
    try {
      const seen: PullProgress[] = [];
      await createOllamaClient().pull('llama3.2:3b', (p) => seen.push(p));
      expect(seen.map((p) => p.status)).toEqual(['pulling manifest', 'downloading', 'success']);
      expect(seen[1]).toEqual({ status: 'downloading', completedBytes: 10, totalBytes: 100 });
    } finally {
      await server.close();
    }
  });

  it('handles a final line with no trailing newline', async () => {
    const server = await listen((_req, res) => {
      res.end('{"status":"success"}'); // no newline
    });
    process.env.NORTHKEEP_OLLAMA_URL = `http://127.0.0.1:${server.port}`;
    try {
      const seen: PullProgress[] = [];
      await createOllamaClient().pull('x', (p) => seen.push(p));
      expect(seen.map((p) => p.status)).toEqual(['success']);
    } finally {
      await server.close();
    }
  });

  it('rejects when the stream reports an error', async () => {
    const server = await listen((_req, res) => {
      res.end('{"error":"pull failed"}\n');
    });
    process.env.NORTHKEEP_OLLAMA_URL = `http://127.0.0.1:${server.port}`;
    try {
      await expect(createOllamaClient().pull('x')).rejects.toThrow(/pull failed/);
    } finally {
      await server.close();
    }
  });
});

describe('ollamaState — three-way classification', () => {
  it('ready: reachable with at least one model', async () => {
    const server = await listen((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ models: [{ name: 'llama3.2:3b' }] }));
    });
    process.env.NORTHKEEP_OLLAMA_URL = `http://127.0.0.1:${server.port}`;
    try {
      expect(await ollamaState()).toBe('ready');
    } finally {
      await server.close();
    }
  });

  it('no-models: reachable with zero models', async () => {
    const server = await listen((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ models: [] }));
    });
    process.env.NORTHKEEP_OLLAMA_URL = `http://127.0.0.1:${server.port}`;
    try {
      expect(await ollamaState()).toBe('no-models');
    } finally {
      await server.close();
    }
  });

  it('not-installed: the port refuses the connection', async () => {
    // Bind then close to guarantee a dead loopback port (ECONNREFUSED).
    const server = await listen((_req, res) => res.end());
    const port = server.port;
    await server.close();
    process.env.NORTHKEEP_OLLAMA_URL = `http://127.0.0.1:${port}`;
    expect(await ollamaState()).toBe('not-installed');
  });
});
