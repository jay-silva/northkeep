import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryEntry } from '@northkeep/core';
import { redact } from '@northkeep/redact';
import {
  SUPERSET_ENTITIES,
  SUPERSET_INPUTS,
  missingAtTier3,
  supersetNer,
} from '../../redact/test/superset-fixture.js';
import {
  createReviewApiGenerator,
  createSession,
  runTurn,
  type ChatMessage,
  type ChatOptions,
  type ConverseVault,
  type EndpointConfig,
  type ModelProvider,
} from '../src/index.js';

/**
 * ADR 0060 W2 on chat and the cloud review: every value Tier 2 masks on an
 * input is also absent from what Tier 3 sends. The loopback name model and
 * the provider are stubs; nothing leaves.
 */

let home: string;
const saved = { ...process.env };
let providerBodies: string[] = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-w2-'));
  process.env.NORTHKEEP_HOME = home;
  process.env.NORTHKEEP_NO_KEYCHAIN = '1';
  process.env.NORTHKEEP_OLLAMA_URL = 'http://127.0.0.1:9';
  process.env.NORTHKEEP_PROVIDER_KEY_OPENAI_TEST = 'sk-test-not-a-real-key';
  providerBodies = [];
  const ner = supersetNer();
  vi.stubGlobal('fetch', async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/api/tags')) return json({ models: [{ name: 'llama3.2:3b' }] });
    if (url.endsWith('/api/generate')) {
      const prompt = (JSON.parse(String(init?.body)) as { prompt: string }).prompt;
      return json({ response: await ner.generateJson(prompt) });
    }
    if (url.startsWith('https://api.openai.com')) {
      providerBodies.push(String(init?.body ?? ''));
      return json({ choices: [{ message: { content: '{"proposals":[]}' } }] });
    }
    throw new Error(`unexpected request in test: ${url}`);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...saved };
  fs.rmSync(home, { recursive: true, force: true });
});

const fakeVault: ConverseVault = { retrieve: () => [], list: () => [], commit: () => [] };

function provider(): ModelProvider & { received: ChatMessage[][] } {
  const received: ChatMessage[][] = [];
  return {
    kind: 'openai-compatible', baseUrl: 'https://api.example.com', received,
    chat: async (m: ChatMessage[], o: ChatOptions) => { received.push(m); o.onToken?.('ok'); return 'ok'; },
    chatTurn: async (m: ChatMessage[], o: ChatOptions) => { received.push(m); o.onToken?.('ok'); return { text: 'ok', toolCalls: [], stopReason: 'end' as const }; },
    listModels: async () => [],
  };
}

async function tier2Originals(text: string): Promise<string[]> {
  return (await redact(text, { tier: 2 }, supersetNer())).replacements.map((r) => r.original);
}

describe('ADR 0060 W2: Tier 3 sends nothing Tier 2 masks', () => {
  for (const input of SUPERSET_INPUTS) {
    it(`W2 chat: ${input.slice(0, 40)}`, async () => {
      const p = provider();
      await runTurn({ message: input, session: createSession(), provider: p, model: 'm', vault: fakeVault, redactTier: 3, distill: false, auditFn: () => {} });
      const wire = p.received[0]!.map((m) => m.content).join('\n');
      expect(missingAtTier3(await tier2Originals(input), wire)).toEqual([]);
    });
  }

  it('W2 cloud review: every memory at Tier 3', async () => {
    const CLOUD: EndpointConfig = { id: 'openai-test', label: 'OpenAI', baseUrl: 'https://api.openai.com', model: 'gpt-4o-mini', kind: 'openai-compatible', hasKey: true };
    const entries: MemoryEntry[] = SUPERSET_INPUTS.map((content, i) => ({
      id: `${i + 1}${i + 1}${i + 1}${i + 1}${i + 1}${i + 1}${i + 1}${i + 1}-1111-4111-8111-111111111111`, type: 'semantic', content, scope: 'personal',
      source: 'cli', source_model: null, confidence: 1, created_at: '2026-09-01T10:00:00.000Z', valid_from: null,
      superseded_at: null, superseded_by: null, forgotten_at: null, prev_hash: '', entry_hash: '', metadata: null,
    }));
    const gen = createReviewApiGenerator(CLOUD, { tier: 3, ollama: supersetNer() });
    const [handle] = await gen.prepare([entries]);
    await gen.send(handle!, { model: 'm', timeoutMs: 1000 });
    const wire = (JSON.parse(providerBodies[0]!) as { messages: Array<{ content: string }> }).messages[0]!.content;
    const originals = (await Promise.all(SUPERSET_INPUTS.map(tier2Originals))).flat();
    expect(missingAtTier3(originals, wire)).toEqual([]);
    for (const e of SUPERSET_ENTITIES) expect(wire, e).not.toContain(e);
  });
});
