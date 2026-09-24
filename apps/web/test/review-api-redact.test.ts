import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureDeviceSecret, KDF_INTERACTIVE, Vault } from '@northkeep/core';
import { loadReviewReport } from '@northkeep/librarian';
import { handleApi } from '../src/api.js';
import { UiSession } from '../src/session.js';

/**
 * ADR 0060 Decision 1 (D2), end to end through the web route. Every outbound
 * request is a stub: the provider and the loopback name and embedding model
 * are answered by a fetch stub, so nothing reaches a real service.
 */

const passphrase = 'synthetic cloud review passphrase';
const PROVIDER = {
  id: 'bounded-test', label: 'Bounded Test', baseUrl: 'https://review.invalid/v1',
  model: 'fixture-model', kind: 'openai-compatible', hasKey: true,
};

// Seeded values: none of these may appear in anything sent to the provider.
const SECRETS = {
  email: 'donna.k@example.com',
  phone: '508-555-0142',
  ssn: '123-45-6789',
  date: '03/15/1948',
  name: 'Zyler Okonkwo',
  dictionaryName: 'Donna Keller',
  scopePhone: '774-555-0199',
  scopeDate: '2026-10-03',
};

let directory = '';
let session: UiSession;
let providerBodies: string[] = [];
let nerMode: 'ok' | 'offline' | 'fail-twice' = 'ok';
let nerCalls = 0;
let onProviderCall: (() => void) | null = null;

function body(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

function stubNetwork(): void {
  vi.stubGlobal('fetch', async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/api/tags')) {
      const models = [{ name: 'nomic-embed-text:latest' }];
      if (nerMode !== 'offline') models.push({ name: 'llama3.2:3b' });
      return json({ models });
    }
    if (url.endsWith('/api/embed')) return json({ embeddings: [[1, 0, 0]] });
    if (url.endsWith('/api/generate')) {
      nerCalls += 1;
      const prompt = (JSON.parse(String(init?.body)) as { prompt: string }).prompt;
      const text = prompt.slice(prompt.lastIndexOf('\nText:\n') + 7);
      // fail-twice: one memory's call and its retry both fail (the text may be
      // partly masked by then, so match a phrase no layer masks).
      if (nerMode === 'fail-twice' && text.includes('has the biopsy results;')) throw new Error('name model timed out');
      const names = [SECRETS.name, SECRETS.dictionaryName].filter((n) => text.includes(n));
      return json({ response: JSON.stringify({ entities: names.map((n) => ({ text: n, kind: 'person' })) }) });
    }
    if (url.startsWith('https://review.invalid/')) {
      providerBodies.push(String(init?.body ?? ''));
      onProviderCall?.();
      return json({ choices: [{ message: { content: '{"proposals":[]}' } }] });
    }
    throw new Error(`unexpected request in test: ${url}`);
  });
}

async function seed(): Promise<void> {
  await session.withVault((vault) => {
    // Two memories per collection: the review only compares within a collection.
    vault.remember({ content: `Mom (${SECRETS.dictionaryName}) emails ${SECRETS.email}, born ${SECRETS.date}.`, type: 'semantic', scope: `visit:${SECRETS.scopeDate}` });
    vault.remember({ content: 'Mom moved to a new town last spring.', type: 'semantic', scope: `visit:${SECRETS.scopeDate}` });
    vault.remember({ content: `${SECRETS.name} has the biopsy results; call ${SECRETS.phone}, SSN ${SECRETS.ssn}.`, type: 'semantic', scope: `patient:${SECRETS.scopePhone}` });
    vault.remember({ content: 'The biopsy results are back and look fine.', type: 'semantic', scope: `patient:${SECRETS.scopePhone}` });
    vault.save();
  });
}

const SCOPES = () => [`visit:${SECRETS.scopeDate}`, `patient:${SECRETS.scopePhone}`];

async function preflight(tier: number) {
  return handleApi(session, 'POST', '/api/review/preflight', new URLSearchParams(), body({ endpoint_id: PROVIDER.id, scopes: SCOPES(), tier }));
}

async function run(tier: number, fingerprint: string) {
  return handleApi(session, 'POST', '/api/review/run', new URLSearchParams(), body({
    mode: 'api', endpoint_id: PROVIDER.id, scopes: SCOPES(), selection_fingerprint: fingerprint, tier,
  }));
}

async function finish(tier: number): Promise<{ status: string; error?: string; warning?: string; progress?: string }> {
  const pre = await preflight(tier);
  expect(pre.status).toBe(200);
  const started = await run(tier, (pre.body as { selection_fingerprint: string }).selection_fingerprint);
  expect(started.status).toBe(200);
  const jobId = (started.body as { job_id: string }).job_id;
  for (let i = 0; i < 400; i += 1) {
    const r = await handleApi(session, 'GET', `/api/review/job/${jobId}`, new URLSearchParams(), Buffer.alloc(0));
    const job = r.body as { status: string; error?: string; warning?: string; progress?: string };
    if (job.status !== 'running') return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('review job did not finish');
}

function logRows(file = path.join(directory, 'mcp-calls.log')): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((row) => row.tool === 'review_api');
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-review-redact-'));
  process.env.NORTHKEEP_HOME = directory;
  process.env.NORTHKEEP_NO_KEYCHAIN = '1';
  process.env.NORTHKEEP_OLLAMA_URL = 'http://127.0.0.1:9';
  process.env.NORTHKEEP_PROVIDER_KEY_BOUNDED_TEST = 'sk-test-not-a-real-key';
  fs.writeFileSync(path.join(directory, 'providers.json'), JSON.stringify({ endpoints: [PROVIDER] }), { mode: 0o600 });
  const vaultPath = path.join(directory, 'vault.nkv');
  Vault.create({ path: vaultPath, passphrase, deviceSecret: ensureDeviceSecret().secret, kdf: KDF_INTERACTIVE }).close();
  session = new UiSession(vaultPath);
  await session.unlock(passphrase);
  providerBodies = [];
  nerMode = 'ok';
  nerCalls = 0;
  onProviderCall = null;
  stubNetwork();
  await seed();
});

afterEach(() => {
  session.autoSync.stop();
  session.lock();
  vi.unstubAllGlobals();
  delete process.env.NORTHKEEP_PROVIDER_KEY_BOUNDED_TEST;
  delete process.env.NORTHKEEP_OLLAMA_URL;
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('ADR 0060 D2: the cloud review masks before it sends', () => {
  it('C1: Tier 1 sends no seeded secret, in content or in a collection name', async () => {
    const job = await finish(1);
    expect(job.status).toBe('done');
    expect(providerBodies.length).toBeGreaterThan(0);
    const wire = providerBodies.join('\n');
    for (const value of [SECRETS.email, SECRETS.phone, SECRETS.ssn, SECRETS.scopePhone]) {
      expect(wire, value).not.toContain(value);
    }
    // Tier 1 does not promise names or dates.
    expect(wire).toContain(SECRETS.date);
  });

  it('C1: Tier 3 also sends no name, no full date in content or collection name, and created_at as a year', async () => {
    const job = await finish(3);
    expect(job.status).toBe('done');
    const wire = providerBodies.join('\n');
    for (const value of Object.values(SECRETS)) expect(wire, value).not.toContain(value);
    expect(wire).toMatch(/created_at: 20\d\d\\n/);
    expect(wire).not.toMatch(/created_at: \d{4}-\d{2}-\d{2}T/);
  });

  it('C6: Tier 2 without the name model refuses before any send and logs tier2-unavailable', async () => {
    nerMode = 'offline';
    const job = await finish(2);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/Name masking failed for 4 of 4 memories\. Nothing was sent\./);
    expect(providerBodies).toHaveLength(0);
    const rows = logRows();
    expect(rows.some((r) => r.phase === 'pending')).toBe(false);
    expect(rows.at(-1)).toMatchObject({ phase: 'done', ok: false, error: 'tier2-unavailable', redaction_tier: 2 });
  });

  it('C24: Tier 2 with one memory whose name call fails twice refuses the whole run', async () => {
    nerMode = 'fail-twice';
    const job = await finish(2);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/Name masking failed for 1 of 4 memories/);
    expect(providerBodies).toHaveLength(0);
  });

  it('C6b: Tier 3 with a failing name call proceeds, labelled, with the flag in the audit row and report', async () => {
    nerMode = 'fail-twice';
    const job = await finish(3);
    expect(job.status).toBe('done');
    expect(job.progress).toMatch(/^Tier 3, deterministic only \(name model offline for 1 of 4 memories\)/);
    const rows = logRows();
    expect(rows.find((r) => r.phase === 'pending')).toMatchObject({ redaction_tier: 3, redaction_degraded: true });
    expect(rows.find((r) => r.phase === 'done')).toMatchObject({ ok: true, redaction_degraded: true });
    const report = loadReviewReport(path.join(directory, 'vault.nkv')) as { sent_to?: { tier?: number; degraded?: boolean } };
    expect(report.sent_to).toMatchObject({ tier: 3, degraded: true });
  });

  it('C7: the consented tier is the tier that runs', async () => {
    const pre = await preflight(3);
    const fingerprint = (pre.body as { selection_fingerprint: string }).selection_fingerprint;
    const r = await run(1, fingerprint);
    expect(r.status).toBe(409);
    expect(providerBodies).toHaveLength(0);
    expect((await handleApi(session, 'POST', '/api/review/preflight', new URLSearchParams(), body({ endpoint_id: PROVIDER.id, scopes: SCOPES() }))).status).toBe(400);
  });

  it('C8: an unwritable call log refuses the run with nothing sent', async () => {
    fs.mkdirSync(path.join(directory, 'mcp-calls.log'));
    const job = await finish(1);
    expect(job.status).toBe('failed');
    expect(job.error).toBe('NorthKeep could not write its call log, so nothing was sent.');
    expect(providerBodies).toHaveLength(0);
  });

  it('C31: the pending row carries the ledger; a completion-row failure still saves the report and warns', async () => {
    const logFile = path.join(directory, 'mcp-calls.log');
    const moved = path.join(directory, 'moved.log');
    onProviderCall = () => {
      if (!fs.existsSync(moved)) {
        fs.renameSync(logFile, moved);
        fs.mkdirSync(logFile);
      }
    };
    const job = await finish(1);
    expect(job.status).toBe('done');
    expect(job.warning).toBe('The review finished, but its log entry could not be completed.');
    const pending = logRows(moved).find((r) => r.phase === 'pending')!;
    expect((pending.result_ids as string[]).length).toBe(4);
    expect(pending.disclosed_scopes).toEqual([...SCOPES()].sort());
    expect(loadReviewReport(path.join(directory, 'vault.nkv'))).not.toBeNull();
  });
});

describe('ADR 0060 code review F2 through the web route', () => {
  it('A-W2: a name the model finds in only one memory is masked in every memory sent', async () => {
    await session.withVault((vault) => {
      for (const e of vault.list()) vault.forget(e.id);
      vault.remember({ content: 'Zyler Okonkwo called about the lease renewal.', type: 'semantic', scope: 'visit:2026-10-03' });
      vault.remember({ content: 'Met Zyler Okonkwo at the clinic on Tuesday.', type: 'semantic', scope: 'visit:2026-10-03' });
      vault.save();
    });
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', async (input: unknown, init?: { body?: unknown }) => {
      const url = String(input);
      const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/api/tags')) return json({ models: [{ name: 'nomic-embed-text:latest' }, { name: 'llama3.2:3b' }] });
      if (url.endsWith('/api/embed')) return json({ embeddings: [[1, 0, 0]] });
      if (url.endsWith('/api/generate')) {
        const prompt = (JSON.parse(String(init?.body)) as { prompt: string }).prompt;
        const text = prompt.slice(prompt.lastIndexOf('\nText:\n') + 7);
        const hit = text.includes('clinic') && text.includes('Zyler Okonkwo');
        return json({ response: JSON.stringify({ entities: hit ? [{ text: 'Zyler Okonkwo', kind: 'person' }] : [] }) });
      }
      if (url.startsWith('https://review.invalid/')) {
        providerBodies.push(String(init?.body ?? ''));
        return json({ choices: [{ message: { content: '{"proposals":[]}' } }] });
      }
      throw new Error(`unexpected request in test: ${url}`);
    });
    const pre = await handleApi(session, 'POST', '/api/review/preflight', new URLSearchParams(), body({ endpoint_id: PROVIDER.id, scopes: ['visit:2026-10-03'], tier: 2 }));
    const started = await handleApi(session, 'POST', '/api/review/run', new URLSearchParams(), body({
      mode: 'api', endpoint_id: PROVIDER.id, scopes: ['visit:2026-10-03'], tier: 2,
      selection_fingerprint: (pre.body as { selection_fingerprint: string }).selection_fingerprint,
    }));
    const jobId = (started.body as { job_id: string }).job_id;
    for (let i = 0; i < 400; i += 1) {
      const r = await handleApi(session, 'GET', `/api/review/job/${jobId}`, new URLSearchParams(), Buffer.alloc(0));
      if ((r.body as { status: string }).status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(providerBodies.length).toBeGreaterThan(0);
    expect(providerBodies.join('\n')).not.toContain('Zyler');
  });
});


describe('ADR 0060 code review item 5: /api/redact honours Tier 3', () => {
  it('tier 3 masks dates to the year; an unknown tier is refused', async () => {
    const r = await handleApi(session, 'POST', '/api/redact', new URLSearchParams(), body({ text: 'Born 03/15/1948, mail a@example.com', tier: 3 }));
    expect(r.status).toBe(200);
    expect((r.body as { redacted: string; tierApplied: number }).redacted).toBe('Born [DATE-1948], mail [EMAIL_1]');
    expect((r.body as { tierApplied: number }).tierApplied).toBe(3);
    for (const tier of [4, '3', 0, null]) {
      const bad = await handleApi(session, 'POST', '/api/redact', new URLSearchParams(), body({ text: 'x', tier }));
      expect(bad.status, String(tier)).toBe(400);
    }
  });
});
