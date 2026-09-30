import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KDF_INTERACTIVE, generateDeviceSecret } from '../src/crypto.js';
import { PROJECT_RESTORE_BLANKED_MESSAGE, PROJECT_RESTORE_METADATA_KEY, ProjectHandoffError, getProjectView } from '../src/project-handoff.js';
import { Vault } from '../src/vault.js';

const PASS = 'synthetic project restore passphrase';
let directory: string;
let v: Vault;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-restore-'));
  v = Vault.create({ path: path.join(directory, 'vault.nkv'), passphrase: PASS, deviceSecret: generateDeviceSecret(), kdf: KDF_INTERACTIVE });
});
afterEach(() => {
  v.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

function refusal(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (err) {
    if (err instanceof ProjectHandoffError) return { code: err.code, message: err.message };
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('replaceProjectContent (ADR 0063)', () => {
  it('writes the whole text over the head it was given and keeps the old head in history', () => {
    const r1 = v.updateProject({ project: 'demo', expected_revision: null, status: 'Local one.' }).revision;
    const cloud = getProjectView(v, 'demo').content.replace('Local one.', 'Cloud text.');
    const view = v.replaceProjectContent({ project: 'demo', expected_revision: r1, content: cloud, source: 'connector:test', metadata: { connector: { server_id: 'conn_1' } } });
    expect(view.status).toBe('Cloud text.');
    expect(view.history.map((h) => h.id)).toEqual([r1]);
    const head = v.list({ scope: 'project:demo', type: 'working' });
    expect(head).toHaveLength(1);
    expect(head[0]!.metadata).toEqual({ connector: { server_id: 'conn_1' } });
    expect(v.verifyChain().ok).toBe(true);
  });

  it('refuses a stale head and changes nothing', () => {
    const r1 = v.updateProject({ project: 'demo', expected_revision: null, status: 'One.' }).revision;
    const r2 = v.updateProject({ project: 'demo', expected_revision: r1, status: 'Two.' }).revision;
    expect(refusal(() => v.replaceProjectContent({ project: 'demo', expected_revision: r1, content: '# Demo\n', source: 'x' }))).toEqual({ code: 'stale_project', message: 'Project changed after it was read.' });
    expect(getProjectView(v, 'demo').revision).toBe(r2);
  });

  it('creates with a null expected revision, and refuses null once a head exists', () => {
    const created = v.replaceProjectContent({ project: 'fresh', expected_revision: null, content: '## Current Status\nFrom the cloud.\n', source: 'connector:test' });
    expect(created.status).toBe('From the cloud.');
    expect(refusal(() => v.replaceProjectContent({ project: 'fresh', expected_revision: null, content: '## Current Status\nAgain.\n', source: 'x' })).code).toBe('stale_project');
  });
});

describe('restoreProjectRevision (ADR 0063 D4)', () => {
  it('restores the newest superseded revision exactly and records where it came from', () => {
    const r1 = v.updateProject({ project: 'demo', expected_revision: null, status: 'Good week.' }).revision;
    const oldText = getProjectView(v, 'demo').content;
    const r2 = v.updateProject({ project: 'demo', expected_revision: r1, status: 'Rolled back.' }).revision;
    const view = v.restoreProjectRevision({ project: 'demo', revision: r1, expected_revision: r2 });
    expect(view.content).toBe(oldText);
    expect(view.status).toBe('Good week.');
    const head = v.list({ scope: 'project:demo', type: 'working' })[0]!;
    expect(head.source).toBe('northkeep:project-restore');
    expect(head.metadata?.[PROJECT_RESTORE_METADATA_KEY]).toEqual({ from_revision: r1 });
    expect(view.history.map((h) => h.id)).toEqual([r2, r1]);
  });

  it('refuses a stale expected revision', () => {
    const r1 = v.updateProject({ project: 'demo', expected_revision: null, status: 'One.' }).revision;
    const r2 = v.updateProject({ project: 'demo', expected_revision: r1, status: 'Two.' }).revision;
    v.updateProject({ project: 'demo', expected_revision: r2, status: 'Three.' });
    expect(refusal(() => v.restoreProjectRevision({ project: 'demo', revision: r1, expected_revision: r2 })).code).toBe('stale_project');
  });

  it('refuses the current head and an unknown id', () => {
    const r1 = v.updateProject({ project: 'demo', expected_revision: null, status: 'One.' }).revision;
    expect(refusal(() => v.restoreProjectRevision({ project: 'demo', revision: r1, expected_revision: r1 }))).toEqual({ code: 'invalid_request', message: 'That version is already the current document.' });
    expect(refusal(() => v.restoreProjectRevision({ project: 'demo', revision: '00000000-0000-4000-8000-000000000000', expected_revision: r1 })).code).toBe('not_found');
  });

  it('refuses a revision compaction blanked, with the plain message', () => {
    let revision = v.updateProject({ project: 'demo', expected_revision: null, status: 'First.' }).revision;
    const first = revision;
    for (let i = 0; i < 7; i += 1) revision = v.updateProject({ project: 'demo', expected_revision: revision, status: `Edit ${i}.` }).revision;
    expect(refusal(() => v.restoreProjectRevision({ project: 'demo', revision: first, expected_revision: revision }))).toEqual({ code: 'not_found', message: PROJECT_RESTORE_BLANKED_MESSAGE });
  });
});
