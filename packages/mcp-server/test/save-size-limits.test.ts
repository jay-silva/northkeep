import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createHarness, text, type Harness } from './harness-0060.js';

/**
 * An assistant's save is refused where it can still shorten the text: a
 * shared memory over the connector's byte cap, or a Current Status too long
 * to read as the project summary. Before this, both saved and later broke a
 * push or a page.
 */

let h: Harness;
afterEach(async () => { await h.close(); });

async function attempt(mcp: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  try {
    const r = await mcp.callTool({ name, arguments: args });
    return { isError: r.isError === true, text: text(r) };
  } catch (error) {
    return { isError: true, text: (error as Error).message };
  }
}

function share(scope: string): void {
  const vault = h.openVault();
  vault.setScopeShared(scope, true);
  vault.save();
  vault.close();
}

// 3,000 characters, 9,000 bytes: under the old character limit, over the connector's.
const WIDE = '€'.repeat(3000);

describe('shared memories are checked in bytes at save time', () => {
  it('refuses a remember into a shared scope that the connector would refuse', async () => {
    h = createHarness();
    share('conversations');
    const mcp = await h.connect();
    const r = await attempt(mcp, 'memory_remember', { content: WIDE, type: 'episodic', scope: 'conversations' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Nothing was saved: this memory is 8.8 KB');
    expect(r.text).toContain('at most 8 KB');
    const vault = h.openVault();
    expect(vault.list({ scope: 'conversations' })).toHaveLength(0);
    vault.close();
  });

  it('keeps the same text in a private scope, which never reaches the connector', async () => {
    h = createHarness();
    const mcp = await h.connect();
    const r = await attempt(mcp, 'memory_remember', { content: WIDE, type: 'episodic', scope: 'conversations' });
    expect(r.isError).toBe(false);
  });

  it('refuses an edit that grows a shared memory past the cap, and keeps the old text', async () => {
    h = createHarness();
    share('conversations');
    const mcp = await h.connect();
    const saved = await attempt(mcp, 'memory_remember', { content: 'Short.', type: 'episodic', scope: 'conversations' });
    const id = (JSON.parse(saved.text) as { stored: { id: string } }).stored.id;
    const r = await attempt(mcp, 'memory_edit', { id, content: WIDE });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Nothing was saved');
    const vault = h.openVault();
    expect(vault.list({ scope: 'conversations' }).map((e) => e.content)).toEqual(['Short.']);
    vault.close();
  });

  it('lets the owner edit past the cap, since only an assistant is asked to shorten', async () => {
    h = createHarness();
    share('conversations');
    const vault = h.openVault();
    const entry = vault.remember({ content: 'Short.', type: 'episodic', scope: 'conversations', source: 'user' });
    expect(() => vault.editMemory(entry.id, { content: WIDE }, { actor: 'owner' })).not.toThrow();
    vault.close();
  });
});

describe('Current Status is short enough to read as a summary', () => {
  const plan = 'M1 Agree the milestones | test: the user approves the plan';

  it('refuses a project_create from an assistant with a status over 1,000 characters', async () => {
    h = createHarness();
    const mcp = await h.connect();
    const r = await attempt(mcp, 'project_create', { project: 'long', what_why: 'Why.', status: 'x'.repeat(1001), milestones: plan });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('status is 1001 characters, and the limit is 1000');
    expect(r.text).toContain('no commit hashes');
  });

  it('accepts exactly 1,000 characters, and states the rule in the schema', async () => {
    h = createHarness();
    const mcp = await h.connect();
    const r = await attempt(mcp, 'project_create', { project: 'edge', what_why: 'Why.', status: 'x'.repeat(1000), milestones: plan });
    expect(r.isError).toBe(false);
    const { tools } = await mcp.listTools();
    for (const name of ['project_create', 'project_update', 'project_checkpoint', 'project_wrap']) {
      const status = (tools.find((t) => t.name === name)!.inputSchema.properties as Record<string, { description: string }>).status;
      expect(status.description).toContain('At most 1000 characters');
      expect(status.description).toContain('no commit hashes');
    }
  });

  it('refuses a raw memory_edit of the project document that lengthens the status', async () => {
    h = createHarness();
    const mcp = await h.connect();
    await attempt(mcp, 'project_create', { project: 'raw', what_why: 'Why.', status: 'Start.', milestones: plan });
    const vault = h.openVault();
    const doc = vault.list({ scope: 'project:raw', type: 'working' })[0]!;
    vault.close();
    const r = await attempt(mcp, 'memory_edit', { id: doc.id, content: doc.content.replace('Start.', 's'.repeat(5000)) });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('status is 5000 characters');
    const same = await attempt(mcp, 'memory_edit', { id: doc.id, content: doc.content.replace('Why.', 'Why, edited.') });
    expect(same.isError).toBe(false);
  });

  it('refuses a long status on update but not an update that leaves status alone', async () => {
    h = createHarness();
    const mcp = await h.connect();
    await attempt(mcp, 'project_create', { project: 'p', what_why: 'Why.', status: 'Start.', milestones: plan });
    const head = JSON.parse(text(await mcp.callTool({ name: 'project_resume', arguments: { project: 'p' } }))) as { revision: string };
    const long = await attempt(mcp, 'project_update', { project: 'p', expected_revision: head.revision, status: 'y'.repeat(1200) });
    expect(long.isError).toBe(true);
    const other = await attempt(mcp, 'project_update', { project: 'p', expected_revision: head.revision, next_actions: '- Next.' });
    expect(other.isError).toBe(false);
  });
});
