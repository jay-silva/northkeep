import { describe, expect, it } from 'vitest';
import { costLabel, type CostTier } from '../src/catalog.js';
import { suggestBetterModel } from '../src/route.js';
import type { EndpointConfig } from '../src/settings.js';

/** Cost surfacing + the concierge's gentle upsell (M9b/M9d, ADR 0014). */

const ep = (id: string, model: string): EndpointConfig => ({
  id,
  label: id,
  baseUrl: 'http://127.0.0.1:11434',
  model,
  kind: 'openai-compatible',
  hasKey: false,
});

describe('costLabel', () => {
  it('maps every tier to a symbol + range', () => {
    const tiers: CostTier[] = ['free-local', 'low', 'medium', 'high'];
    for (const t of tiers) {
      const l = costLabel(t);
      expect(l.symbol, t).not.toBe('');
      expect(l.range, t).not.toBe('');
    }
  });

  it('free-local reads as on-device; paid tiers escalate and are labelled approx', () => {
    expect(costLabel('free-local')).toEqual({ symbol: 'Free', range: 'runs on your Mac' });
    expect(costLabel('low').symbol).toBe('$');
    expect(costLabel('medium').symbol).toBe('$$');
    expect(costLabel('high').symbol).toBe('$$$');
    for (const t of ['low', 'medium', 'high'] as CostTier[]) {
      expect(costLabel(t).range).toContain('approx');
    }
  });
});

describe('suggestBetterModel', () => {
  it('suggests a stronger model for a coding question when only a weak local is configured', () => {
    const s = suggestBetterModel('fix this ```code``` please', [ep('local', 'llama3.2:3b')]);
    expect(s).not.toBeNull();
    expect(s!.task).toBe('code');
    expect(s!.modelLabel).toBe('Claude Opus');
    expect(s!.reason).toContain('Claude Opus');
  });

  it('stays silent when a strong-enough model for the task is already configured', () => {
    // qwen2.5 is catalogued strong at code.
    expect(suggestBetterModel('fix this ```code```', [ep('q', 'qwen2.5:14b')])).toBeNull();
  });

  it('stays silent when the configured hosted model covers the task', () => {
    expect(suggestBetterModel('fix this ```code```', [ep('c', 'claude-opus-4-8')])).toBeNull();
  });

  it('nudges you to USE a stronger model you already have (not connect a new one)', () => {
    // Qwen (free) + Grok (frontier) both configured & code-capable; cost-first
    // routing lands on free Qwen, so the tip should point at the Grok you own.
    const s = suggestBetterModel('fix this ```code```', [
      { ...ep('q', 'qwen2.5:14b'), label: 'Qwen2.5 14B' },
      { ...ep('g', 'grok-4.5'), label: 'Grok', baseUrl: 'https://api.x.ai', hasKey: true },
    ]);
    expect(s).not.toBeNull();
    expect(s!.reason).toContain('you have Grok connected');
    expect(s!.reason).not.toContain('connect it'); // it's a USE nudge, not a connect one
  });
});
