import { afterEach, describe, expect, it } from 'vitest';
import { PROJECT_DOC_CAP_MESSAGE } from '@northkeep/core';
import { createHarness, text, type Harness } from './harness-0060.js';

/**
 * ADR 0060 Decision 6 (D8): the local project_update description told agents
 * that big documents are refused and to prune the Log, which ADR 0045 made
 * false. The new text states the true rule, including the edge it still refuses.
 */

let h: Harness;
afterEach(async () => { await h.close(); });

describe('ADR 0060 D8: project_update tells the truth about size', () => {
  it('C19: the description says the Log rolls, and neither "prune" nor "never refused"', async () => {
    h = createHarness();
    const mcp = await h.connect();
    const { tools } = await mcp.listTools();
    const description = tools.find((t) => t.name === 'project_update')!.description!;
    expect(description).toContain('roll into an archive memory');
    expect(description).toContain('still over 16384 characters with just the newest Log entry kept');
    expect(description).not.toMatch(/prune/i);
    expect(description).not.toMatch(/never refused/i);
  });

  it('C19: the edge the description names is refused with the cap message (review attack 24)', async () => {
    h = createHarness();
    const mcp = await h.connect();
    const created = JSON.parse(text(await mcp.callTool({
      name: 'project_create', arguments: { project: 'big', what_why: 'w'.repeat(14000), status: 'ok' },
    }))) as { revision: string };
    const r = await mcp.callTool({
      name: 'project_update', arguments: { project: 'big', expected_revision: created.revision, log_entry: 'x'.repeat(4000) },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(PROJECT_DOC_CAP_MESSAGE);
  });
});
