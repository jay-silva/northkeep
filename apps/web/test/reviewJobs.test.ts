import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reviewMock = vi.hoisted(() => {
  let resolveResult: ((value: unknown) => void) | undefined;
  return {
    run: vi.fn(() => new Promise((resolve) => { resolveResult = resolve; })),
    finish() {
      resolveResult?.({
        model: 'fixture-review', batches: 1, proposals: [], drops: {},
        coverage: { selected: 1, compared: 1, skipped: 0, failed: 0, complete: true },
      });
      resolveResult = undefined;
    },
    reset() { resolveResult = undefined; },
  };
});

vi.mock('@northkeep/librarian', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@northkeep/librarian')>();
  return {
    ...actual,
    resolveReviewModel: vi.fn(async () => 'fixture-review'),
    hasOllamaModel: vi.fn(async () => false),
    runReviewPass: reviewMock.run,
  };
});

import { ensureDeviceSecret, KDF_INTERACTIVE, Vault } from '@northkeep/core';
import { assembleReviewReport, loadReviewReport, saveReviewReport } from '@northkeep/librarian';
import { handleApi } from '../src/api.js';
import { UiSession } from '../src/session.js';

const passphrase = 'synthetic review job passphrase';
let directory = '';
let vaultPath = '';
let session: UiSession;

function body(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

async function start(scopes = ['personal']) {
  return handleApi(session, 'POST', '/api/review/run', new URLSearchParams(), body({ scopes }));
}

async function status(jobId: string) {
  return handleApi(session, 'GET', `/api/review/job/${jobId}`, new URLSearchParams(), Buffer.alloc(0));
}

async function waitForRun(): Promise<void> {
  for (let attempt = 0; attempt < 30 && reviewMock.run.mock.calls.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(reviewMock.run).toHaveBeenCalled();
}

async function waitForDone(jobId: string): Promise<{ status: string; error?: string }> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await status(jobId);
    const result = response.body as { status: string; error?: string };
    if (result.status !== 'running') return result;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('review job did not finish');
}

async function createCurrentReport(): Promise<void> {
  await session.withVault((vault) => {
    const entries = vault.list();
    saveReviewReport(assembleReviewReport({
      model: 'fixture', started_at: new Date().toISOString(), entry_count: entries.length,
      drops: {}, proposals: [], vault_id: vault.getVaultId(), vault_path: vaultPath,
      selected_scopes: ['personal'], source_entries: entries,
    }), vaultPath);
  });
}

describe('review job snapshot and concurrency boundaries', () => {
  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-web-review-jobs-'));
    process.env.NORTHKEEP_HOME = directory;
    process.env.NORTHKEEP_NO_KEYCHAIN = '1';
    ensureDeviceSecret();
    vaultPath = path.join(directory, 'vault.nkv');
    const vault = Vault.create({
      path: vaultPath, passphrase, deviceSecret: ensureDeviceSecret().secret, kdf: KDF_INTERACTIVE,
    });
    vault.remember({ content: 'Original synthetic fact.', type: 'semantic', scope: 'personal' });
    vault.save();
    vault.close();
    session = new UiSession(vaultPath);
    await session.unlock(passphrase);
    reviewMock.run.mockClear();
    reviewMock.reset();
  });

  afterEach(() => {
    session.autoSync.stop();
    session.lock();
    vi.restoreAllMocks();
    delete process.env.NORTHKEEP_HOME;
    delete process.env.NORTHKEEP_NO_KEYCHAIN;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('shows only selected collections in cloud consent and rejects duplicate selections before model work', async () => {
    await session.withVault((vault) => {
      vault.remember({ content: 'Unselected synthetic fact.', type: 'semantic', scope: 'work' });
      vault.save();
    });
    const provider = {
      id: 'bounded-test', label: 'Bounded Test', baseUrl: 'https://review.invalid/v1',
      model: 'fixture-model', kind: 'openai-compatible', hasKey: true,
    };
    fs.writeFileSync(path.join(directory, 'providers.json'), JSON.stringify({ endpoints: [provider] }), { mode: 0o600 });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const consent = await handleApi(session, 'POST', '/api/review/preflight', new URLSearchParams(), body({ endpoint_id: provider.id, scopes: ['personal'], tier: 1 }));
    expect(consent.status).toBe(200);
    expect(consent.body).toMatchObject({ memory_count: 1, scopes: [{ scope: 'personal', count: 1 }] });
    expect((consent.body as { scopes: unknown[] }).scopes).toHaveLength(1);
    expect((await start(['personal', 'personal'])).status).toBe(400);
    for (const route of ['/api/review/preflight', '/api/review/run']) {
      const response = await handleApi(session, 'POST', route, new URLSearchParams(), body({
        mode: 'api', endpoint_id: provider.id, scopes: ['personal', 'personal'], selection_fingerprint: 'unused', tier: 1,
      }));
      expect(response.status).toBe(400);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(reviewMock.run).not.toHaveBeenCalled();
  });

  it('does not poison vault concurrency after repeated invalid scopes, then starts a valid run', async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await start(['missing-scope'])).status).toBe(400);
    }
    const valid = await start();
    expect(valid.status).toBe(200);
    const jobId = (valid.body as { job_id: string }).job_id;
    await waitForRun();
    reviewMock.finish();
    expect((await waitForDone(jobId)).status).toBe('done');
  });

  it('returns 409 for a concurrent run and makes no vault or report write while analysis is pending', async () => {
    const before = fs.readFileSync(vaultPath);
    const first = await start();
    const jobId = (first.body as { job_id: string }).job_id;
    await waitForRun();
    expect((await start()).status).toBe(409);
    expect(fs.readFileSync(vaultPath)).toEqual(before);
    expect(loadReviewReport(vaultPath)).toBeNull();
    expect(await session.withVault((vault) => vault.list().map((entry) => entry.content)))
      .toEqual(['Original synthetic fact.']);
    reviewMock.finish();
    expect((await waitForDone(jobId)).status).toBe('done');
  });

  it('refuses completion when the starting report id has been replaced', async () => {
    const started = await start();
    const jobId = (started.body as { job_id: string }).job_id;
    await waitForRun();
    await createCurrentReport();
    const replacementId = (loadReviewReport(vaultPath) as { report_id: string }).report_id;
    reviewMock.finish();
    const result = await waitForDone(jobId);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/report changed/i);
    expect((loadReviewReport(vaultPath) as { report_id: string }).report_id).toBe(replacementId);
  });

  it('refuses completion when selected memory is added or changed during the run', async () => {
    for (const mutation of ['added', 'changed'] as const) {
      reviewMock.run.mockClear();
      const started = await start();
      const jobId = (started.body as { job_id: string }).job_id;
      await waitForRun();
      await session.withVault((vault) => {
        if (mutation === 'added') vault.remember({ content: 'Added synthetic fact.', type: 'semantic', scope: 'personal' });
        else vault.editMemory(vault.list()[0]!.id, { content: 'Changed synthetic fact.' });
        vault.save();
      });
      reviewMock.finish();
      const result = await waitForDone(jobId);
      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/vault changed/i);
      expect(loadReviewReport(vaultPath)).toBeNull();
    }
  });

  it.each(['content', 'destination'] as const)(
    'rejects stale cloud consent with the same memory count after %s changes, before generator send',
    async (mutation) => {
      const providersPath = path.join(directory, 'providers.json');
      const provider = {
        id: 'bounded-test', label: 'Bounded Test', baseUrl: 'https://review.invalid/v1',
        model: 'fixture-model', kind: 'openai-compatible', hasKey: true,
      };
      fs.writeFileSync(providersPath, JSON.stringify({ endpoints: [provider] }), { mode: 0o600 });
      const preflight = await handleApi(session, 'POST', '/api/review/preflight', new URLSearchParams(), body({
        endpoint_id: provider.id, scopes: ['personal'], tier: 1,
      }));
      expect(preflight.status).toBe(200);
      if (mutation === 'content') {
        await session.withVault((vault) => {
          vault.editMemory(vault.list()[0]!.id, { content: 'Consent changed synthetic fact.' });
          vault.save();
        });
      } else {
        fs.writeFileSync(providersPath, JSON.stringify({ endpoints: [{ ...provider, model: 'changed-model' }] }), { mode: 0o600 });
      }
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const response = await handleApi(session, 'POST', '/api/review/run', new URLSearchParams(), body({
        mode: 'api', endpoint_id: provider.id, scopes: ['personal'], tier: 1,
        selection_fingerprint: (preflight.body as { selection_fingerprint: string }).selection_fingerprint,
      }));
      expect(response.status).toBe(409);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(reviewMock.run).not.toHaveBeenCalled();
    },
  );
});
