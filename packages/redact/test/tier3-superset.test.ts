import { describe, expect, it } from 'vitest';
import { redact } from '../src/index.js';
import { SUPERSET_INPUTS, missingAtTier3, supersetNer } from './superset-fixture.js';

/**
 * ADR 0060 W2 (claims recheck): Tier 3's strict gate dropped entities made of
 * common English words, so "First National Bank" and "Acme Widgets" went out
 * at Tier 3 while Tier 2 masked them, and the result still said Tier 3.
 * Property: on the same input and the same name model, every value Tier 2
 * masks is also masked at Tier 3. The same inputs run on chat, the cloud
 * review and MCP in their own packages' tier3-superset tests.
 */
describe('ADR 0060 W2: Tier 3 masks everything Tier 2 masks (redact)', () => {
  for (const input of SUPERSET_INPUTS) {
    it(`W2 redact: ${input.slice(0, 40)}`, async () => {
      const t2 = await redact(input, { tier: 2 }, supersetNer());
      const t3 = await redact(input, { tier: 3 }, supersetNer());
      expect(t3.tierApplied).toBe(3);
      expect(t3.tier2Degraded).toBe(false);
      expect(missingAtTier3(t2.replacements.map((r) => r.original), t3.redacted)).toEqual([]);
    });
  }
});
