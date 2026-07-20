import { describe, expect, it } from 'vitest';
import {
  NETWORK_FAILURE_MESSAGE,
  PRIVATE_BETA_MESSAGE,
  SUBSCRIPTION_ACTIVATION_HINT,
  SUBSCRIPTION_REQUIRED_MESSAGE,
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

/** The exact string @northkeep/sync's SubscriptionRequiredError carries today. */
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
    ]) {
      expectSteeringClean(s);
    }
  });
});
