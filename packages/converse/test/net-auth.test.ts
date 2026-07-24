import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FetchRefusedError, hardenedFetch, type NetTestOverrides } from '../src/index.js';

/**
 * M10d — the ONE credential seam in the hardened client (ADR 0030 decision 1).
 * A fake server on loopback ECHOES the headers it received, so the tests can
 * PROVE, over real wires:
 *  - the bearer header is attached ONLY when the request host === authorizedHost;
 *  - it is ABSENT when the fetched host differs (a redirect/override elsewhere);
 *  - a redirect on the credentialed path is REFUSED, not chased (exactly one
 *    request happens, and the token never rides onward);
 *  - the uncredentialed redirect-follow path is UNCHANGED (no authToken → the
 *    existing 5-hop behavior, no token on any hop);
 *  - the token appears in neither the result nor an error message.
 * Loopback is what the production guard refuses, so this uses the TEST-ONLY
 * NetTestOverrides seam while the real pin/redirect/cap machinery runs.
 */

const TOKEN = 'super-secret-brave-token-abc123';
const HDR = 'X-Subscription-Token';
const HDR_LC = HDR.toLowerCase(); // node lowercases received header names

describe('hardenedFetch authToken — the credential seam (ADR 0030 decision 1)', () => {
  let server: http.Server;
  let port = 0;
  /** Every request the fixture saw: its path and the headers it received. */
  const received: Array<{ path: string; headers: http.IncomingHttpHeaders }> = [];

  // TEST-ONLY: route the fake hosts to loopback; nothing is "private" here so
  // the redirect-refusal (not a private-address refusal) is what we observe.
  const overrides = (): NetTestOverrides => ({
    allowHttp: true,
    resolver: (host) =>
      host === 'api.fixture.test' || host === 'other.fixture.test'
        ? Promise.resolve([{ address: '127.0.0.1', family: 4 }])
        : Promise.reject(new Error(`no fake DNS for ${host}`)),
    isPrivateAddress: () => false,
  });

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      received.push({ path: req.url ?? '/', headers: req.headers });
      if ((req.url ?? '/') === '/redir') {
        res.statusCode = 302;
        res.setHeader('location', `http://api.fixture.test:${port}/landing`);
        res.end();
      } else {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  const authToken = (authorizedHost: string) => ({ headerName: HDR, value: TOKEN, authorizedHost });
  const url = (host: string, path: string) => `http://${host}:${port}${path}`;

  it('attaches the credential ONLY on the authorized host', async () => {
    received.length = 0;
    const res = await hardenedFetch(url('api.fixture.test', '/page'), {
      authToken: authToken('api.fixture.test'),
      testOverrides: overrides(),
    });
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]!.headers[HDR_LC]).toBe(TOKEN);
  });

  it('does NOT attach the credential when the fetched host is not the authorized host', async () => {
    received.length = 0;
    // authorizedHost points at a DIFFERENT host than the one being fetched —
    // the token must not ride to api.fixture.test.
    const res = await hardenedFetch(url('api.fixture.test', '/page'), {
      authToken: authToken('other.fixture.test'),
      testOverrides: overrides(),
    });
    expect(res.status).toBe(200);
    expect(received[0]!.headers[HDR_LC]).toBeUndefined();
  });

  it('REFUSES a redirect on the credentialed path and never chases it', async () => {
    received.length = 0;
    let caught: unknown;
    try {
      await hardenedFetch(url('api.fixture.test', '/redir'), {
        authToken: authToken('api.fixture.test'),
        testOverrides: overrides(),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FetchRefusedError);
    expect((caught as FetchRefusedError).code).toBe('redirect-refused');
    expect((caught as FetchRefusedError).status).toBe(302);
    // EXACTLY ONE request: the redirect to /landing was not followed, so the
    // token never went anywhere but the first (authorized) request.
    expect(received).toHaveLength(1);
    expect(received[0]!.path).toBe('/redir');
    expect(received[0]!.headers[HDR_LC]).toBe(TOKEN);
  });

  it('an uncredentialed redirect still follows, unchanged, with no token on any hop', async () => {
    received.length = 0;
    const res = await hardenedFetch(url('api.fixture.test', '/redir'), { testOverrides: overrides() });
    expect(res.status).toBe(200);
    // Two hops: /redir → /landing, the existing behavior, and neither carried a token.
    expect(received.map((r) => r.path)).toEqual(['/redir', '/landing']);
    expect(received.every((r) => r.headers[HDR_LC] === undefined)).toBe(true);
  });

  it('leaks the token in neither the result nor an error message', async () => {
    received.length = 0;
    const res = await hardenedFetch(url('api.fixture.test', '/page'), {
      authToken: authToken('api.fixture.test'),
      testOverrides: overrides(),
    });
    expect(JSON.stringify(res)).not.toContain(TOKEN);

    let message = '';
    try {
      await hardenedFetch(url('api.fixture.test', '/redir'), {
        authToken: authToken('api.fixture.test'),
        testOverrides: overrides(),
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain(TOKEN);
  });
});
