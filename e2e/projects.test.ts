import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDeviceSecret, KDF_INTERACTIVE, Vault } from '@northkeep/core';
import { startUiServer, type RunningUiServer } from '../apps/web/dist/server.js';

const passphrase = 'synthetic-project-http-only';
let dir: string, vaultPath: string, secret: Buffer, server: RunningUiServer, origin: string, token: string;
let revision: string, vaultId: string;
const priorHome = process.env.NORTHKEEP_HOME;
const priorKeychain = process.env.NORTHKEEP_NO_KEYCHAIN;
async function request(route: string, body?: unknown, authenticated = true) {
  const res = await fetch(origin + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(authenticated ? { 'X-NorthKeep-Token': token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json() as Record<string, any> };
}
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-project-http-'));
  process.env.NORTHKEEP_HOME = dir; process.env.NORTHKEEP_NO_KEYCHAIN = '1';
  secret = ensureDeviceSecret().secret; vaultPath = path.join(dir, 'sample.nkv');
  const vault = Vault.create({ path: vaultPath, passphrase, deviceSecret: secret, kdf: KDF_INTERACTIVE });
  const view = vault.updateProject({ project: 'trail-journal', expected_revision: null, status: 'Three walks logged.', next_actions: 'Revise the offline label.', what_why: 'Keep synthetic field notes.' });
  revision = view.revision; vaultId = vault.getVaultId(); vault.save(); vault.close();
  server = await startUiServer({ vaultPath }); const url = new URL(server.url); origin = url.origin; token = url.searchParams.get('token')!;
});
afterAll(async () => {
  await server?.close();
  if (priorHome === undefined) delete process.env.NORTHKEEP_HOME; else process.env.NORTHKEEP_HOME = priorHome;
  if (priorKeychain === undefined) delete process.env.NORTHKEEP_NO_KEYCHAIN; else process.env.NORTHKEEP_NO_KEYCHAIN = priorKeychain;
  secret?.fill(0);
});

describe('Projects through the actual gated HTTP server', () => {
  it('requires session authentication and an unlocked vault', async () => {
    expect((await request('/api/projects', undefined, false)).status).toBe(401);
    expect((await request('/api/projects')).status).toBe(423);
    expect((await request('/api/unlock', { passphrase })).status).toBe(200);
    const result = await request('/api/projects'); expect(result.status).toBe(200);
    expect(result.data.projects[0].project).toBe('trail-journal');
    expect((await request('/api/projects/trail-journal')).data.revision).toBe(revision);
  });
  it('refuses wrong-vault and malformed updates without a disk write', async () => {
    const bytes = fs.readFileSync(vaultPath);
    const body = { vault_id: randomUUID(), operation_id: randomUUID(), expected_revision: revision, status: 'Ready.', completed: 'Checked.', next_actions: '' };
    expect([400,409]).toContain((await request('/api/projects/trail-journal/checkpoint', body)).status);
    expect((await request('/api/projects/trail-journal/checkpoint', { ...body, vault_id: vaultId, sharing: true })).status).toBe(400);
    expect((await request('/api/projects/trail-journal/checkpoint', { ...body, vault_id: vaultId, status: '## Log\nInjected section' })).status).toBe(400);
    expect(fs.readFileSync(vaultPath)).toEqual(bytes);
  });
  it('saves an exact checkpoint once and preserves file references as data', async () => {
    const body = { vault_id: vaultId, operation_id: randomUUID(), expected_revision: revision,
      status: 'Label revised. Café and Café remain distinct.', completed: 'Checked the label.', next_actions: '',
      open_questions: 'Does the narrow screen remain readable?',
      files: [{ type: 'local_path', label: '<img src=x onerror=alert(1)>', locator: '/unavailable/synthetic-notes.md', access: 'unavailable' }] };
    const saved = await request('/api/projects/trail-journal/checkpoint', body);
    expect(saved.status).toBe(200); expect(saved.data.current.status).toBe(body.status);
    expect(saved.data.current.next_actions).toBe(''); expect(saved.data.current.files).toEqual(body.files);
    const bytes = fs.readFileSync(vaultPath);
    const retry = await request('/api/projects/trail-journal/checkpoint', body);
    expect(retry.data.replayed).toBe(true); expect(retry.data.receipt).toEqual(saved.data.receipt);
    expect(fs.readFileSync(vaultPath)).toEqual(bytes);
    expect((await request('/api/projects/trail-journal/checkpoint', { ...body, completed: 'Altered reuse.' })).status).toBe(409);
    revision = saved.data.current.revision;
  });
  it('rejects an older client after a wrap and preserves the newer state', async () => {
    const oldRevision = revision;
    const body = { vault_id: vaultId, operation_id: randomUUID(), expected_revision: revision, status: 'Ready for the next assistant.', completed: 'Finished this session.', next_actions: 'Check the missing file before citing it.' };
    const saved = await request('/api/projects/trail-journal/wrap', body); expect(saved.status).toBe(200);
    const bytes = fs.readFileSync(vaultPath);
    const stale = await request('/api/projects/trail-journal/checkpoint', { ...body, operation_id: randomUUID(), expected_revision: oldRevision });
    expect(stale.status).toBe(409); expect(stale.data.current.revision).toBe(saved.data.current.revision);
    expect(fs.readFileSync(vaultPath)).toEqual(bytes);
    await request('/api/lock', {}); await request('/api/unlock', { passphrase });
    const retry = await request('/api/projects/trail-journal/wrap', body);
    expect(retry.data.replayed).toBe(true); expect(retry.data.receipt).toEqual(saved.data.receipt);
    const detail = await request('/api/projects/trail-journal');
    expect(detail.data.status).toBe(body.status); expect(detail.data.history.length).toBeGreaterThan(0);
    const vault = Vault.open({ path: vaultPath, passphrase, deviceSecret: secret });
    try { expect(vault.verifyChain().ok).toBe(true); expect(vault.sharedScopes()).toEqual([]); } finally { vault.close(); }
  });
});
