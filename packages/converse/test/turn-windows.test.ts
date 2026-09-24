import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TurnError,
  createSession,
  runTurn,
  type ChatMessage,
  type ChatOptions,
  type ConverseVault,
  type ModelProvider,
} from '../src/index.js';

/**
 * ADR 0060 Decision 8 (D9) through chat: the name model reads the whole
 * message in windows, and a failed window refuses a Tier-2 turn toward a
 * cloud endpoint exactly as an offline model does. The loopback model is a
 * fetch stub; the provider is a fake. Nothing leaves.
 */

const NAME = 'Quennell Abernathy-Vos';
const fakeVault: ConverseVault = { retrieve: () => [], list: () => [], commit: () => [] };

function provider(): ModelProvider & { received: ChatMessage[][] } {
  const received: ChatMessage[][] = [];
  return {
    kind: 'openai-compatible',
    baseUrl: 'https://api.example.com',
    received,
    chat: async (m: ChatMessage[], o: ChatOptions) => { received.push(m); o.onToken?.('ok'); return 'ok'; },
    chatTurn: async (m: ChatMessage[], o: ChatOptions) => { received.push(m); o.onToken?.('ok'); return { text: 'ok', toolCalls: [], stopReason: 'end' as const }; },
    listModels: async () => [],
  };
}

let failWindowWith: string | null = null;
beforeEach(() => {
  process.env.NORTHKEEP_OLLAMA_URL = 'http://127.0.0.1:9';
  failWindowWith = null;
  vi.stubGlobal('fetch', async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/api/tags')) return json({ models: [{ name: 'llama3.2:3b' }] });
    if (url.endsWith('/api/generate')) {
      const prompt = (JSON.parse(String(init?.body)) as { prompt: string }).prompt;
      const text = prompt.slice(prompt.lastIndexOf('\nText:\n') + 7);
      if (failWindowWith !== null && text.includes(failWindowWith)) throw new Error('name model timed out');
      return json({ response: JSON.stringify({ entities: text.includes(NAME) ? [{ text: NAME, kind: 'person' }] : [] }) });
    }
    throw new Error(`unexpected request in test: ${url}`);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NORTHKEEP_OLLAMA_URL;
});

function longMessage(): string {
  let filler = '';
  while (filler.length < 6100) filler += 'notes from the visit, nothing unusual. ';
  return `${filler.slice(0, 6100)} ${NAME} has the results. END-MARKER`;
}

describe('ADR 0060 D9 in chat', () => {
  it('C35 (chat): a Tier-2 turn masks a name after character 6,000', async () => {
    const p = provider();
    await runTurn({ message: longMessage(), session: createSession(), provider: p, model: 'm', vault: fakeVault, redactTier: 2, distill: false, auditFn: () => {} });
    const wire = JSON.stringify(p.received[0]);
    expect(wire).not.toContain('Quennell');
    expect(wire).toMatch(/Person-\d+ has the results/);
  });

  it('C37 (chat): one failed window refuses a Tier-2 turn toward a cloud endpoint, nothing sent', async () => {
    failWindowWith = 'END-MARKER';
    const p = provider();
    await expect(
      runTurn({ message: longMessage(), session: createSession(), provider: p, model: 'm', vault: fakeVault, redactTier: 2, distill: false, auditFn: () => {} }),
    ).rejects.toBeInstanceOf(TurnError);
    expect(p.received).toHaveLength(0);
  });
});
