import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  classifyFetchTarget,
  FetchRefusedError,
  hardenedFetch,
  type NetTestOverrides,
} from '../src/index.js';

/**
 * M10b — the SSRF guard and hardened web client (ADR 0028). The URL-layer
 * suite runs with NO overrides (the production guard, nasty spellings and
 * all). The client suite runs against a local fixture server, which lives on
 * loopback — exactly what the production guard refuses — so it uses the
 * clearly-marked TEST-ONLY injection seam (resolver/classifier/allowHttp)
 * while exercising the real pinning, redirect, cap, and timeout paths.
 */

describe('classifyFetchTarget — the nasty-URL suite (production guard, no overrides)', () => {
  const refuse = (url: string, code: string) => {
    const r = classifyFetchTarget(url);
    expect(r.ok, `${url} should be refused`).toBe(false);
    if (!r.ok) expect(r.code, url).toBe(code);
  };
  const allow = (url: string) => {
    expect(classifyFetchTarget(url).ok, `${url} should pass`).toBe(true);
  };

  it('refuses private, loopback, link-local, and unspecified addresses in every spelling', () => {
    refuse('https://127.0.0.1/', 'private-address');
    refuse('https://0x7f.1/', 'private-address'); // hex-dotted → 127.0.0.1
    refuse('https://2130706433/', 'private-address'); // decimal → 127.0.0.1
    refuse('https://[::ffff:127.0.0.1]/', 'private-address'); // IPv4-mapped
    refuse('https://[::1]/', 'private-address');
    refuse('https://169.254.169.254/latest/meta-data/', 'private-address'); // cloud metadata
    refuse('https://[fd00::1]/', 'private-address'); // ULA
    refuse('https://[fe80::1]/', 'private-address'); // link-local
    refuse('https://0.0.0.0/', 'private-address');
    refuse('https://10.1.2.3/', 'private-address');
    refuse('https://192.168.1.10/', 'private-address');
    refuse('https://172.16.0.1/', 'private-address');
  });

  it('refuses the ranges G2 review 2026-07-24 reproduced dialing', () => {
    // CGNAT / shared 100.64/10 — includes 100.100.100.200 (Alibaba metadata);
    // also Tailscale's range, so private for the badge too.
    refuse('https://100.100.100.200/', 'private-address');
    refuse('https://100.64.0.1/', 'private-address');
    refuse('https://100.127.255.255/', 'private-address');
    // Whole 0.0.0.0/8, not just the single 0.0.0.0 (Linux routes 0.x to loopback).
    refuse('https://0.1.2.3/', 'private-address');
    refuse('https://[::]/', 'private-address'); // IPv6 unspecified
    // Embedded-v4 IPv6 forms that reach private space.
    refuse('https://[::7f00:1]/', 'private-address'); // ::127.0.0.1 (v4-compatible)
    refuse('https://[64:ff9b::a00:1]/', 'private-address'); // NAT64 → 10.0.0.1
    // Guardrail: 100.63/8 and 100.128/9 are NOT CGNAT — must stay public.
    expect(classifyFetchTarget('https://100.63.0.1/').ok).toBe(true);
    expect(classifyFetchTarget('https://100.128.0.1/').ok).toBe(true);
    // NAT64 embedding a PUBLIC v4 stays public.
    expect(classifyFetchTarget('https://[64:ff9b::808:808]/').ok).toBe(true); // → 8.8.8.8
  });

  it('refuses name-based local hosts', () => {
    refuse('https://localhost/', 'private-address');
    refuse('https://foo.localhost/', 'private-address');
    refuse('https://printer.local/', 'private-address');
  });

  it('refuses embedded credentials', () => {
    refuse('https://user@example.com/', 'userinfo');
    refuse('https://user:pass@example.com/', 'userinfo');
  });

  it('refuses non-https schemes', () => {
    refuse('http://example.com/', 'scheme');
    refuse('ftp://example.com/', 'scheme');
    refuse('file:///etc/passwd', 'scheme');
    refuse('data:text/html,<h1>x</h1>', 'scheme');
    refuse('javascript:alert(1)', 'scheme');
  });

  it('refuses non-allowlisted ports; allows 443 and 8443', () => {
    refuse('https://example.com:8080/', 'bad-port');
    refuse('https://example.com:22/', 'bad-port');
    allow('https://example.com:8443/');
    allow('https://example.com:443/'); // WHATWG normalizes the default port away
  });

  it('refuses garbage', () => {
    refuse('not a url at all', 'unparseable');
    refuse('https://', 'unparseable');
  });

  it('allows public hosts, including punycode', () => {
    allow('https://example.com/page?q=1');
    allow('https://xn--nxasmq6b.example/'); // punycode label
    allow('https://8.8.8.8/'); // public IP literal
  });

  it('a public DNS name that merely LOOKS private passes the URL layer (DNS layer decides)', () => {
    allow('https://127.0.0.1.evil.example/');
  });
});

describe('hardenedFetch — against a local fixture server (TEST-ONLY injection seam)', () => {
  let server: http.Server;
  let port = 0;
  /** Hosts seen by the fixture server (proves the Host header carried the hostname). */
  const seenHosts: string[] = [];

  // TEST-ONLY overrides: route "fixture.test" to the local loopback server and
  // treat only 10.x as private, so the redirect-refusal path is provable.
  const overrides = (): NetTestOverrides => ({
    allowHttp: true,
    resolver: (host) => {
      if (host === 'fixture.test' || host === 'redirects.test') {
        return Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
      }
      if (host === 'mixed.test') {
        // A mixed public/private DNS answer — what rebinding looks like.
        return Promise.resolve([
          { address: '93.184.216.34', family: 4 },
          { address: '10.0.0.7', family: 4 },
        ]);
      }
      return Promise.reject(new Error(`no fake DNS for ${host}`));
    },
    isPrivateAddress: (ip) => ip.startsWith('10.'),
  });

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seenHosts.push(req.headers.host ?? '');
      const path = req.url ?? '/';
      if (path === '/page') {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end('<html><body><p>hello fixture</p></body></html>');
      } else if (path === '/big') {
        res.setHeader('content-type', 'text/plain');
        res.write('x'.repeat(5000));
        res.end('y'.repeat(5000));
      } else if (path === '/slow') {
        res.setHeader('content-type', 'text/plain');
        // headers sent, body never finishes
        res.write('starting…');
      } else if (path === '/pdf') {
        res.setHeader('content-type', 'application/pdf');
        res.end('%PDF-1.7 not for you');
      } else if (path === '/to-private') {
        res.statusCode = 302;
        res.setHeader('location', 'http://10.0.0.7/secret');
        res.end();
      } else if (path === '/to-page') {
        res.statusCode = 301;
        res.setHeader('location', `http://fixture.test:${port}/page`);
        res.end();
      } else if (path.startsWith('/loop')) {
        res.statusCode = 302;
        res.setHeader('location', `http://fixture.test:${port}/loop${path.length}`);
        res.end();
      } else if (path === '/missing') {
        res.statusCode = 404;
        res.end('nope');
      } else {
        res.setHeader('content-type', 'text/plain');
        res.end('ok');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  const url = (path: string) => `http://fixture.test:${port}${path}`;

  it('fetches through the pinned dial: resolver address is used, Host header keeps the hostname', async () => {
    seenHosts.length = 0;
    const res = await hardenedFetch(url('/page'), { testOverrides: overrides() });
    expect(res.status).toBe(200);
    expect(res.contentType).toBe('text/html');
    expect(res.body).toContain('hello fixture');
    expect(res.host).toBe('fixture.test');
    // The socket reached OUR server (loopback — only the pin could take it
    // there; fixture.test has no real DNS) with the HOSTNAME in Host.
    expect(seenHosts[0]).toBe(`fixture.test:${port}`);
  });

  it('refuses when ANY resolved address is private (mixed answer = rebinding shape)', async () => {
    await expect(
      hardenedFetch(`http://mixed.test:${port}/page`, { testOverrides: overrides() }),
    ).rejects.toMatchObject({ code: 'private-address' });
  });

  it('caps the body mid-stream and marks the result truncated', async () => {
    const res = await hardenedFetch(url('/big'), { maxBytes: 1000, testOverrides: overrides() });
    expect(res.truncated).toBe(true);
    expect(res.bytes).toBe(1000);
  });

  it('times out a stalled body with code "timeout"', async () => {
    await expect(
      hardenedFetch(url('/slow'), { timeoutMs: 300, testOverrides: overrides() }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('rejects disallowed content types WITHOUT reading the body', async () => {
    await expect(
      hardenedFetch(url('/pdf'), { testOverrides: overrides() }),
    ).rejects.toMatchObject({ code: 'content-type' });
  });

  it('follows an allowed redirect hop (re-validated) to the final page', async () => {
    const res = await hardenedFetch(url('/to-page'), { testOverrides: overrides() });
    expect(res.body).toContain('hello fixture');
    expect(res.finalUrl).toBe(url('/page'));
  });

  it('REFUSES a redirect hop into private address space', async () => {
    await expect(
      hardenedFetch(url('/to-private'), { testOverrides: overrides() }),
    ).rejects.toMatchObject({ code: 'private-address' });
  });

  it('caps redirect chains at 5 hops', async () => {
    await expect(
      hardenedFetch(url('/loop'), { testOverrides: overrides() }),
    ).rejects.toMatchObject({ code: 'too-many-redirects' });
  });

  it('surfaces non-2xx statuses as http-status with the code attached', async () => {
    let caught: unknown;
    try {
      await hardenedFetch(url('/missing'), { testOverrides: overrides() });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FetchRefusedError);
    expect((caught as FetchRefusedError).code).toBe('http-status');
    expect((caught as FetchRefusedError).status).toBe(404);
  });

  it('an aborted user signal maps to "cancelled"', async () => {
    const controller = new AbortController();
    const pending = hardenedFetch(url('/slow'), {
      signal: controller.signal,
      testOverrides: overrides(),
    });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });
});
