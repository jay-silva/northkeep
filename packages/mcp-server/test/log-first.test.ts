import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vault } from '@northkeep/core';
import { createHarness, logRows, text, type Harness } from './harness-0060.js';

/**
 * ADR 0060 Decision 5 (D7, Jay: "Log before writing"). A pending row is
 * written before a tool runs; no row, no call. The done row with the same
 * call_id carries the outcome.
 */

let h: Harness;
afterEach(async () => {
  vi.restoreAllMocks();
  await h.close();
});

function blockLog(): void {
  fs.mkdirSync(path.join(h.home, 'mcp-calls.log'));
}

describe('ADR 0060 D7: log before acting', () => {
  it('C16: with an unwritable log, memory_remember and project_update do not happen', async () => {
    h = createHarness();
    const before = fs.readFileSync(h.vaultPath);
    blockLog();
    const mcp = await h.connect();
    const remember = await mcp.callTool({ name: 'memory_remember', arguments: { content: 'should not be saved', type: 'semantic' } });
    expect(remember.isError).toBe(true);
    expect(text(remember)).toBe('NorthKeep could not write its call log, so nothing was done.');
    const update = await mcp.callTool({ name: 'project_update', arguments: { project: 'demo', expected_revision: null, what_why: 'w', status: 's' } });
    expect(update.isError).toBe(true);
    expect(fs.readFileSync(h.vaultPath).equals(before)).toBe(true);
  });

  it('C30: memory_retrieve with an unwritable log opens no vault, not even to pre-embed', async () => {
    h = createHarness();
    blockLog();
    const opens = vi.spyOn(Vault, 'openWithKey');
    const mcp = await h.connect();
    const r = await mcp.callTool({ name: 'memory_retrieve', arguments: { query: 'anything' } });
    expect(r.isError).toBe(true);
    expect(opens).not.toHaveBeenCalled();
  });

  it('C17: a failed completion row after a write returns a content-free acknowledgement; after a read, nothing', async () => {
    h = createHarness();
    const mcp = await h.connect();
    const real = fs.appendFileSync;
    let appends = 0;
    // Let the pending row through, then fail the completion row.
    vi.spyOn(fs, 'appendFileSync').mockImplementation(((...args: Parameters<typeof fs.appendFileSync>) => {
      appends += 1;
      if (appends % 2 === 0) throw new Error('disk full');
      return real(...args);
    }) as typeof fs.appendFileSync);
    const write = await mcp.callTool({ name: 'memory_remember', arguments: { content: 'Mom lives in Denver.', type: 'semantic' } });
    expect(write.isError).toBeFalsy();
    const ack = JSON.parse(text(write)) as Record<string, unknown>;
    expect(ack).toEqual({ saved: true, id: expect.any(String), log_warning: 'The change was saved, but its log entry could not be completed.' });
    expect(text(write)).not.toContain('Denver');
    const read = await mcp.callTool({ name: 'memory_list', arguments: {} });
    expect(read.isError).toBe(true);
    expect(text(read)).toBe('NorthKeep could not complete its call log, so nothing was returned.');
    vi.restoreAllMocks();
    const vault = h.openVault();
    expect(vault.list().map((e) => e.content)).toEqual(['Mom lives in Denver.']);
    vault.close();
  });

  it('C29: an error-path completion row carries phase done and the call id; ts stays the start time', async () => {
    h = createHarness();
    const mcp = await h.connect();
    const r = await mcp.callTool({ name: 'memory_forget', arguments: { id: '00000000-0000-4000-8000-000000000000' } });
    expect(r.isError).toBe(true);
    const rows = logRows(h.home).filter((row) => row.tool === 'memory_forget');
    expect(rows).toHaveLength(2);
    const [pending, done] = rows;
    expect(pending).toMatchObject({ phase: 'pending', ok: false, error: 'pending' });
    expect(done).toMatchObject({ phase: 'done', ok: false, call_id: pending!.call_id });
    expect(done!.ts).toBe(pending!.ts);
    expect(typeof done!.completed_at).toBe('string');
  });
});
