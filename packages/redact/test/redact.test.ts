import { describe, expect, it } from 'vitest';
import { redact, restore } from '../src/index.js';
import { applyTier1, luhnValid, TOKEN_PREFIX_PATTERNS } from '../src/tier1.js';
import { FAKE_TOKENS, NEAR_MISSES, passesIssuerChecksum } from './fake-tokens.js';
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

describe('Tier-1 issuer-prefixed tokens (ADR 0059)', () => {
  it('masks every fake token as one whole api_key span, in prose and at string edges', () => {
    for (const { family, token } of FAKE_TOKENS) {
      for (const text of [`key ${token} end`, token, `"${token}",`, `export KEY=${token}\n`, `MY_KEY_${token} x`]) {
        const { text: out, replacements } = applyTier1(text);
        const hit = replacements.find((r) => r.original === token);
        expect(hit, `${family} not masked whole in: ${text.slice(0, 40)}`).toBeDefined();
        expect(hit!.kind).toBe('api_key');
        expect(out).not.toContain(token.slice(-12));
      }
    }
  });

  it('has a fake token for every family in the pattern table', () => {
    const covered = new Set(FAKE_TOKENS.map((t) => t.family));
    for (const { name } of TOKEN_PREFIX_PATTERNS) expect(covered, `no fixture for ${name}`).toContain(name);
  });

  it('closes the verified gap on 9f8c8c4: Anthropic, fine-grained GitHub, GitHub OAuth, and real-shape OpenAI keys', () => {
    const find = (f: string) => FAKE_TOKENS.filter((t) => t.family === f).map((t) => t.token);
    const gap = [...find('anthropic'), ...find('github-fine-grained'), ...find('openai-named')];
    gap.push(FAKE_TOKENS.find((t) => t.token.startsWith('gh' + 'o_'))!.token);
    for (const token of gap) expect(applyTier1(`x ${token} y`).text).toBe('x [API_KEY_1] y');
  });

  it('leaves prefix-sharing prose and identifiers alone (near misses)', () => {
    for (const text of NEAR_MISSES) {
      const keys = applyTier1(text).replacements.filter((r) => r.kind === 'api_key');
      expect(keys.map((r) => r.original), text).toEqual([]);
    }
  });

  it('does not stop at a trailing sentence dot inside a GitLab routable token, and drops the dot itself', () => {
    const token = FAKE_TOKENS.find((t) => t.token.includes('.01.'))!.token;
    const { text } = applyTier1(`Rotate ${token}.`);
    expect(text).toBe('Rotate [API_KEY_1].');
  });

  it('uses fixtures that fail the GitHub and npm CRC32 checksum, so none is a validly issued shape', () => {
    const checksummed = FAKE_TOKENS.filter((t) => /^(?:gh[pousr]_|npm_)/.test(t.token));
    expect(checksummed.length).toBe(6);
    for (const { token } of checksummed) {
      const cut = token.indexOf('_') + 1;
      expect(passesIssuerChecksum(token.slice(0, cut), token.slice(cut)), token.slice(0, cut)).toBe(false);
    }
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

  it('degrades LOUDLY when the model returns non-JSON (no silent passthrough)', async () => {
    const babbling: OllamaClient = {
      available: async () => true,
      generateJson: async () => 'Sure! Here are the entities I found: Bob and Acme.',
    };
    const result = await redact('Meet Bob Henderson at Acme Corp.', { tier: 2 }, babbling);
    expect(result.tier2Degraded).toBe(true); // must NOT report success
    expect(result.redacted).toContain('Bob Henderson'); // names passed through — flagged
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
