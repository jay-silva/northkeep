import { describe, expect, it } from 'vitest';
import { guardedFetch } from '../src/tools/net.js';

/**
 * The POST/SSE-capable door through the web_fetch guard (ADR 0035 Decision 5).
 *
 * The whole reason this exists is that the MCP SDK's transport calls bare
 * `fetch`, which would make remote MCP a SECOND, unguarded egress path in an
 * architecture (ADR 0028) built on there being exactly one. So the tests that
 * matter are the refusals.
 */

const refusal = async (url: string): Promise<string> => {
  try {
    await guardedFetch(url, { method: 'POST', body: '{}' });
    return 'NOT REFUSED';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};

describe('guardedFetch refuses what web_fetch refuses', () => {
  it('refuses plain http', async () => {
    expect(await refusal('http://example.com/mcp')).toMatch(/https/i);
  });

  it('refuses private address literals', async () => {
    // The exact hosts an SSRF against a home or office network would target.
    for (const url of [
      'https://192.168.1.1/mcp',
      'https://10.0.0.5/mcp',
      'https://169.254.169.254/latest/meta-data/',
      'https://127.0.0.1/mcp',
    ]) {
      expect(await refusal(url), url).toMatch(/private/i);
    }
  });

  it('refuses name-based local hosts', async () => {
    for (const url of ['https://localhost/mcp', 'https://box.local/mcp']) {
      expect(await refusal(url), url).toMatch(/local/i);
    }
  });

  it('refuses embedded credentials', async () => {
    expect(await refusal('https://user:pw@example.com/mcp')).toMatch(/credential/i);
  });

  it('refuses an unparseable URL', async () => {
    expect(await refusal('not a url')).toMatch(/parseable/i);
  });

  it('refuses a public NAME that resolves to a private address', async () => {
    // The case a string check on "localhost" misses entirely: anyone who owns a
    // domain can point an A record at 127.0.0.1 and get a valid certificate.
    const err = await (async () => {
      try {
        await guardedFetch(
          'https://rebind.test/mcp',
          { method: 'POST' },
          { resolver: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]) },
        );
        return 'NOT REFUSED';
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    })();
    expect(err).toMatch(/private/i);
  });

  it('refuses when ANY resolved address is private, not just the first', async () => {
    // A mixed answer is what split-horizon DNS and rebinding look like.
    const err = await (async () => {
      try {
        await guardedFetch(
          'https://mixed.test/mcp',
          { method: 'POST' },
          {
            resolver: () =>
              Promise.resolve([
                { address: '93.184.216.34', family: 4 },
                { address: '10.1.2.3', family: 4 },
              ]),
          },
        );
        return 'NOT REFUSED';
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    })();
    expect(err).toMatch(/private/i);
  });
});

describe('guardedFetch carries a real POST and streams the response', () => {
  it('round-trips a JSON-RPC POST and exposes a streaming body', async () => {
    // A guard that only refuses is untested for the thing it must also do.
    const http = await import('node:http');
    const seen: Array<{ method: string; body: string; ct: string | undefined }> = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ method: req.method!, body, ct: req.headers['content-type'] });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'abc' });
        res.end('data: {"jsonrpc":"2.0","id":1}\n\n');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await guardedFetch(
        `http://127.0.0.1:${port}/mcp`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"jsonrpc":"2.0","method":"initialize"}',
        },
        // The same seam net.ts's own tests use: fixtures live on loopback,
        // which the guard refuses in production and must keep refusing there.
        { allowHttp: true, isPrivateAddress: () => false },
      );
      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
      // The headers the MCP transport actually reads.
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(res.headers.get('mcp-session-id')).toBe('abc');
      expect(res.body).not.toBeNull();
      expect(await res.text()).toContain('jsonrpc');
      // The server received a real POST with our body and header.
      expect(seen).toHaveLength(1);
      expect(seen[0]!.method).toBe('POST');
      expect(seen[0]!.ct).toBe('application/json');
      expect(seen[0]!.body).toContain('initialize');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);
});
