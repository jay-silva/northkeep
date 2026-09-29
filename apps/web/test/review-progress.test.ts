import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureDeviceSecret, KDF_INTERACTIVE, Vault } from '@northkeep/core';
import { handleApi } from '../src/api.js';
import { UiSession } from '../src/session.js';

/**
 * The review progress record the page polls. Every outbound request is a fetch
 * stub; the provider and the loopback models can be held open by a gate so a
 * poll lands mid-phase deterministically.
 */

const passphrase = 'synthetic review progress passphrase';
const PROVIDER = {
  id: 'bounded-test', label: 'Bounded Test', baseUrl: 'https://review.invalid/v1',
  model: 'fixture-model', kind: 'openai-compatible', hasKey: true,
};
// Two collections of two memories: two review batches. Scope names carry
// identifiers too, so the leak check covers them.
const MEMORIES = [
  { scope: 'visit:2026-10-03', content: 'Zyler Okonkwo emails donna.k@example.com about the lease.' },
  { scope: 'visit:2026-10-03', content: 'Zyler Okonkwo moved the lease meeting to Friday.' },
  { scope: 'patient:774-555-0199', content: 'The biopsy results for 508-555-0142 are back.' },
  { scope: 'patient:774-555-0199', content: 'The biopsy results look fine, call back Monday.' },
];
const SCOPES = [...new Set(MEMORIES.map((m) => m.scope))];

type Snapshot = Record<string, unknown> & { status: string; phase: { name: string } & Record<string, unknown>; error?: string };

let directory = '';
let session: UiSession;
let providerMode: 'ok' | 'fail' = 'ok';
let nerMode: 'ok' | 'fail' = 'ok';
let providerCalls = 0;
let gates = { provider: false, generate: false, embed: false };
let waiting: Array<() => void> = [];

function body(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

async function held(kind: keyof typeof gates): Promise<void> {
  if (gates[kind]) await new Promise<void>((resolve) => { waiting.push(resolve); });
}

function release(): void {
  const all = waiting;
  waiting = [];
  for (const resolve of all) resolve();
}

function stubNetwork(): void {
  vi.stubGlobal('fetch', async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/api/tags')) {
      return json({ models: [{ name: 'nomic-embed-text:latest' }, { name: 'llama3.2:3b' }, { name: 'qwen2.5:7b' }] });
    }
    if (url.endsWith('/api/embed')) {
      await held('embed');
      return json({ embeddings: [[1, 0, 0]] });
    }
    if (url.endsWith('/api/generate')) {
      await held('generate');
      const prompt = (JSON.parse(String(init?.body)) as { prompt: string }).prompt;
      if (prompt.includes('\nText:\n')) {
        if (nerMode === 'fail') throw new Error('name model timed out');
        return json({ response: '{"entities":[]}' });
      }
      return json({ response: '{"proposals":[]}' });
    }
    if (url.startsWith('https://review.invalid/')) {
      providerCalls += 1;
      await held('provider');
      if (providerMode === 'fail') return json({ error: { message: 'upstream exploded' } }, 500);
      return json({ choices: [{ message: { content: '{"proposals":[]}' } }] });
    }
    throw new Error(`unexpected request in test: ${url}`);
  });
}

async function startCloud(tier: number): Promise<string> {
  const pre = await handleApi(session, 'POST', '/api/review/preflight', new URLSearchParams(), body({ endpoint_id: PROVIDER.id, scopes: SCOPES, tier }));
  expect(pre.status).toBe(200);
  const started = await handleApi(session, 'POST', '/api/review/run', new URLSearchParams(), body({
    mode: 'api', endpoint_id: PROVIDER.id, scopes: SCOPES, tier,
    selection_fingerprint: (pre.body as { selection_fingerprint: string }).selection_fingerprint,
  }));
  expect(started.status).toBe(200);
  return (started.body as { job_id: string }).job_id;
}

async function startLocal(): Promise<string> {
  const started = await handleApi(session, 'POST', '/api/review/run', new URLSearchParams(), body({ scopes: SCOPES }));
  expect(started.status).toBe(200);
  return (started.body as { job_id: string }).job_id;
}

const seen: Snapshot[] = [];

async function poll(jobId: string): Promise<Snapshot> {
  const r = await handleApi(session, 'GET', `/api/review/progress/${jobId}`, new URLSearchParams(), Buffer.alloc(0));
  expect(r.status).toBe(200);
  const snap = r.body as Snapshot;
  seen.push(snap);
  return snap;
}

async function until(jobId: string, done: (s: Snapshot) => boolean): Promise<Snapshot> {
  for (let i = 0; i < 500; i += 1) {
    const snap = await poll(jobId);
    if (done(snap)) return snap;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`phase never reached; last: ${JSON.stringify(seen.at(-1))}`);
}

const finished = (s: Snapshot) => s.status !== 'running';

function expectNoMemoryText(): void {
  const wire = JSON.stringify(seen);
  const needles = MEMORIES.flatMap((m) => [m.content, m.scope, ...m.content.split(/[ ,.]+/).filter((w) => w.length > 5)]);
  for (const needle of new Set(needles)) expect(wire, needle).not.toContain(needle);
}

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-review-progress-'));
  process.env.NORTHKEEP_HOME = directory;
  process.env.NORTHKEEP_NO_KEYCHAIN = '1';
  process.env.NORTHKEEP_OLLAMA_URL = 'http://127.0.0.1:9';
  process.env.NORTHKEEP_PROVIDER_KEY_BOUNDED_TEST = 'sk-test-not-a-real-key';
  fs.writeFileSync(path.join(directory, 'providers.json'), JSON.stringify({ endpoints: [PROVIDER] }), { mode: 0o600 });
  const vaultPath = path.join(directory, 'vault.nkv');
  Vault.create({ path: vaultPath, passphrase, deviceSecret: ensureDeviceSecret().secret, kdf: KDF_INTERACTIVE }).close();
  session = new UiSession(vaultPath);
  await session.unlock(passphrase);
  providerMode = 'ok';
  nerMode = 'ok';
  providerCalls = 0;
  gates = { provider: false, generate: false, embed: false };
  waiting = [];
  seen.length = 0;
  stubNetwork();
  await session.withVault((vault) => {
    for (const m of MEMORIES) vault.remember({ content: m.content, type: 'semantic', scope: m.scope });
    vault.save();
  });
});

afterEach(() => {
  release();
  session.autoSync.stop();
  session.lock();
  vi.unstubAllGlobals();
  delete process.env.NORTHKEEP_PROVIDER_KEY_BOUNDED_TEST;
  delete process.env.NORTHKEEP_OLLAMA_URL;
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('review progress record', () => {
  it('cloud: masking with counts, then each batch as it is sent, then done with the suggestion count', async () => {
    gates = { provider: true, generate: true, embed: false };
    const jobId = await startCloud(2);

    // Tier 2 asks the local name model about each memory; hold the first ask.
    expect((await until(jobId, (s) => s.phase.name === 'masking' && s.phase.total !== undefined)).phase)
      .toEqual({ name: 'masking', done: 0, total: 4 });
    gates.generate = false;
    release();

    const sending = await until(jobId, (s) => s.phase.name === 'sending');
    expect(sending.phase).toEqual({ name: 'sending', done: 0, total: 2, failed: 0 });
    // The comparing phase's note does not linger into sending.
    expect(sending.progress).toBeUndefined();
    expect(providerCalls).toBe(1);
    release();
    expect((await until(jobId, (s) => s.phase.name === 'sending' && s.phase.done === 1)).phase)
      .toEqual({ name: 'sending', done: 1, total: 2, failed: 0 });
    gates.provider = false;
    release();

    const end = await until(jobId, finished);
    expect(end.status).toBe('done');
    expect(end.phase).toEqual({ name: 'done', suggestions: 0, batches: 2, failed: 0 });
    // Phases only move forward.
    const order = ['starting', 'comparing', 'masking', 'sending', 'saving', 'done'];
    const ranks = seen.map((s) => order.indexOf(s.phase.name));
    expect(ranks.every((r) => r >= 0)).toBe(true);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expectNoMemoryText();
  });

  it('cloud refusal: Tier 2 with the name model failing stops as failed with the reason, and never reaches a send', async () => {
    nerMode = 'fail';
    const jobId = await startCloud(2);
    const end = await until(jobId, finished);
    expect(end.status).toBe('failed');
    expect(end.phase).toEqual({ name: 'failed' });
    expect(end.error).toMatch(/^Name masking failed for 4 of 4 memories\. Nothing was sent\./);
    expect(seen.some((s) => s.phase.name === 'sending')).toBe(false);
    expect(providerCalls).toBe(0);
    expectNoMemoryText();
  });

  it('cloud provider error: every batch fails, and the done record says so instead of looking clean', async () => {
    providerMode = 'fail';
    const jobId = await startCloud(1);
    const end = await until(jobId, finished);
    expect(end.phase).toEqual({ name: 'done', suggestions: 0, batches: 2, failed: 2 });
    // Two batches, each tried twice.
    expect(providerCalls).toBe(4);
    // The provider's own error text never reaches the page.
    expect(JSON.stringify(seen)).not.toContain('upstream exploded');
    expectNoMemoryText();
  });

  it('local: each batch is reported as checked on this Mac, then done', async () => {
    gates.generate = true;
    gates.embed = true;
    const jobId = await startLocal();
    expect((await until(jobId, (s) => s.phase.name === 'comparing')).phase)
      .toEqual({ name: 'comparing', done: 0, total: 4 });
    gates.embed = false;
    release();
    expect((await until(jobId, (s) => s.phase.name === 'checking')).phase)
      .toEqual({ name: 'checking', done: 0, total: 2, failed: 0 });
    release();
    expect((await until(jobId, (s) => s.phase.name === 'checking' && s.phase.done === 1)).phase)
      .toEqual({ name: 'checking', done: 1, total: 2, failed: 0 });
    gates.generate = false;
    release();
    const end = await until(jobId, finished);
    expect(end.phase).toEqual({ name: 'done', suggestions: 0, batches: 2, failed: 0 });
    expect(providerCalls).toBe(0);
    expectNoMemoryText();
  });
});
