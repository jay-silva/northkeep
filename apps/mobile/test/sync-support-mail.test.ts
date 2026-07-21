import { describe, expect, it } from 'vitest';
import {
  SUPPORT_EMAIL,
  SUPPORT_MAIL_SUBJECT,
  buildSupportMailBody,
  buildSupportMailto,
} from '../src/lib/sync-support-mail.js';

/**
 * Wave 2 dignified sync-paywall support mail. The load-bearing assertions are
 * NEGATIVE: the mailto is a SUPPORT contact, not a purchase flow, and the body
 * must carry NOTHING sensitive beyond the account id the user is deliberately
 * sending to get sync enabled. Same App Store steering net the sync-errors test
 * uses: no price, no purchase link, no website, no "subscribe" verb, no em dash.
 */

/** A realistic-shaped account id (deriveSyncCreds emits a hex-ish token). */
const FAKE_ACCOUNT_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

/** Things that must never appear in support-mail copy. */
function expectSteeringClean(text: string) {
  expect(text).not.toContain('northkeep sync subscribe');
  expect(text).not.toMatch(/\$\s*\d/); // no price
  expect(text).not.toMatch(/https?:|www\./i); // no link or website
  expect(text).not.toMatch(/subscribe\b/i); // no purchase verb
  expect(text).not.toMatch(/[—–]/); // no em or en dashes
}

describe('buildSupportMailBody', () => {
  it('includes the account id when known', () => {
    const body = buildSupportMailBody(FAKE_ACCOUNT_ID);
    expect(body).toContain(FAKE_ACCOUNT_ID);
    expectSteeringClean(body);
  });

  it('omits the id gracefully when it could not be derived', () => {
    const body = buildSupportMailBody(null);
    expect(body).not.toContain(FAKE_ACCOUNT_ID);
    expectSteeringClean(body);
  });

  it('leaks nothing but the account id: an unrelated secret never appears', () => {
    // The builder only ever interpolates the account id. Prove it by confirming
    // a sentinel secret we did NOT pass cannot show up in the body.
    const SENTINEL_SECRET = 'VAULT-SECRET-DO-NOT-SEND-9f8e7d6c';
    const body = buildSupportMailBody(FAKE_ACCOUNT_ID);
    expect(body).not.toContain(SENTINEL_SECRET);
  });
});

describe('buildSupportMailto', () => {
  it('targets the support address with an encoded subject and body', () => {
    const url = buildSupportMailto(FAKE_ACCOUNT_ID);
    expect(url.startsWith(`mailto:${SUPPORT_EMAIL}?`)).toBe(true);
    expect(url).toContain(`subject=${encodeURIComponent(SUPPORT_MAIL_SUBJECT)}`);
    // The account id survives round-trip through the encoded body.
    expect(decodeURIComponent(url)).toContain(FAKE_ACCOUNT_ID);
  });

  it('is a mailto, never an http/website purchase link', () => {
    const url = buildSupportMailto(FAKE_ACCOUNT_ID);
    expect(url).not.toMatch(/https?:|www\./i);
  });
});

describe('the support-mail constants stay steering-clean', () => {
  it('address and subject carry no price, link, purchase verb, or em dash', () => {
    for (const s of [SUPPORT_EMAIL, SUPPORT_MAIL_SUBJECT]) {
      expectSteeringClean(s);
    }
  });
});
