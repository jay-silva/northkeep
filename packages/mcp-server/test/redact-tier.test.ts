import { afterEach, describe, expect, it } from 'vitest';
import { contentWriteRefusal } from '../src/return-mask.js';
import { createHarness, logRows, text, type Harness } from './harness-0060.js';

/**
 * ADR 0060 Decision 2 (D4): NORTHKEEP_REDACT_TIER=2 or 3 used to mean no
 * masking at all. Every tier of 1 or more now masks at least Tier 1; 2 and 3
 * run their layers or refuse loudly; a typo is refused; content writes stop.
 */

let h: Harness;
afterEach(async () => { await h.close(); });

const SEED = 'Zyler Okonkwo emails zyler@example.com, born 03/15/1948, visit on 10/03/2026.';

function seedMemory(scope = 'personal'): string {
  const vault = h.openVault();
  const e = vault.remember({ content: SEED, type: 'semantic', scope });
  vault.save();
  vault.close();
  return e.id;
}

function seedProject(slug = 'care'): void {
  const vault = h.openVault();
  vault.updateProject({
    project: slug, expected_revision: null, what_why: 'Care for Zyler Okonkwo.',
    status: 'Waiting on zyler@example.com.', next_actions: '- 2026-10-03 oncology follow-up for Zyler Okonkwo at 508-555-0142',
    writer: { host: 'test', host_version: null, session_id: '11111111-1111-4111-8111-111111111111' },
  });
  vault.save();
  vault.close();
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const mcp = await h.connect();
  return mcp.callTool({ name, arguments: args });
}

describe('ADR 0060 D4: return tiers over MCP', () => {
  it('C9: Tier 2 masks names and secrets in returned content', async () => {
    h = createHarness();
    seedMemory();
    process.env.NORTHKEEP_REDACT_TIER = '2';
    const r = await call('memory_list');
    const out = text(r);
    expect(r.isError).toBeFalsy();
    expect(out).not.toContain('Zyler');
    expect(out).not.toContain('zyler@example.com');
    expect(out).toMatch(/Person-\d/);
    expect(logRows(h.home).at(-1)).toMatchObject({ tool: 'memory_list', phase: 'done', ok: true, redaction_tier: 2 });
  });

  it('C9: Tier 3 also reduces dates to the year', async () => {
    h = createHarness();
    seedMemory();
    process.env.NORTHKEEP_REDACT_TIER = '3';
    const out = text(await call('memory_list'));
    expect(out).not.toMatch(/03\/15\/1948|10\/03\/2026|Zyler|zyler@/);
    expect(out).toContain('[DATE-1948]');
  });

  it('C9b: at Tier 3 no leaf outside the handle fields in any read tool carries a month and day', async () => {
    h = createHarness();
    const id = seedMemory('visit:2026-10-03');
    seedProject('care-2026-10-03');
    process.env.NORTHKEEP_REDACT_TIER = '3';
    const MONTH_DAY = /\b\d{4}-\d{2}-\d{2}|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\bT\d{2}:\d{2}/;
    const HANDLES = new Set(['scope', 'project', 'slug', 'disclosed_scopes', 'granted_scopes']);
    const offenders: string[] = [];
    const walk = (value: unknown, where: string, key?: string): void => {
      if (typeof value === 'string') {
        if (!(key && HANDLES.has(key)) && MONTH_DAY.test(value)) offenders.push(`${where}: ${value}`);
      } else if (Array.isArray(value)) {
        value.forEach((v, i) => walk(v, `${where}[${i}]`, key && HANDLES.has(key) ? key : undefined));
      } else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) walk(v, `${where}.${k}`, k);
      }
    };
    const calls: Array<[string, Record<string, unknown>]> = [
      ['memory_list', {}], ['memory_retrieve', { query: 'Zyler' }], ['project_list', {}], ['project_board', {}],
      ['project_get', { project: 'care-2026-10-03', history: true }], ['project_resume', { project: 'care-2026-10-03', history: true }],
      ['memory_edit', { id, type: 'episodic' }],
    ];
    const seen = { scope: false, board_date: false };
    for (const [name, args] of calls) {
      const r = await call(name, args);
      expect(r.isError, name).toBeFalsy();
      const payload = JSON.parse(text(r)) as Record<string, unknown>;
      walk(payload, name);
      const flat = JSON.stringify(payload);
      if (flat.includes('"visit:2026-10-03"') || flat.includes('"project:care-2026-10-03"')) seen.scope = true;
      if (name === 'project_board') {
        const dated = (payload.dated as { rows: Array<{ date: string }> }).rows;
        expect(dated[0]!.date).toBe('2026');
        seen.board_date = true;
      }
    }
    expect(offenders).toEqual([]);
    // Handles stay exact (residual R12): the host has to send them back.
    expect(seen).toEqual({ scope: true, board_date: true });
  });

  it('C35 (MCP): Tier 2 masks a name after character 6,000 of a long memory', async () => {
    h = createHarness();
    let filler = '';
    while (filler.length < 6100) filler += 'notes from the visit, nothing unusual. ';
    const vault = h.openVault();
    vault.remember({ content: `${filler.slice(0, 6100)} Quennell Abernathy-Vos has the results.`, type: 'semantic', scope: 'personal' });
    vault.save();
    vault.close();
    process.env.NORTHKEEP_REDACT_TIER = '2';
    const r = await call('memory_list');
    expect(r.isError).toBeFalsy();
    expect(text(r)).not.toContain('Quennell');
  });

  it('C10: Tier 2 with the name model offline returns an error and no content', async () => {
    h = createHarness({ ner: 'offline' });
    seedMemory();
    process.env.NORTHKEEP_REDACT_TIER = '2';
    const r = await call('memory_list');
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^Name masking failed \(NORTHKEEP_REDACT_TIER=2\); nothing was returned\./);
    expect(text(r)).not.toContain('zyler');
    expect(logRows(h.home).at(-1)).toMatchObject({ phase: 'done', ok: false, error: 'tier2-unavailable' });
  });

  it('C10: Tier 3 with the name model offline returns masked content with a note', async () => {
    h = createHarness({ ner: 'offline' });
    seedMemory();
    process.env.NORTHKEEP_REDACT_TIER = '3';
    const r = await call('memory_list');
    const payload = JSON.parse(text(r)) as { redaction_note?: string; memories: Array<{ content: string; created_at: string }> };
    expect(payload.redaction_note).toMatch(/^Tier 3 ran without the name model/);
    expect(payload.memories[0]!.content).not.toMatch(/zyler@|03\/15\/1948/);
    expect(payload.memories[0]!.created_at).toMatch(/^\d{4}$/);
    expect(logRows(h.home).at(-1)).toMatchObject({ ok: true, redaction_tier: 3, redaction_degraded: true });
  });

  it('C25: one field whose name call fails twice refuses the whole call; no ok row for it', async () => {
    h = createHarness({ ner: (t) => (t.includes('second memory') ? 'fail' : 'ok') });
    seedMemory();
    const vault = h.openVault();
    vault.remember({ content: 'The second memory mentions Quennell Abernathy-Vos.', type: 'semantic', scope: 'personal' });
    vault.save();
    vault.close();
    process.env.NORTHKEEP_REDACT_TIER = '2';
    const r = await call('memory_list');
    expect(r.isError).toBe(true);
    expect(text(r)).not.toMatch(/Zyler|Quennell/);
    const rows = logRows(h.home).filter((row) => row.tool === 'memory_list');
    const callId = rows.at(-1)!.call_id;
    expect(rows.filter((row) => row.call_id === callId).map((row) => [row.phase, row.ok])).toEqual([['pending', false], ['done', false]]);
    // The first memory succeeded on its own call; the failing one was retried.
    expect(h.nerCalls()).toBeGreaterThanOrEqual(3);
  });

  it('C11: project writes and content edits are refused at Tiers 1, 2 and 3; type-only edits work', async () => {
    h = createHarness();
    let id = seedMemory();
    const types = { '1': 'episodic', '2': 'procedural', '3': 'semantic' } as const;
    for (const tier of ['1', '2', '3'] as const) {
      process.env.NORTHKEEP_REDACT_TIER = tier;
      const create = await call('project_create', { project: `p${tier}`, what_why: 'w', status: 's' });
      expect(create.isError, tier).toBe(true);
      expect(text(create)).toContain(contentWriteRefusal(Number(tier) as 1 | 2 | 3));
      expect(JSON.parse(text(create)).error.code, tier).toBe('invalid_request');
      const edit = await call('memory_edit', { id, content: 'Person-1 moved.' });
      expect(edit.isError, tier).toBe(true);
      expect(text(edit)).toContain(contentWriteRefusal(Number(tier) as 1 | 2 | 3));
      const typeOnly = await call('memory_edit', { id, type: types[tier] });
      expect(typeOnly.isError, `${tier}: ${text(typeOnly)}`).toBeFalsy();
      id = (JSON.parse(text(typeOnly)) as { edited: { id: string } }).edited.id;
    }
    const vault = h.openVault();
    expect(vault.list().find((e) => e.id === id)!.content).toBe(SEED);
    vault.close();
  });

  it('C26: memory_remember is refused at Tiers 2 and 3 and allowed at Tier 1', async () => {
    h = createHarness();
    for (const tier of ['2', '3'] as const) {
      process.env.NORTHKEEP_REDACT_TIER = tier;
      const r = await call('memory_remember', { content: 'Person-3 moved to Boston.', type: 'semantic' });
      expect(r.isError, tier).toBe(true);
      expect(text(r)).toContain(`Saving text is disabled while NORTHKEEP_REDACT_TIER=${tier}`);
    }
    process.env.NORTHKEEP_REDACT_TIER = '1';
    const ok = await call('memory_remember', { content: 'I moved to Boston.', type: 'semantic' });
    expect(ok.isError).toBeFalsy();
    const vault = h.openVault();
    expect(vault.list().map((e) => e.content)).toEqual(['I moved to Boston.']);
    vault.close();
  });

  it('C12: an invalid tier value is refused, naming it, and never read as 0', async () => {
    h = createHarness();
    seedMemory();
    process.env.NORTHKEEP_REDACT_TIER = 'yes';
    const r = await call('memory_list');
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('NORTHKEEP_REDACT_TIER=yes is not 0, 1, 2 or 3; nothing was done.');
    expect(logRows(h.home).at(-1)).toMatchObject({ ok: false, error: 'invalid_tier' });
  });
});
