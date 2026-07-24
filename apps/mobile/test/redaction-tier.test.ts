import { describe, expect, it } from 'vitest';
import {
  ON_DEVICE_PRIVATE_LABEL,
  PROVIDER_TIER_INTRO,
  TIER1_ONLY_LABEL,
  TIER2_ONDEVICE_LABEL,
  effectiveTierLabel,
} from '../src/lib/redaction-tier.js';

/**
 * Wave 2 per-provider effective-tier labels. The mapping is the whole point:
 * Apple FM NER available on this phone -> Tier 2 (names pseudonymized on
 * device); unavailable -> Tier 1 only. The label must never over-claim.
 */

/** Same steering/em-dash net used across the app's user-facing copy. */
function expectSteeringClean(text: string) {
  expect(text).not.toMatch(/\$\s*\d/); // no price
  expect(text).not.toMatch(/https?:|www\./i); // no link or website
  expect(text).not.toMatch(/subscribe\b/i); // no purchase verb
  expect(text).not.toMatch(/[—–]/); // no em or en dashes
}

describe('effectiveTierLabel', () => {
  it('claims Tier 2 only when on-device NER is available', () => {
    expect(effectiveTierLabel(true)).toBe(TIER2_ONDEVICE_LABEL);
  });

  it('falls back to Tier 1 only when it is not', () => {
    expect(effectiveTierLabel(false)).toBe(TIER1_ONLY_LABEL);
  });

  it('never returns the Tier-2 copy for the unavailable case', () => {
    // Truthfulness guard: the unavailable label must not imply on-device
    // pseudonymization the phone cannot perform.
    expect(effectiveTierLabel(false)).not.toContain('pseudonymized');
  });
});

describe('tier copy stays honest and steering-clean', () => {
  it('has no price, link, purchase verb, or em dash', () => {
    for (const s of [
      TIER2_ONDEVICE_LABEL,
      TIER1_ONLY_LABEL,
      ON_DEVICE_PRIVATE_LABEL,
      PROVIDER_TIER_INTRO,
    ]) {
      expectSteeringClean(s);
    }
  });

  it('the Tier-1 label names the concrete masks and the honest gap', () => {
    // Aligns with the converse.tsx warn banner: unusual names can slip through.
    expect(TIER1_ONLY_LABEL.toLowerCase()).toContain('slip through');
  });
});
