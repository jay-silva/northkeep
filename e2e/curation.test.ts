import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDeviceSecret, KDF_INTERACTIVE, Vault } from '@northkeep/core';
import { assembleReviewReport, proposalFingerprint, saveReviewReport, type ReviewProposal } from '../packages/librarian/dist/index.js';
import { startUiServer, type RunningUiServer } from '../apps/web/dist/server.js';

const passphrase = 'synthetic-curation-e2e-only';
let dataDir: string;
let vaultPath: string;
let deviceSecret: Buffer;
let running: RunningUiServer;
let origin: string;
let token: string;
let reportId: string;
let proposal: ReviewProposal;
const priorHome = process.env.NORTHKEEP_HOME;
const priorNoKeychain = process.env.NORTHKEEP_NO_KEYCHAIN;

function memories() {
  const vault = Vault.open({ path: vaultPath, passphrase, deviceSecret });
  try { return vault.list({ includeForgotten: true, includeSuperseded: true }); }
  finally { vault.close(); }
}

async function request(route: string, body?: unknown, authenticated = true) {
  const response = await fetch(`${origin}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(authenticated ? { 'X-NorthKeep-Token': token } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() as Record<string, any> };
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'northkeep-curation-http-'));
  process.env.NORTHKEEP_HOME = dataDir;
  process.env.NORTHKEEP_NO_KEYCHAIN = '1';
  deviceSecret = ensureDeviceSecret().secret;
  vaultPath = path.join(dataDir, 'vault.nkv');
  const vault = Vault.create({ path: vaultPath, passphrase, deviceSecret, kdf: KDF_INTERACTIVE });
  const original = vault.remember({ type: 'semantic', scope: 'writing', content: 'Keep summaries short.', source: 'synthetic-test' });
  const supporting = vault.remember({ type: 'semantic', scope: 'writing', content: 'For technical reviews include reasoning.', source: 'synthetic-test' });
  vault.remember({ type: 'working', scope: 'project:sample', content: 'Synthetic project document.', source: 'synthetic-test' });
  vault.save();
  proposal = {
    id: 'aabbccdd', kind: 'stale', entry_ids: [original.id, supporting.id],
    quotes: [{ entry_id: original.id, quote: original.content }, { entry_id: supporting.id, quote: supporting.content }],
    explanation: 'A possible context-specific preference.', target_entry_id: original.id,
    proposed_content: 'Keep summaries short; include reasoning in technical reviews.', status: 'pending',
  };
  const report = assembleReviewReport({
    vault_id: vault.getVaultId(), vault_path: vaultPath, selected_scopes: ['writing'],
    source_entries: [original, supporting], model: 'synthetic-test', started_at: new Date().toISOString(),
    entry_count: 2, drops: {}, proposals: [proposal],
    coverage: { selected: 2, compared: 2, skipped: 0, failed: 0, complete: true },
  });
  saveReviewReport(report, vaultPath);
  reportId = report.report_id;
  vault.close();
  running = await startUiServer({ vaultPath });
  const url = new URL(running.url);
  origin = url.origin;
  token = url.searchParams.get('token')!;
});

afterAll(async () => {
  await running?.close();
  if (priorHome === undefined) delete process.env.NORTHKEEP_HOME;
  else process.env.NORTHKEEP_HOME = priorHome;
  if (priorNoKeychain === undefined) delete process.env.NORTHKEEP_NO_KEYCHAIN;
  else process.env.NORTHKEEP_NO_KEYCHAIN = priorNoKeychain;
  deviceSecret?.fill(0);
});

describe('curation over the real HTTP/session boundary', () => {
  it('gates collections and history by token and unlocked vault', async () => {
    expect((await request('/api/review/collections', undefined, false)).status).toBe(401);
    expect((await request('/api/review/history')).status).toBe(423);
    expect((await request('/api/unlock', { passphrase })).status).toBe(200);
    const collections = await request('/api/review/collections');
    expect(collections.status).toBe(200);
    expect(collections.data.collections.map((c: {scope:string}) => c.scope)).toEqual(['writing']);
  });

  it('applies exactly edited wording once and restores through a new revision', async () => {
    const before = memories();
    const action = {
      report_id: reportId, proposal_fingerprint: proposalFingerprint(proposal), operation_id: randomUUID(),
      content: 'Use short summaries by default, with reasoning for technical reviews.',
    };
    const saved = await request(`/api/review/${proposal.id}/accept`, action);
    expect(saved.status, JSON.stringify(saved.data)).toBe(200);
    const after = memories();
    expect(after.length).toBe(before.length + 1);
    expect(after.some((entry) => entry.content === action.content && entry.superseded_at === null)).toBe(true);
    const retry = await request(`/api/review/${proposal.id}/accept`, action);
    expect(retry.status, JSON.stringify(retry.data)).toBe(200);
    expect(memories()).toEqual(after);
    const altered = await request(`/api/review/${proposal.id}/accept`, { ...action, content: 'Different retry text.' });
    expect(altered.status).toBe(409);
    expect(memories()).toEqual(after);
    const history = await request('/api/review/history');
    expect(history.status).toBe(200);
    const receipt = history.data.operations.find((entry: {operation_id:string}) => entry.operation_id === action.operation_id);
    expect(receipt).toBeTruthy();
    const savedHead = after.find((entry) => entry.content === action.content && entry.superseded_at === null)!;
    const restored = await request('/api/review/restore', {
      report_id: reportId, operation_id: randomUUID(), receipt_id: receipt.receipt_id,
      expected_head_id: savedHead.id, expected_content: savedHead.content,
    });
    expect(restored.status, JSON.stringify(restored.data)).toBe(200);
    const final = memories();
    expect(final.length).toBe(after.length + 1);
    expect(final.some((entry) => entry.content === 'Keep summaries short.' && entry.superseded_at === null)).toBe(true);
    expect(final.find((entry) => entry.id === proposal.target_entry_id)?.superseded_at).not.toBeNull();
  });

  it('rejects old reports and excluded collections without changing memories', async () => {
    const before = memories();
    const stale = await request(`/api/review/${proposal.id}/accept`, {
      report_id: randomUUID(), proposal_fingerprint: proposalFingerprint(proposal), operation_id: randomUUID(), content: 'Stale edit.',
    });
    expect(stale.status).toBe(409);
    expect((await request('/api/review/run', { scopes: ['project:sample'] })).status).toBe(400);
    expect((await request('/api/review/run', { scopes: [] })).status).toBe(400);
    expect(memories()).toEqual(before);
  });

  it('removes two duplicate members individually and restores a removal only once', async () => {
    const vault = Vault.open({ path: vaultPath, passphrase, deviceSecret });
    const members = Array.from({ length: 3 }, () => vault.remember({
      type: 'semantic', scope: 'duplicates', content: 'Identical synthetic preference.', source: 'synthetic-test',
    }));
    vault.save();
    const duplicate: ReviewProposal = {
      id: 'dddddddd', kind: 'duplicate', entry_ids: members.map((e) => e.id),
      quotes: members.map((e) => ({ entry_id: e.id, quote: e.content })),
      explanation: 'Exact repeats.', target_entry_id: null, proposed_content: null, status: 'pending',
      member_decisions: Object.fromEntries(members.map((e) => [e.id, 'pending' as const])),
    };
    const report = assembleReviewReport({
      vault_id: vault.getVaultId(), vault_path: vaultPath, selected_scopes: ['duplicates'],
      source_entries: members, model: 'synthetic-test', started_at: new Date().toISOString(),
      entry_count: 3, drops: {}, proposals: [duplicate],
      coverage: { selected: 3, compared: 3, skipped: 0, failed: 0, complete: true },
    });
    saveReviewReport(report, vaultPath);
    vault.close();
    const base = { report_id: report.report_id, proposal_fingerprint: proposalFingerprint(duplicate) };
    const remove = (index: number) => request('/api/review/dddddddd/forget', {
      ...base, operation_id: randomUUID(), entry_id: members[index]!.id, survivor_id: members[0]!.id,
    });
    const first = await remove(1);
    expect(first.status, JSON.stringify(first.data)).toBe(200);
    const second = await remove(2);
    expect(second.status, JSON.stringify(second.data)).toBe(200);
    expect(memories().filter((e) => e.scope === 'duplicates' && !e.forgotten_at && !e.superseded_at)).toHaveLength(1);
    const restore = {
      report_id: report.report_id, operation_id: randomUUID(), receipt_id: first.data.receipt.receipt_id,
      expected_head_id: members[1]!.id, expected_content: members[1]!.content,
    };
    const restored = await request('/api/review/restore', restore);
    expect(restored.status, JSON.stringify(restored.data)).toBe(200);
    const after = memories();
    expect((await request('/api/review/restore', restore)).status).toBe(200);
    expect(memories()).toEqual(after);
    expect((await request('/api/review/restore', { ...restore, operation_id: randomUUID() })).status).toBe(409);
    expect(memories()).toEqual(after);
  });

  it('accepts an exact user-written question answer only for a cited target', async () => {
    const vault = Vault.open({ path: vaultPath, passphrase, deviceSecret });
    const first = vault.remember({ type: 'semantic', scope: 'questions', content: 'Workshop at 9.', source: 'synthetic-test' });
    const second = vault.remember({ type: 'semantic', scope: 'questions', content: 'Workshop at 10.', source: 'synthetic-test' });
    vault.save();
    const question: ReviewProposal = {
      id: 'eeeeeeee', kind: 'question', entry_ids: [first.id, second.id],
      quotes: [first, second].map((e) => ({ entry_id: e.id, quote: e.content })),
      explanation: 'Two incompatible times.', question: 'Which time should be used?',
      target_entry_id: null, proposed_content: null, status: 'pending',
    };
    const report = assembleReviewReport({
      vault_id: vault.getVaultId(), vault_path: vaultPath, selected_scopes: ['questions'],
      source_entries: [first, second], model: 'synthetic-test', started_at: new Date().toISOString(),
      entry_count: 2, drops: {}, proposals: [question],
      coverage: { selected: 2, compared: 2, skipped: 0, failed: 0, complete: true },
    });
    saveReviewReport(report, vaultPath);
    vault.close();
    const action = {
      report_id: report.report_id, proposal_fingerprint: proposalFingerprint(question), operation_id: randomUUID(),
      content: 'Workshop at 10, except Mondays at 9.', target_entry_id: randomUUID(),
    };
    const before = memories();
    expect((await request('/api/review/eeeeeeee/accept', action)).status).toBe(400);
    expect(memories()).toEqual(before);
    const accepted = await request('/api/review/eeeeeeee/accept', { ...action, operation_id: randomUUID(), target_entry_id: first.id });
    expect(accepted.status, JSON.stringify(accepted.data)).toBe(200);
    expect(memories().some((e) => e.content === action.content && !e.superseded_at)).toBe(true);
  });
});
