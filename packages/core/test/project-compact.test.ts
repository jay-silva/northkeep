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
  it('keeps the newest five superseded revisions and blanks the rest', () => {
    const v = vault();
    seedProject(v, 'demo', 12);
    const before = liveRevisions(v, 'demo');
    expect(before).toHaveLength(12);
    const result = v.compactProjectHistory({});
    expect(result.projects).toEqual([{ project: 'demo', candidates: 12, kept: 5, blanked: 7, bytes_freed: expect.any(Number) }]);
    expect(result.blanked).toBe(7);
    expect(result.bytes_freed).toBeGreaterThan(0);
    const after = liveRevisions(v, 'demo');
    expect(after).toEqual(before.slice(7));
    const blanked = v.list({ scope: 'project:demo', includeSuperseded: true, includeForgotten: true }).filter((e) => e.forgotten_at !== null);
    expect(blanked).toHaveLength(7);
    for (const entry of blanked) expect(entry.content).toBe('');
    expect(v.verifyChain().ok).toBe(true);
    v.close();
  });

  it('honours keep, rejects an out-of-range keep and an invalid slug', () => {
    const v = vault();
    seedProject(v, 'demo', 8);
    expect(v.compactProjectHistory({ keep: 1, dryRun: true }).blanked).toBe(7);
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

    const result = v.compactProjectHistory({});
    expect(result.blanked).toBe(1); // 7 superseded, one already forgotten, five kept

    const after = new Map(v.export().memories.map((m) => [m.id, m]));
    expect(after.get(live)!.content.length).toBeGreaterThan(0);
    expect(after.get(note.id)!.content).toBe(note.content);
    expect(after.get(personal.id)!.content).toBe(personal.content);
    const archives = v.list({ scope: 'project:demo', includeSuperseded: true }).filter((e) => e.source === 'northkeep:project-log-archive');
    for (const archive of archives) expect(archive.content.length).toBeGreaterThan(0);
    const untouched = before.filter((m) => after.get(m.id)!.content === m.content);
    expect(untouched).toHaveLength(before.length - 1);
    expect(v.verifyChain().ok).toBe(true);
    v.close();
  });

  it('changes nothing on a dry run', () => {
    const v = vault();
    seedProject(v, 'demo', 9);
    const before = v.export();
    const dry = v.compactProjectHistory({ dryRun: true });
    expect(dry.blanked).toBe(4);
    expect(dry.bytes_freed).toBeGreaterThan(0);
    const after = v.export();
    expect(after.memories).toEqual(before.memories);
    expect(after.northkeep_export.chain_head).toBe(before.northkeep_export.chain_head);
    v.close();
  });

  it('shrinks the saved vault file and exports the blanked revisions as forgotten', () => {
    const v = vault();
    const body = 'z'.repeat(10 * 1024);
    let revision = v.updateProject({ project: 'demo', expected_revision: null, what_why: 'Why.', status: body, next_actions: 'Go' }).revision;
    for (let i = 0; i < 20; i += 1) revision = v.updateProject({ project: 'demo', expected_revision: revision, status: `${i} ${body}` }).revision;
    v.save();
    const beforeBytes = fs.statSync(vaultPath).size;

    const result = v.compactProjectHistory({});
    expect(result.blanked).toBe(15);
    v.save();
    const afterBytes = fs.statSync(vaultPath).size;
    console.log(`compaction file size: ${beforeBytes} -> ${afterBytes} bytes`);
    expect(afterBytes).toBeLessThan(beforeBytes / 2);

    const exported = v.export().memories;
    const forgotten = exported.filter((m) => m.validity.forgotten_at !== null);
    expect(forgotten).toHaveLength(15);
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
    expect(() => v.compactProjectHistory({})).toThrow(/chain does not verify/);
    expect(v.export().memories).toEqual(before.memories);
    v.close();
  });

  it('compacts only the named project', () => {
    const v = vault();
    seedProject(v, 'alpha', 8);
    seedProject(v, 'beta', 8);
    const result = v.compactProjectHistory({ project: 'alpha' });
    expect(result.projects.map((p) => p.project)).toEqual(['alpha']);
    expect(v.list({ scope: 'project:beta', includeSuperseded: true }).filter((e) => e.type === 'working' && e.superseded_at)).toHaveLength(8);
    expect(v.verifyChain().ok).toBe(true);
    v.close();
  });
});
