import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, generateDeviceSecret } from '../src/crypto.js';
import { PROJECT_PROVENANCE_METADATA_KEY, readProjectProvenance } from '../src/project-handoff.js';
import type { MemoryEntry } from '../src/types.js';
import { Vault } from '../src/vault.js';

const PASS = 'synthetic project compaction passphrase';
let directory: string, vaultPath: string, secret: Buffer;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-compact-'));
  vaultPath = path.join(directory, 'vault.nkv');
  secret = generateDeviceSecret();
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

function vault(): Vault {
  return Vault.create({ path: vaultPath, passphrase: PASS, deviceSecret: secret, kdf: KDF_INTERACTIVE });
}

/** Seeds a project and revises it `revisions` times, each body `size` characters. */
function seedProject(v: Vault, project: string, revisions: number, size = 64): string {
  let revision = v.updateProject({ project, expected_revision: null, what_why: 'Why.', status: 'x'.repeat(size), next_actions: '- [ ] Begin' }).revision;
  for (let i = 0; i < revisions; i += 1) {
    revision = v.updateProject({ project, expected_revision: revision, status: `${i} `.padEnd(size, 'y') }).revision;
  }
  return revision;
}

function liveRevisions(v: Vault, project: string): string[] {
  return v.list({ scope: `project:${project}`, includeSuperseded: true })
    .filter((e) => e.type === 'working' && e.superseded_at !== null)
    .map((e) => e.id);
}

describe('compactProjectHistory', () => {
  it('keeps the newest kept superseded revisions and blanks the rest', () => {
    const v = vault();
    seedProject(v, 'demo', 12);
    const before = liveRevisions(v, 'demo');
    expect(before).toHaveLength(5); // automatic compaction already bounded it
    const result = v.compactProjectHistory({ keep: 2 });
    expect(result.projects).toEqual([{ project: 'demo', candidates: 5, kept: 2, blanked: 3, bytes_freed: expect.any(Number) }]);
    expect(result.blanked).toBe(3);
    expect(result.bytes_freed).toBeGreaterThan(0);
    const after = liveRevisions(v, 'demo');
    expect(after).toEqual(before.slice(3));
    const blanked = v.list({ scope: 'project:demo', includeSuperseded: true, includeForgotten: true }).filter((e) => e.forgotten_at !== null);
    expect(blanked).toHaveLength(10); // seven blanked automatically, three by hand
    for (const entry of blanked) expect(entry.content).toBe('');
    expect(v.verifyChain().ok).toBe(true);
    v.close();
  });

  it('honours keep, rejects an out-of-range keep and an invalid slug', () => {
    const v = vault();
    seedProject(v, 'demo', 8);
    expect(v.compactProjectHistory({ keep: 1, dryRun: true }).blanked).toBe(4);
    for (const keep of [0, -1, 1001, 2.5]) expect(() => v.compactProjectHistory({ keep })).toThrow(Error);
    expect(() => v.compactProjectHistory({ project: 'Not A Slug' })).toThrow(Error);
    expect(v.compactProjectHistory({ project: 'never-used', dryRun: true }).projects).toEqual([
      { project: 'never-used', candidates: 0, kept: 0, blanked: 0, bytes_freed: 0 },
    ]);
    v.close();
  });

  it('keeps revisions a surviving receipt names, and an old receipt protects nothing', () => {
    const v = vault();
    let revision = seedProject(v, 'demo', 2);
    const receipt = v.checkpointProject({
      vault_id: v.getVaultId(), project: 'demo', mode: 'checkpoint',
      operation_id: '11111111-1111-4111-8111-111111111111', expected_revision: revision,
      status: 'Ready.', completed: 'Built the core.', next_actions: 'Next.',
    }).receipt;
    revision = v.updateProject({ project: 'demo', expected_revision: receipt.result_revision, status: 'Later.' }).revision;
    const first = v.compactProjectHistory({ keep: 1 });
    expect(first.projects[0]!.kept).toBe(2); // the kept result, plus the base its receipt names
    expect(liveRevisions(v, 'demo')).toEqual(expect.arrayContaining([receipt.base_revision, receipt.result_revision]));

    for (let i = 0; i < 10; i += 1) revision = v.updateProject({ project: 'demo', expected_revision: revision, status: `Later ${i}.` }).revision;
    const second = v.compactProjectHistory({ keep: 1 });
    expect(second.projects[0]!.kept).toBe(1); // the receipt sits on a blanked row now, so it keeps nothing
    const survivors = liveRevisions(v, 'demo');
    expect(survivors).not.toContain(receipt.base_revision);
    expect(survivors).not.toContain(receipt.result_revision);
    expect(v.verifyChain().ok).toBe(true);
    v.close();
  });

  it('leaves live rows, log archives, episodic notes, other scopes and forgotten rows alone', () => {
    const v = vault();
    const live = seedProject(v, 'demo', 7);
    const note = v.remember({ type: 'episodic', scope: 'project:demo', content: 'A note in the project scope.' });
    const personal = v.remember({ type: 'semantic', scope: 'personal', content: 'Unrelated memory.' });
    const oldest = liveRevisions(v, 'demo')[0]!;
    v.forget(oldest);
    const before = v.export().memories.filter((m) => m.id !== oldest);

    const result = v.compactProjectHistory({ keep: 2 });
    expect(result.blanked).toBe(2); // five superseded survive automatic compaction, one was forgotten

    const after = new Map(v.export().memories.map((m) => [m.id, m]));
    expect(after.get(live)!.content.length).toBeGreaterThan(0);
    expect(after.get(note.id)!.content).toBe(note.content);
    expect(after.get(personal.id)!.content).toBe(personal.content);
    const archives = v.list({ scope: 'project:demo', includeSuperseded: true }).filter((e) => e.source === 'northkeep:project-log-archive');
    for (const archive of archives) expect(archive.content.length).toBeGreaterThan(0);
    const untouched = before.filter((m) => after.get(m.id)!.content === m.content);
    expect(untouched).toHaveLength(before.length - 2);
    expect(v.verifyChain().ok).toBe(true);
    v.close();
  });

  it('changes nothing on a dry run', () => {
    const v = vault();
    seedProject(v, 'demo', 9);
    const before = v.export();
    const dry = v.compactProjectHistory({ dryRun: true, keep: 1 });
    expect(dry.blanked).toBe(4);
    expect(dry.bytes_freed).toBeGreaterThan(0);
    const after = v.export();
    expect(after.memories).toEqual(before.memories);
    expect(after.northkeep_export.chain_head).toBe(before.northkeep_export.chain_head);
    v.close();
  });

  it('exports the blanked revisions as forgotten and reopens clean', () => {
    const v = vault();
    const body = 'z'.repeat(10 * 1024);
    let revision = v.updateProject({ project: 'demo', expected_revision: null, what_why: 'Why.', status: body, next_actions: 'Go' }).revision;
    for (let i = 0; i < 20; i += 1) revision = v.updateProject({ project: 'demo', expected_revision: revision, status: `${i} ${body}` }).revision;

    const result = v.compactProjectHistory({ keep: 1 });
    expect(result.blanked).toBe(4);
    v.save();

    const exported = v.export().memories;
    const forgotten = exported.filter((m) => m.validity.forgotten_at !== null);
    expect(forgotten).toHaveLength(19); // fifteen automatic, four by hand
    for (const entry of forgotten) {
      expect(entry.content).toBe('');
      expect(entry.metadata).toBeNull();
      expect(entry.provenance.entry_hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(v.verifyChain().ok).toBe(true);
    v.close();

    const reopened = Vault.open({ path: vaultPath, passphrase: PASS, deviceSecret: secret, kdf: KDF_INTERACTIVE });
    expect(reopened.verifyChain().ok).toBe(true);
    expect(reopened.list({ scope: 'project:demo' }).filter((e) => e.type === 'working')).toHaveLength(1);
    reopened.close();
  });

  it('refuses to compact a vault whose chain is already broken, without mutating it', () => {
    const v = vault();
    seedProject(v, 'demo', 9);
    const victim = liveRevisions(v, 'demo')[0]!;
    const db = (v as unknown as { db: import('better-sqlite3').Database }).db;
    db.prepare('UPDATE memories SET content = ? WHERE id = ?').run('Tampered without rehashing.', victim);
    const before = v.export();
    expect(() => v.compactProjectHistory({ keep: 1 })).toThrow(/chain does not verify/);
    expect(v.export().memories).toEqual(before.memories);
    v.close();
  });

  it('compacts only the named project', () => {
    const v = vault();
    seedProject(v, 'alpha', 8);
    seedProject(v, 'beta', 8);
    const result = v.compactProjectHistory({ project: 'alpha', keep: 1 });
    expect(result.blanked).toBe(4);
    expect(result.projects.map((p) => p.project)).toEqual(['alpha']);
    expect(v.list({ scope: 'project:beta', includeSuperseded: true }).filter((e) => e.type === 'working' && e.superseded_at)).toHaveLength(5);
    expect(v.verifyChain().ok).toBe(true);
    v.close();
  });
});

/** Superseded working revisions in a scope that still hold their content. */
function survivingRevisions(v: Vault, scope: string): string[] {
  return v.list({ scope, includeSuperseded: true })
    .filter((e) => e.type === 'working' && e.superseded_at !== null && e.content.length > 0)
    .map((e) => e.id);
}

describe('automatic compaction (ADR 0051 Decision 4)', () => {
  it('leaves five superseded revisions with content after twenty updates, and forgets the rest', () => {
    const v = vault();
    let revision = v.updateProject({ project: 'demo', expected_revision: null, what_why: 'Why.', status: 'Start.', next_actions: 'Go' }).revision;
    const superseded: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      superseded.push(revision);
      revision = v.updateProject({ project: 'demo', expected_revision: revision, status: `Revision ${i}.` }).revision;
    }
    expect(survivingRevisions(v, 'project:demo')).toEqual(superseded.slice(-5));
    const rows = v.list({ scope: 'project:demo', includeSuperseded: true, includeForgotten: true })
      .filter((e) => e.type === 'working' && e.superseded_at !== null);
    expect(rows).toHaveLength(20);
    const forgotten = rows.filter((e) => e.forgotten_at !== null);
    expect(forgotten).toHaveLength(15);
    for (const row of forgotten) expect(row.content).toBe('');
    expect(v.list({ scope: 'project:demo' }).filter((e) => e.type === 'working' && !e.superseded_at)).toHaveLength(1);
    expect(v.verifyChain().ok).toBe(true);
    v.close();
  });

  it('stays bounded when every save is a checkpoint or wrap (receipts do not chain)', () => {
    const v = vault();
    let revision = seedProject(v, 'demo', 0);
    for (let i = 0; i < 20; i += 1) {
      revision = v.checkpointProject({
        vault_id: v.getVaultId(), project: 'demo', mode: i % 2 ? 'wrap' : 'checkpoint',
        operation_id: `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`, expected_revision: revision,
        status: `Status ${i}.`, completed: `Did ${i}.`, next_actions: `Next ${i}.`,
      }).receipt.result_revision;
    }
    // The newest five, plus the base the fifth one's receipt names (a memory
    // edit copies a receipt forward, which can add one more). Before the fix
    // every one of the twenty kept its text, because each receipt protected a
    // row whose own receipt protected the next.
    expect(survivingRevisions(v, 'project:demo')).toHaveLength(6);
    expect(v.compactProjectHistory({ project: 'demo' }).blanked).toBe(0);
    expect(v.verifyChain().ok).toBe(true);
    v.close();
  });

  it('answers every verbatim retry after compaction with a replay or a stale refusal, never a mismatch', () => {
    const v = vault();
    let revision = seedProject(v, 'demo', 0);
    const requests = [];
    for (let i = 0; i < 20; i += 1) {
      const request = {
        vault_id: v.getVaultId(), project: 'demo', mode: (i % 2 ? 'wrap' : 'checkpoint') as 'wrap' | 'checkpoint',
        operation_id: `44444444-4444-4444-8444-${String(i).padStart(12, '0')}`, expected_revision: revision,
        status: `Status ${i}.`, completed: `Did ${i}.`, next_actions: `Next ${i}.`,
      };
      requests.push(request);
      revision = v.checkpointProject(request).receipt.result_revision;
    }
    const head = () => v.list({ scope: 'project:demo' }).filter((e) => e.type === 'working').map((e) => e.id);
    const before = head();
    const outcomes: string[] = [];
    for (const request of requests) {
      try {
        outcomes.push(v.checkpointProject(request).replayed ? 'replayed' : 'written');
      } catch (error) {
        outcomes.push((error as { code?: string }).code ?? 'error');
      }
      expect(head()).toEqual(before);
    }
    expect(outcomes).not.toContain('written');
    expect(outcomes).not.toContain('operation_conflict');
    expect(outcomes.filter((o) => o === 'replayed').length).toBeGreaterThanOrEqual(5);
    expect(new Set(outcomes)).toEqual(new Set(['stale_project', 'replayed']));
    v.close();
  });

  it('keeps a recent checkpoint replayable, and refuses a retry once its revision is blanked', () => {
    const v = vault();
    const request = {
      vault_id: '', project: 'demo', mode: 'checkpoint' as const,
      operation_id: '22222222-2222-4222-8222-222222222222', expected_revision: '',
      status: 'Ready.', completed: 'Built the core.', next_actions: 'Next.',
    };
    request.vault_id = v.getVaultId();
    request.expected_revision = seedProject(v, 'demo', 3);
    const receipt = v.checkpointProject(request).receipt;
    let revision = receipt.result_revision;
    for (let i = 0; i < 2; i += 1) revision = v.updateProject({ project: 'demo', expected_revision: revision, status: `Soon ${i}.` }).revision;
    const recent = v.checkpointProject(request);
    expect(recent.replayed).toBe(true);
    expect(recent.receipt).toEqual(receipt);

    for (let i = 0; i < 20; i += 1) revision = v.updateProject({ project: 'demo', expected_revision: revision, status: `Later ${i}.` }).revision;
    const surviving = survivingRevisions(v, 'project:demo');
    expect(surviving).toHaveLength(5);
    expect(surviving).not.toContain(receipt.result_revision);
    const head = v.list({ scope: 'project:demo' }).filter((e) => e.type === 'working').map((e) => e.id);
    expect(() => v.checkpointProject(request)).toThrow(expect.objectContaining({ code: 'stale_project' }));
    expect(v.list({ scope: 'project:demo' }).filter((e) => e.type === 'working').map((e) => e.id)).toEqual(head);
    expect(v.verifyChain().ok).toBe(true);
    v.close();
  });

  it('never blanks anything when the superseded row is outside a project scope', () => {
    const v = vault();
    const note = v.remember({ type: 'working', scope: 'personal', content: 'Draft 0.' });
    let id = note.id;
    for (let i = 0; i < 20; i += 1) id = v.editMemory(id, { content: `Draft ${i + 1}.` }).id;
    const rows = v.list({ scope: 'personal', includeSuperseded: true, includeForgotten: true });
    expect(rows.filter((e) => e.forgotten_at !== null)).toHaveLength(0);
    expect(rows.filter((e) => e.superseded_at !== null && e.content.length > 0)).toHaveLength(20);
    expect(v.lastAutoCompaction()).toBeNull();
    expect(v.verifyChain().ok).toBe(true);
    v.close();
  });

  it('compacts a project document superseded through editMemory, the path the fold uses', () => {
    const v = vault();
    const head = v.remember({ type: 'working', scope: 'project:demo', content: '## Current Status\n\nFolded 0.' });
    let id = head.id;
    for (let i = 0; i < 20; i += 1) id = v.editMemory(id, { content: `## Current Status\n\nFolded ${i + 1}.` }).id;
    expect(survivingRevisions(v, 'project:demo')).toHaveLength(5);
    expect(v.lastAutoCompaction()).toEqual({ project: 'demo', blanked: 1, bytes_freed: expect.any(Number) });
    expect(v.verifyChain().ok).toBe(true);
    v.close();
  });

  it('reports the last automatic compaction and clears it on a write that blanked nothing', () => {
    const v = vault();
    let revision = v.updateProject({ project: 'demo', expected_revision: null, what_why: 'Why.', status: 'Start.', next_actions: 'Go' }).revision;
    for (let i = 0; i < 5; i += 1) revision = v.updateProject({ project: 'demo', expected_revision: revision, status: `Revision ${i}.` }).revision;
    expect(v.lastAutoCompaction()).toBeNull(); // five superseded revisions, nothing past the keep

    revision = v.updateProject({ project: 'demo', expected_revision: revision, status: 'Sixth.' }).revision;
    const report = v.lastAutoCompaction();
    expect(report).toEqual({ project: 'demo', blanked: 1, bytes_freed: expect.any(Number) });
    expect(report!.bytes_freed).toBeGreaterThan(0);

    v.updateProject({ project: 'other', expected_revision: null, what_why: 'Why.', status: 'Start.', next_actions: 'Go' });
    expect(v.lastAutoCompaction()).toBeNull(); // a creation supersedes nothing
    v.close();
  });

  it('reports nothing and keeps every row when the write it rode in on rolls back', () => {
    const v = vault();
    const revision = seedProject(v, 'demo', 8);
    const before = survivingRevisions(v, 'project:demo');
    expect(before).toHaveLength(5);

    // The blanking runs inside the supersession transaction, so a failure after
    // it must undo both. Injected at setMeta, the last step of the write.
    const internals = v as unknown as { setMeta: (key: string, value: string) => void };
    const original = internals.setMeta.bind(internals);
    internals.setMeta = (key, value) => { throw new Error(`injected failure at ${key}=${value.slice(0, 8)}`); };
    expect(() => v.updateProject({ project: 'demo', expected_revision: revision, status: 'Doomed.' })).toThrow(/injected failure/);
    internals.setMeta = original;

    expect(survivingRevisions(v, 'project:demo')).toEqual(before);
    expect(v.lastAutoCompaction()).toBeNull();
    expect(v.verifyChain().ok).toBe(true);
    v.close();
  });

  it('keeps the saved file flat: twenty 10 KB updates weigh about what six do', () => {
    const body = 'z'.repeat(10 * 1024);
    const sizeAfter = (updates: number, name: string): number => {
      const file = path.join(directory, `${name}.nkv`);
      const v = Vault.create({ path: file, passphrase: PASS, deviceSecret: secret, kdf: KDF_INTERACTIVE });
      let revision = v.updateProject({ project: 'demo', expected_revision: null, what_why: 'Why.', status: body, next_actions: 'Go' }).revision;
      for (let i = 0; i < updates; i += 1) revision = v.updateProject({ project: 'demo', expected_revision: revision, status: `${i} ${body}` }).revision;
      expect(v.verifyChain().ok).toBe(true);
      v.save();
      v.close();
      return fs.statSync(file).size;
    };
    const six = sizeAfter(6, 'six');
    const twenty = sizeAfter(20, 'twenty');
    console.log(`bounded history: 6 updates = ${six} bytes, 20 updates = ${twenty} bytes (${(twenty / six).toFixed(2)}x)`);
    expect(twenty / six).toBeLessThan(1.5);
  });
});

describe('compaction keeps the writer block (ADR 0051 addendum, ADR 0052)', () => {
  const WRITER = { host: 'claude-code', host_version: '0.24.0', session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };

  /** Every row of this project, blanked ones included. */
  function rows(v: Vault): MemoryEntry[] {
    return v.list({ scope: 'project:demo', includeSuperseded: true, includeForgotten: true })
      .filter((e) => e.type === 'working');
  }
  function blanked(v: Vault): MemoryEntry[] {
    return rows(v).filter((e) => e.forgotten_at !== null);
  }
  function seedWithWriter(v: Vault, revisions: number, size = 64): string {
    let revision = v.updateProject({ project: 'demo', expected_revision: null, what_why: 'Why.', status: 'x'.repeat(size), next_actions: '- [ ] Begin', writer: WRITER }).revision;
    for (let i = 0; i < revisions; i += 1) {
      revision = v.updateProject({ project: 'demo', expected_revision: revision, status: `${i} `.padEnd(size, 'y'), writer: WRITER }).revision;
    }
    return revision;
  }

  it('answers with the original host and session after automatic and manual compaction', () => {
    const v = vault();
    seedWithWriter(v, 12);
    const automatic = blanked(v);
    expect(automatic.length).toBeGreaterThan(0);
    v.compactProjectHistory({ keep: 1 });
    const all = blanked(v);
    expect(all.length).toBeGreaterThan(automatic.length);
    for (const row of all) {
      expect(row.content).toBe('');
      expect(Object.keys(row.metadata!)).toEqual([PROJECT_PROVENANCE_METADATA_KEY]);
      expect(readProjectProvenance(row)).toMatchObject({ host: 'claude-code', host_version: '0.24.0', model: null, session_id: WRITER.session_id });
    }
    expect(v.verifyChain().ok).toBe(true);
    v.close();
  });

  it('survives a save, an export and a reopen', () => {
    const v = vault();
    seedWithWriter(v, 12);
    v.compactProjectHistory({ keep: 1 });
    v.save();
    const exported = v.export().memories.filter((m) => m.validity.forgotten_at !== null);
    expect(exported.length).toBeGreaterThan(0);
    for (const entry of exported) expect(Object.keys(entry.metadata!)).toEqual([PROJECT_PROVENANCE_METADATA_KEY]);
    v.close();
    const reopened = Vault.open({ path: vaultPath, passphrase: PASS, deviceSecret: secret, kdf: KDF_INTERACTIVE });
    expect(reopened.verifyChain().ok).toBe(true);
    const kept = reopened.list({ scope: 'project:demo', includeSuperseded: true, includeForgotten: true }).filter((e) => e.forgotten_at !== null);
    for (const row of kept) expect(readProjectProvenance(row)?.session_id).toBe(WRITER.session_id);
    reopened.close();
  });

  it('leaves a revision written without a writer with null metadata', () => {
    const v = vault();
    seedProject(v, 'demo', 12);
    for (const row of blanked(v)) expect(row.metadata).toBeNull();
    expect(v.verifyChain().ok).toBe(true);
    v.close();
  });

  it('strips every key but the writer block, and counts only content in bytes_freed', () => {
    const v = vault();
    let revision = seedWithWriter(v, 5);
    const oldest = v.list({ scope: 'project:demo', includeSuperseded: true })
      .filter((e) => e.type === 'working' && e.superseded_at !== null)[0]!;
    // Raw SQL: no supported write leaves a receipt on a compactable revision,
    // because a receipt names its own row and receiptReferences then keeps it.
    const db = (v as unknown as { db: import('better-sqlite3').Database }).db;
    const planted = { ...oldest.metadata, leftover: { note: 'should not survive' } };
    db.prepare('UPDATE memories SET metadata = ? WHERE id = ?').run(JSON.stringify(planted), oldest.id);
    // One more write pushes that row past the automatic keep of five.
    revision = v.updateProject({ project: 'demo', expected_revision: revision, status: 'One more.', writer: WRITER }).revision;
    const after = rows(v).find((e) => e.id === oldest.id)!;
    expect(after.forgotten_at).not.toBeNull();
    expect(Object.keys(after.metadata!)).toEqual([PROJECT_PROVENANCE_METADATA_KEY]);
    expect(v.verifyChain().ok).toBe(true);

    const doomed = v.list({ scope: 'project:demo', includeSuperseded: true })
      .filter((e) => e.type === 'working' && e.superseded_at !== null).slice(0, 3);
    const contentBytes = doomed.reduce((sum, e) => sum + Buffer.byteLength(e.content, 'utf8'), 0);
    const result = v.compactProjectHistory({ keep: 2 });
    expect(result.blanked).toBe(3);
    expect(result.bytes_freed).toBe(contentBytes);
    v.close();
  });

  it('fails verification when a blanked row carries anything but a well-formed writer block', () => {
    const v = vault();
    seedWithWriter(v, 12);
    const victim = blanked(v)[0]!;
    const db = (v as unknown as { db: import('better-sqlite3').Database }).db;
    const write = (metadata: unknown): void => {
      db.prepare('UPDATE memories SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), victim.id);
    };
    const block = victim.metadata![PROJECT_PROVENANCE_METADATA_KEY];
    for (const tampered of [
      { [PROJECT_PROVENANCE_METADATA_KEY]: block, smuggled: 'extra' },
      { smuggled: 'extra' },
      { [PROJECT_PROVENANCE_METADATA_KEY]: { ...(block as Record<string, unknown>), host: 42 } },
      { [PROJECT_PROVENANCE_METADATA_KEY]: { ...(block as Record<string, unknown>), model: 'claude' } },
      { [PROJECT_PROVENANCE_METADATA_KEY]: { ...(block as Record<string, unknown>), extra: true } },
      { [PROJECT_PROVENANCE_METADATA_KEY]: 'not an object' },
    ]) {
      write(tampered);
      const checked = v.verifyChain();
      expect(checked.ok, JSON.stringify(tampered)).toBe(false);
      expect(checked.error).toContain('metadata beyond its writer block');
    }
    write({ [PROJECT_PROVENANCE_METADATA_KEY]: block });
    expect(v.verifyChain().ok).toBe(true);
    v.close();
  });
});

describe('operation ids survive compaction (ADR 0062)', () => {
  const LEDGER = 'northkeep_operations_v1';
  const DIFFERENT = 'Operation id was already used for a different project request.';
  const COMPACTED = 'This save was already applied and has since been compacted, so it cannot be replayed. Read the project again; send any new save with a new operation id.';
  const BASE_COMPACTED = 'This save was already applied, and the version it started from has since been compacted, so it cannot be replayed. Read the project again; send any new save with a new operation id.';
  const MALFORMED = 'Malformed project operation record.';
  const X = '0062aaaa-0000-4000-8000-00000000000a';
  const Z = '0062aaaa-0000-4000-8000-00000000000b';
  const DOC = '## What & Why\nW.\n\n## Current Status\nS.\n\n## Next Actions\n- [ ] N\n\n## Decisions\n\n## Log\n\n## Open Questions\n\n## Files\n';

  type Outcome = 'written' | 'replayed' | { code: string; message: string; current: boolean };
  function attempt(run: () => { replayed: boolean }): Outcome {
    try {
      return run().replayed ? 'replayed' : 'written';
    } catch (error) {
      const e = error as { code?: string; message: string; current?: unknown };
      return { code: e.code ?? 'error', message: e.message, current: e.current !== undefined };
    }
  }
  function request(v: Vault, project: string, operation_id: string, expected_revision: string, completed = 'Did X.') {
    return {
      vault_id: v.getVaultId(), project, mode: 'checkpoint' as const, operation_id, expected_revision,
      status: `Status from ${operation_id.slice(-4)}.`, completed, next_actions: `- [ ] Next from ${operation_id.slice(-4)}`,
    };
  }
  function head(v: Vault, project: string): MemoryEntry {
    const heads = v.list({ scope: `project:${project}` }).filter((e) => e.type === 'working');
    expect(heads).toHaveLength(1);
    return heads[0]!;
  }
  function ledgerIds(entry: MemoryEntry): string[] {
    const ledger = entry.metadata?.[LEDGER];
    return Array.isArray(ledger) ? ledger.map((r) => (r as { operation_id: string }).operation_id) : [];
  }
  function didCount(v: Vault, project: string, line: string): number {
    return head(v, project).content.split(line).length - 1;
  }
  function isBlanked(v: Vault, id: string): boolean {
    return v.list({ includeSuperseded: true, includeForgotten: true }).find((e) => e.id === id)!.forgotten_at !== null;
  }
  function updates(v: Vault, project: string, count: number): void {
    for (let i = 0; i < count; i += 1) v.updateProject({ project, expected_revision: head(v, project).id, status: `Newer status ${i}.` });
  }
  function create(v: Vault, project: string): string {
    return v.updateProject({ project, expected_revision: null, what_why: 'Why.', status: 'Start.', next_actions: '- [ ] Begin' }).revision;
  }
  /** Checkpoint X on a fresh project, then twelve updates, which blank X's revision. */
  function compactedCheckpoint(v: Vault, project = 'demo') {
    const x = request(v, project, X, create(v, project));
    const result = v.checkpointProject(x).receipt.result_revision;
    updates(v, project, 12);
    expect(isBlanked(v, result)).toBe(true);
    return x;
  }

  it('T1: refuses an F1 resend of a blanked checkpoint at the current head and writes nothing', () => {
    const v = vault();
    compactedCheckpoint(v);
    const before = head(v, 'demo').id;
    expect(attempt(() => v.checkpointProject(request(v, 'demo', X, before)))).toEqual({ code: 'operation_conflict', message: DIFFERENT, current: false });
    expect(head(v, 'demo').id).toBe(before);
    expect(didCount(v, 'demo', 'Did X.')).toBe(1);
    expect(v.verifyChain().ok).toBe(true);
    v.close();
  });

  it('T2: a verbatim retry after blanking answers stale_project, with a message for the blanked save and another for a blanked base', () => {
    const v = vault();
    const x = compactedCheckpoint(v);
    const before = head(v, 'demo').id;
    expect(attempt(() => v.checkpointProject(x))).toEqual({ code: 'stale_project', message: COMPACTED, current: true });
    expect(head(v, 'demo').id).toBe(before);

    const base = create(v, 'base');
    const xBase = request(v, 'base', X.replace('a', 'b'), base);
    const xResult = v.checkpointProject(xBase).receipt.result_revision;
    const zResult = v.checkpointProject(request(v, 'base', Z, xResult, 'Did Z.')).receipt.result_revision;
    v.updateProject({ project: 'base', expected_revision: zResult, status: 'One update.' });
    expect(v.compactProjectHistory({ project: 'base', keep: 1 }).blanked).toBe(1);
    expect(isBlanked(v, base)).toBe(true);
    expect(isBlanked(v, xResult)).toBe(false);
    expect(attempt(() => v.checkpointProject(xBase))).toEqual({ code: 'stale_project', message: BASE_COMPACTED, current: true });
    v.close();
  });

  it('T3: a verbatim retry of the newest save still replays its receipt', () => {
    const v = vault();
    const x = request(v, 'demo', X, create(v, 'demo'));
    const receipt = v.checkpointProject(x).receipt;
    const replay = v.checkpointProject(x);
    expect(replay.replayed).toBe(true);
    expect(replay.receipt).toEqual(receipt);
    v.close();
  });

  it('T4a: the carry-forward route with a ledger answers stale for a verbatim retry and a conflict for a changed request, also once the copy is blanked', () => {
    const v = vault();
    const x = request(v, 'demo', X, create(v, 'demo'));
    const xResult = v.checkpointProject(x).receipt.result_revision;
    const edited = v.editMemory(xResult, { content: `${head(v, 'demo').content}\nEdited by hand.` }).id;
    v.checkpointProject(request(v, 'demo', Z, edited, 'Did Z.'));
    updates(v, 'demo', 5);
    expect(isBlanked(v, xResult)).toBe(true);
    expect(isBlanked(v, edited)).toBe(false);
    const before = head(v, 'demo').id;
    expect(attempt(() => v.checkpointProject(x))).toEqual({ code: 'stale_project', message: COMPACTED, current: true });
    expect(attempt(() => v.checkpointProject(request(v, 'demo', X, before)))).toEqual({ code: 'operation_conflict', message: DIFFERENT, current: false });
    expect(ledgerIds(head(v, 'demo'))).toEqual([X, Z]);
    expect(head(v, 'demo').id).toBe(before);
    expect(didCount(v, 'demo', 'Did X.')).toBe(1);

    updates(v, 'demo', 1);
    expect(isBlanked(v, edited)).toBe(true);
    const later = head(v, 'demo').id;
    expect(attempt(() => v.checkpointProject(x))).toEqual({ code: 'stale_project', message: COMPACTED, current: true });
    expect(attempt(() => v.checkpointProject(request(v, 'demo', X, later)))).toEqual({ code: 'operation_conflict', message: DIFFERENT, current: false });
    expect(head(v, 'demo').id).toBe(later);
    expect(didCount(v, 'demo', 'Did X.')).toBe(1);
    v.close();
  });

  /** The v0.22.0-written fixture, copied to the temp dir, after five updates by this code: X's original blanked, its copy live. */
  function openFixture() {
    const fixtures = path.join(__dirname, 'fixtures');
    const spec = JSON.parse(fs.readFileSync(path.join(fixtures, 'v0220-carry-forward.json'), 'utf8')) as {
      passphrase: string; device_secret_hex: string; x_request: ReturnType<typeof request>; x_result: string; edited_revision: string;
    };
    fs.copyFileSync(path.join(fixtures, 'v0220-carry-forward.nkv'), vaultPath);
    const v = Vault.open({ path: vaultPath, passphrase: spec.passphrase, deviceSecret: Buffer.from(spec.device_secret_hex, 'hex') });
    expect(v.verifyChain().ok).toBe(true);
    updates(v, spec.x_request.project, 5);
    return { v, spec, project: spec.x_request.project };
  }

  it('T4b: the carry-forward route on a v0.22.0-written vault answers from the copied receipt alone', () => {
    const { v, spec, project } = openFixture();
    expect(isBlanked(v, spec.x_result)).toBe(true);
    expect(isBlanked(v, spec.edited_revision)).toBe(false);
    const all = v.list({ includeSuperseded: true, includeForgotten: true });
    expect(all.filter((e) => ledgerIds(e).includes(spec.x_request.operation_id))).toEqual([]);
    const before = head(v, project).id;
    expect(attempt(() => v.checkpointProject(spec.x_request))).toEqual({ code: 'stale_project', message: COMPACTED, current: true });
    expect(attempt(() => v.checkpointProject({ ...spec.x_request, expected_revision: before }))).toEqual({ code: 'operation_conflict', message: DIFFERENT, current: false });
    expect(head(v, project).id).toBe(before);
    expect(didCount(v, project, 'Did X.')).toBe(1);
    v.close();
  });

  it('T4c: a copied receipt proves nothing unless every copy sits in the project and its original was forgotten', () => {
    const RECEIPT = 'northkeep_project_handoff_v1';
    const plantCopy = (scope: string, retarget: (receipt: Record<string, unknown>, v: Vault) => Record<string, unknown>) => {
      const { v, spec, project } = openFixture();
      const copy = v.list({ scope: `project:${project}`, includeSuperseded: true }).find((e) => e.id === spec.edited_revision)!;
      const receipt = copy.metadata![RECEIPT] as Record<string, unknown>;
      v.remember({ content: 'Planted copy.', type: 'episodic', scope, source: 'test', metadata: { [RECEIPT]: retarget({ ...receipt }, v) } });
      return { v, spec, project };
    };
    const UNPROVEN = 'Operation receipt metadata exists without its original result.';

    const elsewhere = plantCopy('project:other', (receipt) => receipt);
    expect(attempt(() => elsewhere.v.checkpointProject(elsewhere.spec.x_request))).toEqual({ code: 'operation_conflict', message: UNPROVEN, current: false });
    elsewhere.v.close();

    const liveOriginal = plantCopy('project:carry', (receipt, v) => ({ ...receipt, result_id: head(v, 'carry').id }));
    expect(attempt(() => liveOriginal.v.checkpointProject(liveOriginal.spec.x_request))).toEqual({ code: 'operation_conflict', message: UNPROVEN, current: false });
    liveOriginal.v.close();

    const otherScope = plantCopy('project:carry', (receipt, v) => {
      const stray = v.remember({ content: 'Stray.', type: 'episodic', scope: 'personal', source: 'test' }).id;
      v.forget(stray);
      return { ...receipt, result_id: stray };
    });
    expect(attempt(() => otherScope.v.checkpointProject(otherScope.spec.x_request))).toEqual({ code: 'operation_conflict', message: UNPROVEN, current: false });
    otherScope.v.close();
  });

  it('T5: an id used on one project is refused on another, before and after its revision is blanked', () => {
    const v = vault();
    const aBase = create(v, 'a');
    const bHead = create(v, 'b');
    const xResult = v.checkpointProject(request(v, 'a', X, aBase)).receipt.result_revision;
    expect(attempt(() => v.checkpointProject(request(v, 'b', X, bHead)))).toEqual({ code: 'operation_conflict', message: DIFFERENT, current: false });
    updates(v, 'a', 12);
    expect(isBlanked(v, xResult)).toBe(true);
    expect(attempt(() => v.checkpointProject(request(v, 'b', X, bHead)))).toEqual({ code: 'operation_conflict', message: DIFFERENT, current: false });
    expect(head(v, 'b').id).toBe(bHead);
    v.close();
  });

  it('T5b: after a rename, a verbatim retry for the old slug is a conflict, because the remembered id sits on another project', () => {
    const v = vault();
    const x = compactedCheckpoint(v, 'a');
    v.rescope(head(v, 'a').id, 'project:b');
    expect(ledgerIds(head(v, 'b'))).toEqual([X]);
    expect(attempt(() => v.checkpointProject(x))).toEqual({ code: 'operation_conflict', message: DIFFERENT, current: false });
    v.close();
  });

  it('T6: the head keeps exactly the newest 16 checkpoint and wrap ids through two hundred mixed saves', () => {
    const v = vault();
    create(v, 'demo');
    let seed = 0x0062;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const saved: string[] = [];
    const kinds = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const r = random();
      const current = head(v, 'demo');
      if (r < 0.5) {
        const id = `0062cccc-0000-4000-8000-${String(i).padStart(12, '0')}`;
        const mode = r < 0.25 ? 'checkpoint' : 'wrap';
        const { receipt } = v.checkpointProject({ ...request(v, 'demo', id, current.id, `Did ${i}.`), mode });
        saved.push(id);
        kinds.add(mode);
        const written = head(v, 'demo');
        const ledger = written.metadata![LEDGER] as Array<Record<string, unknown>>;
        expect(ledger.at(-1)).toEqual({ operation_id: id, request_fingerprint: receipt.request_fingerprint, saved_at: written.created_at });
      } else if (r < 0.8) {
        v.updateProject({ project: 'demo', expected_revision: current.id, status: `Update ${i}.` });
        kinds.add('update');
      } else {
        v.editMemory(current.id, { content: `${current.content}\nEdit ${i}.` });
        kinds.add('edit');
      }
      expect(ledgerIds(head(v, 'demo'))).toEqual(saved.slice(-16));
      const blankedWithKey = v.list({ includeSuperseded: true, includeForgotten: true })
        .filter((e) => e.forgotten_at !== null && e.metadata !== null && LEDGER in e.metadata);
      expect(blankedWithKey).toEqual([]);
      expect(v.verifyChain().ok).toBe(true);
    }
    expect(kinds).toEqual(new Set(['checkpoint', 'wrap', 'update', 'edit']));
    expect(saved.length).toBeGreaterThan(40);
    v.close();
  });

  it('T8: a malformed record carrying the id refuses, other malformed shapes are ignored and dropped', () => {
    const v = vault();
    const plant = (project: string, ledger: unknown) =>
      v.remember({ content: DOC, type: 'working', scope: `project:${project}`, source: 'test', metadata: { [LEDGER]: ledger } }).id;
    const now = new Date().toISOString();
    const ids = (n: number) => `0062dddd-0000-4000-8000-${String(n).padStart(12, '0')}`;

    const extraKey = plant('m6', [{ operation_id: ids(11), request_fingerprint: 'a'.repeat(64), saved_at: now, note: 'extra' }]);
    expect(attempt(() => v.checkpointProject(request(v, 'm6', ids(11), extraKey)))).toEqual({ code: 'operation_conflict', message: MALFORMED, current: false });
    const badTime = plant('m7', [{ operation_id: ids(12), request_fingerprint: 'a'.repeat(64), saved_at: 'not a time' }]);
    expect(attempt(() => v.checkpointProject(request(v, 'm7', ids(12), badTime)))).toEqual({ code: 'operation_conflict', message: MALFORMED, current: false });

    const shortFingerprint = plant('m1', [{ operation_id: ids(1), request_fingerprint: '0123456789', saved_at: now }]);
    expect(attempt(() => v.checkpointProject(request(v, 'm1', ids(1), shortFingerprint)))).toEqual({ code: 'operation_conflict', message: MALFORMED, current: false });
    expect(head(v, 'm1').id).toBe(shortFingerprint);

    const both = plant('m0', [ids(10), { operation_id: ids(10), request_fingerprint: 'a'.repeat(64), saved_at: now }]);
    expect(attempt(() => v.checkpointProject(request(v, 'm0', ids(10), both)))).toEqual({ code: 'operation_conflict', message: MALFORMED, current: false });

    const bareString = plant('m2', [ids(2)]);
    expect(attempt(() => v.checkpointProject(request(v, 'm2', ids(2), bareString)))).toEqual({ code: 'operation_conflict', message: MALFORMED, current: false });
    expect(head(v, 'm2').id).toBe(bareString);

    const accepted: Array<[string, unknown, string]> = [
      ['m3', [{ operation_id: ids(3).toUpperCase(), request_fingerprint: 'a'.repeat(64), saved_at: now }], ids(3)],
      ['m4', { operation_id: ids(4) }, ids(4)],
      ['m5', [{ operation_id: ids(99), request_fingerprint: 'short', saved_at: now }], ids(5)],
    ];
    for (const [project, ledger, id] of accepted) {
      const planted = plant(project, ledger);
      expect(attempt(() => v.checkpointProject(request(v, project, id, planted)))).toBe('written');
      expect(ledgerIds(head(v, project))).toEqual([id]);
    }

    // A malformed record guards its id only until the next checkpoint drops it (Decision 2).
    const other = ids(6);
    expect(attempt(() => v.checkpointProject(request(v, 'm2', other, bareString)))).toBe('written');
    expect(ledgerIds(head(v, 'm2'))).toEqual([other]);
    expect(attempt(() => v.checkpointProject(request(v, 'm2', ids(2), head(v, 'm2').id)))).toBe('written');
    expect(v.verifyChain().ok).toBe(true);
    v.close();
  });

  it('T9: an id used in a scope outside the grant is not found, as before compaction; seen again beside its own project, it refuses', () => {
    const v = vault();
    compactedCheckpoint(v, 'a');
    const bHead = create(v, 'b');
    const xb = request(v, 'b', X, bHead);
    expect(attempt(() => v.checkpointProject(xb, ['project:b']))).toBe('written');
    expect(didCount(v, 'b', 'Did X.')).toBe(1);

    // Hits on both projects, one of them the request's own with its fingerprint, still refuse.
    updates(v, 'b', 12);
    expect(attempt(() => v.checkpointProject(xb))).toEqual({ code: 'operation_conflict', message: DIFFERENT, current: false });
    v.close();
  });

  it('T10: a head changed to another type leaves the lookup, so a recreated project writes the id (Residual 3)', () => {
    const v = vault();
    compactedCheckpoint(v, 'a');
    v.editMemory(head(v, 'a').id, { type: 'semantic' });
    const recreated = create(v, 'a');
    expect(attempt(() => v.checkpointProject(request(v, 'a', X, recreated)))).toBe('written');
    expect(didCount(v, 'a', 'Did X.')).toBe(1);
    v.close();
  });
});
