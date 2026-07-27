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

describe('guardedFetch body shapes (adversarial review 2026-07-27, finding 1)', () => {
  /**
   * The SDK's token exchange and refresh POST URLSearchParams. The first
   * implementation JSON.stringify-ed any non-string body, and
   * JSON.stringify(new URLSearchParams(...)) is "{}", so every OAuth token
   * request silently carried an empty object. These tests pin each supported
   * shape as the exact bytes a local fixture receives.
   */
  const seen: Array<{ body: Buffer; ct: string | undefined }> = [];
  const withFixture = async (
    fn: (url: string) => Promise<void>,
    status = 200,
  ): Promise<void> => {
    const http = await import('node:http');
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({ body: Buffer.concat(chunks), ct: req.headers['content-type'] });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      await fn(`http://127.0.0.1:${port}/token`);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  };
  const seam = { allowHttp: true, isPrivateAddress: () => false };

  it('writes a URLSearchParams body as the urlencoded string, not "{}"', async () => {
    seen.length = 0;
    await withFixture(async (url) => {
      const res = await guardedFetch(
        url,
        { method: 'POST', body: new URLSearchParams({ a: 'one two', b: '&=' }) },
        seam,
      );
      expect(res.ok).toBe(true);
    });
    expect(seen[0]!.body.toString('utf8')).toBe('a=one+two&b=%26%3D');
    // fetch's own default when the caller set no content-type of their own.
    expect(seen[0]!.ct).toBe('application/x-www-form-urlencoded;charset=UTF-8');
  });

  it('round-trips an SDK-shaped token exchange with every field intact', async () => {
    // Exactly what auth.js executeTokenRequest sends: URLSearchParams body,
    // urlencoded content-type set via a Headers object.
    seen.length = 0;
    await withFixture(async (url) => {
      const res = await guardedFetch(
        url,
        {
          method: 'POST',
          headers: new Headers({
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          }),
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: 'the-code',
            code_verifier: 'the-verifier',
            redirect_uri: 'http://127.0.0.1:8788/oauth/callback',
            client_id: 'client-123',
          }),
        },
        seam,
      );
      expect(res.ok).toBe(true);
      expect(await res.json()).toEqual({ ok: true });
    });
    const got = new URLSearchParams(seen[0]!.body.toString('utf8'));
    expect(got.get('grant_type')).toBe('authorization_code');
    expect(got.get('code')).toBe('the-code');
    expect(got.get('code_verifier')).toBe('the-verifier');
    expect(got.get('redirect_uri')).toBe('http://127.0.0.1:8788/oauth/callback');
    expect(got.get('client_id')).toBe('client-123');
    // The caller's own content-type header wins over the URLSearchParams default.
    expect(seen[0]!.ct).toBe('application/x-www-form-urlencoded');
  });

  it('writes a Uint8Array body byte-exact', async () => {
    seen.length = 0;
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 128, 10, 13]);
    await withFixture(async (url) => {
      await guardedFetch(url, { method: 'POST', body: bytes }, seam);
    });
    expect(Array.from(seen[0]!.body)).toEqual(Array.from(bytes));
  });

  it('connects through a HOSTNAME, exercising the pinned lookup override', async () => {
    // Every other fixture in this file dials 127.0.0.1, an IP literal, which
    // skips the custom lookup entirely. Node 20+ calls that lookup with
    // {all:true} (autoSelectFamily) and requires an array back; answering in
    // the old (addr, family) shape broke every real-hostname fetch — including
    // all of OAuth discovery — while every loopback test stayed green. This
    // test is the canary: a hostname, resolved by the seam to the fixture.
    seen.length = 0;
    await withFixture(async (url) => {
      const port = new URL(url).port;
      const res = await guardedFetch(
        `http://oauth-discovery.test:${port}/token`,
        { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code' }) },
        {
          ...seam,
          resolver: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
        },
      );
      expect(res.ok).toBe(true);
    });
    expect(seen[0]!.body.toString('utf8')).toBe('grant_type=authorization_code');
  });

  it('throws loudly on a body shape it does not support', async () => {
    // A silent JSON-ification is exactly the bug this section exists to keep
    // out; anything unrecognized must refuse before a request is made.
    await expect(
      guardedFetch(
        'https://example.com/token',
        { method: 'POST', body: { grant_type: 'oops' } as unknown as BodyInit },
        seam,
      ),
    ).rejects.toThrow(/string, URLSearchParams, and Uint8Array/);
  });
});
