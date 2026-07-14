import { describe, expect, it } from 'vitest';
import {
  BASELINE_CATALOG,
  compareTurnCost,
  createSession,
  estimateTokensFromChars,
  estimateTurnCost,
  lookupModel,
  runTurn,
  type CatalogEntry,
  type ChatMessage,
  type ChatOptions,
  type ConverseVault,
  type ModelProvider,
} from '../src/index.js';

/**
 * Local, on-device cost metering (packages/converse). All figures are
 * APPROXIMATE; these tests pin the arithmetic and the graceful-degradation
 * behaviour, not the exactness of any public price.
 */

const catalog = [...BASELINE_CATALOG];

// A model with round prices makes the expected USD trivial to reason about.
const priced: CatalogEntry = {
  id: 'test-priced',
  strengths: ['general'],
  costTier: 'medium',
  speedTier: 'medium',
  inputPer1M: 10, // $10 / 1M input tokens
  outputPer1M: 30, // $30 / 1M output tokens
};

describe('estimateTurnCost', () => {
  it('multiplies token counts by the per-1M prices', () => {
    // 1,000,000 in × $10 + 1,000,000 out × $30 = $40.
    const cost = estimateTurnCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, priced);
    expect(cost).toEqual({ usd: 40, approximate: true });
  });

  it('scales down for small turns', () => {
    // 500 in × $10/1M + 2000 out × $30/1M = 0.005 + 0.06 = 0.065.
    const cost = estimateTurnCost({ inputTokens: 500, outputTokens: 2000 }, priced);
    expect(cost?.usd).toBeCloseTo(0.065, 10);
    expect(cost?.approximate).toBe(true);
  });

  it('prices free-local models to exactly $0', () => {
    const local = lookupModel('qwen2.5:14b', catalog);
    expect(local?.costTier).toBe('free-local');
    const cost = estimateTurnCost({ inputTokens: 5000, outputTokens: 8000 }, local);
    expect(cost).toEqual({ usd: 0, approximate: true });
  });

  it('returns null when the catalog entry is missing', () => {
    expect(estimateTurnCost({ inputTokens: 100, outputTokens: 100 }, null)).toBeNull();
  });

  it('returns null when the entry has no price (never guesses)', () => {
    const noPrice: CatalogEntry = {
      id: 'unpriced',
      strengths: ['general'],
      costTier: 'medium',
      speedTier: 'medium',
    };
    expect(estimateTurnCost({ inputTokens: 100, outputTokens: 100 }, noPrice)).toBeNull();
  });

  it('uses the real baseline prices (claude-opus ≈ $15/$75)', () => {
    const opus = lookupModel('claude-opus-4-8', catalog);
    // 10,000 in × $15/1M + 2,000 out × $75/1M = 0.15 + 0.15 = 0.30.
    const cost = estimateTurnCost({ inputTokens: 10_000, outputTokens: 2000 }, opus);
    expect(cost?.usd).toBeCloseTo(0.3, 10);
  });
});

describe('compareTurnCost', () => {
  const endpoints = [
    { label: 'Opus', model: 'claude-opus-4-8' }, // high
    { label: 'Grok', model: 'grok-4.5' }, // high, cheaper than opus on output
    { label: 'Qwen (local)', model: 'qwen2.5:14b' }, // free-local → $0
    { label: 'Mystery', model: 'totally-unknown-model' }, // no catalog price → dropped
  ];

  it('returns one priced row per known model, cheapest first', () => {
    const rows = compareTurnCost({ inputTokens: 10_000, outputTokens: 5000 }, endpoints, catalog);
    // Mystery is dropped (unknown price); the other three remain.
    expect(rows.map((r) => r.label)).toEqual(['Qwen (local)', 'Grok', 'Opus']);
    expect(rows[0]?.usd).toBe(0); // local is free
    // Sorted ascending by usd.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.usd).toBeGreaterThanOrEqual(rows[i - 1]!.usd);
    }
  });

  it('drops models with unknown prices rather than inventing one', () => {
    const rows = compareTurnCost(
      { inputTokens: 100, outputTokens: 100 },
      [{ label: 'Mystery', model: 'totally-unknown-model' }],
      catalog,
    );
    expect(rows).toEqual([]);
  });

  it('returns an empty array for no endpoints', () => {
    expect(compareTurnCost({ inputTokens: 100, outputTokens: 100 }, [], catalog)).toEqual([]);
  });
});

describe('estimateTokensFromChars', () => {
  it('approximates ~4 chars per token, rounding up', () => {
    expect(estimateTokensFromChars('')).toBe(0);
    expect(estimateTokensFromChars('abcd')).toBe(1);
    expect(estimateTokensFromChars('abcde')).toBe(2); // 5/4 → ceil → 2
    expect(estimateTokensFromChars('a'.repeat(400))).toBe(100);
  });
});

// --- runTurn wiring: usage (real vs estimated) + per-turn cost ---

const emptyVault: ConverseVault = {
  retrieve: () => [],
  list: () => [],
  commit: () => [],
};

class CostProvider implements ModelProvider {
  readonly kind = 'openai-compatible' as const;
  constructor(
    readonly baseUrl: string,
    private reply: string,
    private usage: { inputTokens: number; outputTokens: number } | null,
  ) {}
  async chat(_messages: ChatMessage[], options: ChatOptions): Promise<string> {
    options.onToken?.(this.reply);
    if (this.usage) options.onUsage?.(this.usage);
    return this.reply;
  }
  async listModels(): Promise<string[]> {
    return [];
  }
}

describe('runTurn — cost metering', () => {
  it('uses REAL provider usage and prices the turn from the catalog', async () => {
    const provider = new CostProvider('http://127.0.0.1:9999', 'ok', {
      inputTokens: 10_000,
      outputTokens: 2000,
    });
    const result = await runTurn({
      message: 'hello',
      session: createSession(),
      provider,
      model: 'claude-opus-4-8',
      vault: emptyVault,
      redactTier: 0, // private endpoint, no redaction needed
      distill: false,
      catalog,
    });
    expect(result.usage).toEqual({ inputTokens: 10_000, outputTokens: 2000, estimated: false });
    // opus ≈ $15/$75 per 1M → 0.15 + 0.15 = 0.30.
    expect(result.cost?.usd).toBeCloseTo(0.3, 10);
    expect(result.cost?.approximate).toBe(true);
  });

  it('falls back to an ESTIMATED chars/token count when the provider reports none', async () => {
    const reply = 'hello there friend'; // 18 chars → ceil(18/4) = 5 tokens out
    const provider = new CostProvider('http://127.0.0.1:9999', reply, null);
    const result = await runTurn({
      message: 'hello',
      session: createSession(),
      provider,
      model: 'claude-opus-4-8',
      vault: emptyVault,
      redactTier: 0,
      distill: false,
      catalog,
    });
    expect(result.usage?.estimated).toBe(true);
    expect(result.usage?.outputTokens).toBe(estimateTokensFromChars(reply));
    // Input covers the assembled system prompt + message, so it is non-trivial.
    expect(result.usage!.inputTokens).toBeGreaterThan(0);
    // Still priced (approximately) from the catalog.
    expect(result.cost?.usd).toBeGreaterThan(0);
    expect(result.cost?.approximate).toBe(true);
  });

  it('returns cost: null when the routed model has no catalog price', async () => {
    const provider = new CostProvider('http://127.0.0.1:9999', 'ok', {
      inputTokens: 100,
      outputTokens: 100,
    });
    const result = await runTurn({
      message: 'hello',
      session: createSession(),
      provider,
      model: 'totally-unknown-model',
      vault: emptyVault,
      redactTier: 0,
      distill: false,
      catalog,
    });
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 100, estimated: false });
    expect(result.cost).toBeNull();
  });
});
