import { describe, expect, it } from 'vitest';
import { redact, restore } from '../src/index.js';
import { applyTier1, luhnValid } from '../src/tier1.js';
import type { OllamaClient } from '@northkeep/librarian';

describe('Tier-1 behavior', () => {
  it('gives the same secret the same placeholder, and numbers distinct ones', () => {
    const { text, replacements } = applyTier1(
      'Call 774-555-0134 or 774-555-0134; backup 508-555-1234.',
    );
    expect(text).toBe('Call [PHONE_1] or [PHONE_1]; backup [PHONE_2].');
    expect(replacements).toHaveLength(2);
  });

  it('does not mask a non-Luhn 16-digit number as a card', () => {
    expect(luhnValid('4111111111111112')).toBe(false);
    const { text } = applyTier1('Order number 4111111111111112 shipped.');
    expect(text).toContain('4111111111111112'); // not a valid card → left alone
  });

  it('leaves ordinary prose untouched', () => {
    const clean = 'Jay owns a rental and prefers concise answers.';
    expect(applyTier1(clean).text).toBe(clean);
  });

  it('marks Tier-1 secrets as non-restorable', async () => {
    const result = await redact('SSN 123-45-6789.', { tier: 1 });
    expect(result.replacements[0]!.restorable).toBe(false);
    expect(restore(result.redacted, result.replacements)).toBe(result.redacted); // stays masked
  });
});

describe('Tier-2 pseudonymization (mocked local model)', () => {
  function fakeOllama(entities: Array<{ text: string; kind: string }>): OllamaClient {
    return {
      available: async () => true,
      generateJson: async () => JSON.stringify({ entities }),
    };
  }

  it('pseudonymizes entities and round-trips a response', async () => {
    const ollama = fakeOllama([
      { text: 'Bob Henderson', kind: 'person' },
      { text: 'Acme Corp', kind: 'org' },
    ]);
    const result = await redact(
      'Draft a letter to Bob Henderson at Acme Corp about the filing.',
      { tier: 2 },
      ollama,
    );
    expect(result.tier2Degraded).toBe(false);
    expect(result.tierApplied).toBe(2);
    expect(result.redacted).toBe('Draft a letter to Person-1 at Org-1 about the filing.');

    // The model's reply comes back with pseudonyms; restore puts names back.
    const modelReply = 'Dear Person-1, regarding Org-1, we confirm the filing.';
    expect(restore(modelReply, result.replacements)).toBe(
      'Dear Bob Henderson, regarding Acme Corp, we confirm the filing.',
    );
  });

  it('keeps pseudonyms consistent across calls via a shared map', async () => {
    const map = {};
    const a = await redact('Meet Bob Henderson.', { tier: 2, pseudonyms: map }, fakeOllama([{ text: 'Bob Henderson', kind: 'person' }]));
    const b = await redact('Bob Henderson called again.', { tier: 2, pseudonyms: map }, fakeOllama([{ text: 'Bob Henderson', kind: 'person' }]));
    expect(a.redacted).toContain('Person-1');
    expect(b.redacted).toContain('Person-1'); // same entity, same pseudonym
  });

  it('still applies Tier-1 to secrets the NER left behind', async () => {
    const result = await redact(
      'Bob Henderson, SSN 123-45-6789, at bob@acme.com.',
      { tier: 2 },
      fakeOllama([{ text: 'Bob Henderson', kind: 'person' }]),
    );
    expect(result.redacted).not.toContain('123-45-6789');
    expect(result.redacted).not.toContain('bob@acme.com');
    expect(result.redacted).toContain('Person-1');
  });

  it('degrades LOUDLY when the local model is unavailable', async () => {
    const result = await redact('Letter to Bob Henderson.', { tier: 2 }, null);
    expect(result.tier2Degraded).toBe(true);
    expect(result.tierApplied).toBe(1);
    // Names are NOT pseudonymized (Tier-2 unavailable) — caller must warn.
    expect(result.redacted).toContain('Bob Henderson');
  });

  it('ignores hallucinated spans the model did not quote from the text', async () => {
    const result = await redact(
      'A short note.',
      { tier: 2 },
      fakeOllama([{ text: 'Nonexistent Person', kind: 'person' }]),
    );
    expect(result.redacted).toBe('A short note.'); // span not in text → skipped
  });
});
