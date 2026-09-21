import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, generateDeviceSecret } from '../src/crypto.js';
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

  it('keeps revisions a handoff receipt still names', () => {
    const v = vault();
    let revision = seedProject(v, 'demo', 2);
    const receipt = v.checkpointProject({
      vault_id: v.getVaultId(), project: 'demo', mode: 'checkpoint',
      operation_id: '11111111-1111-4111-8111-111111111111', expected_revision: revision,
      status: 'Ready.', completed: 'Built the core.', next_actions: 'Next.',
    }).receipt;
    revision = receipt.result_revision;
    for (let i = 0; i < 10; i += 1) revision = v.updateProject({ project: 'demo', expected_revision: revision, status: `Later ${i}.` }).revision;
    const result = v.compactProjectHistory({ keep: 1 });
    expect(result.projects[0]!.kept).toBe(3); // newest one, plus the receipt's base and result
    const survivors = v.list({ scope: 'project:demo', includeSuperseded: true }).map((e) => e.id);
    expect(survivors).toContain(receipt.base_revision);
    expect(survivors).toContain(receipt.result_revision);
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

  it('keeps the revisions a checkpoint receipt names, and the checkpoint still replays', () => {
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
    for (let i = 0; i < 20; i += 1) revision = v.updateProject({ project: 'demo', expected_revision: revision, status: `Later ${i}.` }).revision;

    const surviving = survivingRevisions(v, 'project:demo');
    expect(surviving).toHaveLength(7); // the newest five plus the receipt's base and result
    expect(surviving).toContain(receipt.base_revision);
    expect(surviving).toContain(receipt.result_revision);

    const replay = v.checkpointProject(request);
    expect(replay.replayed).toBe(true);
    expect(replay.receipt).toEqual(receipt);
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
