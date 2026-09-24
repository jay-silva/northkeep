import { afterEach, describe, expect, it } from 'vitest';
import { redact } from '@northkeep/redact';
import { SUPERSET_ENTITIES, SUPERSET_INPUTS, missingAtTier3, supersetNer } from '../../redact/test/superset-fixture.js';
import { createHarness, text, type Harness } from './harness-0060.js';

/**
 * ADR 0060 W2 over MCP: at NORTHKEEP_REDACT_TIER=3 no value that Tier 2
 * masks in a returned memory is returned in the clear.
 */
let h: Harness;
afterEach(async () => { await h.close(); });

describe('ADR 0060 W2: Tier 3 returns nothing Tier 2 masks (MCP)', () => {
  it('W2 MCP: memory_list at Tier 3', async () => {
    h = createHarness({ find: (t) => SUPERSET_ENTITIES.filter((e) => t.includes(e)) });
    const vault = h.openVault();
    for (const content of SUPERSET_INPUTS) vault.remember({ content, type: 'semantic', scope: 'personal' });
    vault.save();
    vault.close();
    process.env.NORTHKEEP_REDACT_TIER = '3';
    const mcp = await h.connect();
    const out = text(await mcp.callTool({ name: 'memory_list', arguments: {} }));
    const originals = (await Promise.all(SUPERSET_INPUTS.map(async (i) => (await redact(i, { tier: 2 }, supersetNer())).replacements.map((r) => r.original)))).flat();
    const contents = (JSON.parse(out) as { memories: Array<{ content: string }> }).memories.map((m) => m.content).join('\n');
    expect(missingAtTier3(originals, contents)).toEqual([]);
  });
});
