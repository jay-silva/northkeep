import { describe, expect, it } from 'vitest';
import {
  NETWORK_FAILURE_MESSAGE,
  PRIVATE_BETA_MESSAGE,
  SUBSCRIPTION_ACTIVATION_HINT,
  SUBSCRIPTION_REQUIRED_MESSAGE,
  SYNC_LOCAL_SAFE_REASSURANCE,
  SYNC_MANAGED_OUTSIDE_APP,
  SYNC_SUBSCRIPTION_RECHECK,
  SYNC_SUPPORT_NEXT_STEP,
  SYNC_TURN_ON_LATER,
  classifySyncError,
  userFacingSyncError,
} from '../src/lib/sync-errors.js';

/**
 * WS4 neutral subscription activation. The load-bearing assertion here is
 * NEGATIVE: the sync server's CLI-flavored 402 copy (a price and a CLI
 * subscribe command) must never pass through to a mobile user, in any form the
 * error can arrive. App Store steering rules: no selling, no purchase link, no
 * price, no website.
 */

/**
 * The exact string @northkeep/sync's SubscriptionRequiredError carries today.
 * DRIFT WATCH: hardcoded on purpose (this test stays dependency-free, so do
 * NOT import it); the source of truth is the SubscriptionRequiredError
 * constructor in packages/sync/src/client.ts. If that copy changes, update
 * this constant to match or the negative steering assertions test the wrong
 * string.
 */
const CLI_402_MESSAGE =
  'This sync server requires a $10/month subscription. Run "northkeep sync subscribe".';

function subscriptionError(): Error {
  const err = new Error(CLI_402_MESSAGE);
  err.name = 'SubscriptionRequiredError';
  return err;
}

/** Things that must never reach a mobile user in subscription copy. */
function expectSteeringClean(text: string) {
  expect(text).not.toContain('northkeep sync subscribe');
  expect(text).not.toMatch(/\$\s*\d/); // no price
  expect(text).not.toMatch(/https?:|www\./i); // no link or website
  expect(text).not.toMatch(/subscribe\b/i); // no purchase verb ("subscribed" is fine)
  expect(text).not.toMatch(/[—–]/); // no em or en dashes anywhere in user copy
}

describe('classifySyncError: subscription-required (HTTP 402)', () => {
  it('replaces SubscriptionRequiredError (matched by name) with the neutral copy', () => {
    const result = classifySyncError(subscriptionError());
    expect(result.kind).toBe('subscription-required');
    expect(result.message).toContain(SUBSCRIPTION_REQUIRED_MESSAGE);
    expect(result.message).toContain(SUBSCRIPTION_ACTIVATION_HINT);
    expectSteeringClean(result.message);
  });

  it('catches the CLI string even when re-wrapping lost the error name', () => {
    const result = classifySyncError(new Error(CLI_402_MESSAGE));
    expect(result.kind).toBe('subscription-required');
    expectSteeringClean(result.message);
  });

  it('catches a raw HTTP 402 transport message', () => {
    const result = classifySyncError(new Error('Sync server returned HTTP 402 on push.'));
    expect(result.kind).toBe('subscription-required');
    expectSteeringClean(result.message);
  });

  it('catches the connector client 402 shapes (Phase B: plain Errors, no error name)', () => {
    // pushSharedScopes / startPairing / unshareScope fall through to the
    // generic "HTTP 402" message; downSyncConnector has its own wording with
    // NO "HTTP 402" token in it. Both must classify as subscription-required.
    for (const msg of [
      'Connector server returned HTTP 402 on push.',
      'Connector server returned HTTP 402 on pairing.',
      'The connector server requires an active subscription (402) to down-sync.',
    ]) {
      const result = classifySyncError(new Error(msg));
      expect(result.kind).toBe('subscription-required');
      expectSteeringClean(result.message);
    }
  });

  it('userFacingSyncError never emits the CLI copy for any 402 shape', () => {
    for (const err of [
      subscriptionError(),
      new Error(CLI_402_MESSAGE),
      CLI_402_MESSAGE, // non-Error throw carrying the string
    ]) {
      expectSteeringClean(userFacingSyncError(err));
    }
  });
});

describe('classifySyncError: other kinds', () => {
  it('maps HTTP 403 to the private-beta state', () => {
    for (const msg of [
      'Sync server returned HTTP 403 on push.',
      'Sync server returned HTTP 403 on pull.',
    ]) {
      const result = classifySyncError(new Error(msg));
      expect(result.kind).toBe('not-enabled');
      expect(result.message).toBe(PRIVATE_BETA_MESSAGE);
    }
  });

  it('maps transport failures to the retryable network message', () => {
    expect(classifySyncError(new TypeError('Network request failed'))).toEqual({
      kind: 'network',
      message: NETWORK_FAILURE_MESSAGE,
    });
    const abort = new Error('Aborted');
    abort.name = 'AbortError';
    expect(classifySyncError(abort).kind).toBe('network');
  });

  // expo/fetch (SDK 55) wraps every native failure as FetchError with
  // name 'Error' — none of these are TypeErrors, so classification has to work
  // off the message shape. These are the real strings the phone can produce.
  it('recognizes the expo/fetch transport failures verbatim', () => {
    for (const message of [
      'fetch failed: The Internet connection appears to be offline.',
      'fetch failed: A server with the specified hostname could not be found.',
      'Fetch request has been canceled',
    ]) {
      expect(classifySyncError(new Error(message))).toEqual({
        kind: 'network',
        message: NETWORK_FAILURE_MESSAGE,
      });
    }
  });

  // The transport sets redirect:'error' so a redirect cannot re-send the bearer
  // token to an attacker's Location. expo wraps that refusal as
  // "fetch failed: Redirect is not allowed…", which the generic transport match
  // would otherwise swallow — reporting a security refusal as flaky wifi.
  it('reports a refused redirect as itself, not as a connection failure', () => {
    for (const message of [
      "Redirect is not allowed when redirect mode is 'error'",
      "fetch failed: Redirect is not allowed when redirect mode is 'error'",
    ]) {
      const result = classifySyncError(new Error(message));
      expect(result.kind).toBe('redirect-refused');
      expect(result.message).not.toBe(NETWORK_FAILURE_MESSAGE);
      expect(result.message).toMatch(/redirected somewhere else/i);
    }
  });

  // REGRESSION (the "could not reach the sync server" bug): a TypeError raised
  // by our own code before any socket opens must NOT be dressed up as a network
  // failure. Hermes' Buffer.subarray() drops .equals, and the resulting
  // TypeError told the user to check their wifi while the server was healthy.
  it('does not disguise a non-transport TypeError as a connection failure', () => {
    const bug = new TypeError('blob.subarray(...).equals is not a function');
    const result = classifySyncError(bug);
    expect(result.kind).toBe('other');
    expect(result.message).toBe('blob.subarray(...).equals is not a function');
    expect(result.message).not.toBe(NETWORK_FAILURE_MESSAGE);
  });

  it('passes other user-facing sync messages through unchanged', () => {
    const message =
      'Vault is 5.0 MB, over the 4 MB sync limit.';
    expect(classifySyncError(new Error(message))).toEqual({ kind: 'other', message });
  });

  it('stringifies non-Error throwables', () => {
    expect(classifySyncError('boom')).toEqual({ kind: 'other', message: 'boom' });
  });
});

describe('the neutral copy itself stays steering-clean', () => {
  it('contains no price, link, purchase verb, or em dash', () => {
    for (const s of [
      SUBSCRIPTION_REQUIRED_MESSAGE,
      SUBSCRIPTION_ACTIVATION_HINT,
      PRIVATE_BETA_MESSAGE,
      NETWORK_FAILURE_MESSAGE,
      // Wave 2 dignified paywall copy shares the same steering net.
      SYNC_LOCAL_SAFE_REASSURANCE,
      SYNC_MANAGED_OUTSIDE_APP,
      SYNC_SUBSCRIPTION_RECHECK,
      SYNC_SUPPORT_NEXT_STEP,
      SYNC_TURN_ON_LATER,
    ]) {
      expectSteeringClean(s);
    }
  });
});
