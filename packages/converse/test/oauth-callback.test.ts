import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { awaitOAuthCallback, OAUTH_CALLBACK_PORT } from '../src/tools/mcp/oauth.js';

/**
 * The loopback callback listener (ADR 0035 Decision 8; adversarial review
 * 2026-07-27, findings 2 and 3).
 *
 * These tests bind the REAL fixed port, deliberately: the finding under test
 * was that `listen()` returns before the bind settles, so a fake listener
 * would prove nothing. The file's tests run sequentially, so the port is held
 * by at most one test at a time.
 */

const callbackUrl = (query: string): string =>
  `http://127.0.0.1:${OAUTH_CALLBACK_PORT}/oauth/callback?${query}`;

/** Is the fixed port bindable right now? Used to assert cleanup. */
async function portIsFree(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(OAUTH_CALLBACK_PORT, '127.0.0.1', () => {
      probe.close(() => resolve(true));
    });
  });
}

describe('awaitOAuthCallback', () => {
  it('delivers the code when the state matches, answers ONE request, and closes', async () => {
    const waiting = awaitOAuthCallback('expected-state');
    await waiting.ready;
    const res = await fetch(callbackUrl('code=the-code&state=expected-state'));
    expect(res.status).toBe(200);
    const got = await waiting.result;
    expect(got.code).toBe('the-code');
    expect(got.state).toBe('expected-state');
    // The one-request window has closed: nothing is listening any more.
    await expect(fetch(callbackUrl('code=again&state=expected-state'))).rejects.toThrow();
    expect(await portIsFree()).toBe(true);
  });

  it('rejects a WRONG state and delivers no code', async () => {
    const waiting = awaitOAuthCallback('expected-state');
    await waiting.ready;
    const res = await fetch(callbackUrl('code=stolen-code&state=attacker-state'));
    expect(res.status).toBe(400);
    await expect(waiting.result).rejects.toThrow(/did not match/);
    expect(await portIsFree()).toBe(true);
  });

  it('rejects a MISSING state when one was issued, fail closed', async () => {
    // The CSRF check must not be satisfiable by simply omitting the parameter.
    const waiting = awaitOAuthCallback('expected-state');
    await waiting.ready;
    const res = await fetch(callbackUrl('code=stolen-code'));
    expect(res.status).toBe(400);
    await expect(waiting.result).rejects.toThrow(/did not match/);
    expect(await portIsFree()).toBe(true);
  });

  it('rejects readiness when the port is already owned, before any code could arrive', async () => {
    // The scenario the review flagged: another process owns 8788, and a flow
    // that opens the browser anyway hands that process the sign-in code. A
    // caller awaiting `ready` fails here instead.
    const squatter = http.createServer(() => undefined);
    await new Promise<void>((r) => squatter.listen(OAUTH_CALLBACK_PORT, '127.0.0.1', r));
    try {
      const waiting = awaitOAuthCallback('expected-state');
      await expect(waiting.ready).rejects.toThrow(/already in use/);
      await expect(waiting.result).rejects.toThrow(/already in use/);
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  });

  it('times out, rejects, and releases the port', async () => {
    const waiting = awaitOAuthCallback('expected-state', 50);
    await waiting.ready;
    await expect(waiting.result).rejects.toThrow(/Timed out/);
    expect(await portIsFree()).toBe(true);
  });

  it('cancel before anything arrives releases the port and settles ready', async () => {
    const waiting = awaitOAuthCallback('expected-state');
    waiting.cancel();
    await waiting.ready; // must not hang when cancelled pre-bind
    expect(await portIsFree()).toBe(true);
  });
});
