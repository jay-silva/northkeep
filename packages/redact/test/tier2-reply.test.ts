import { describe, expect, it } from 'vitest';
import type { OllamaClient } from '@northkeep/librarian';
import { redact } from '../src/index.js';
import { readNerReply } from '../src/ner-reply.js';

/**
 * ADR 0060 code review, kill shot: a real llama3.2:3b answered with the
 * "entities" key twice. JSON.parse kept only the last one, the found name was
 * dropped, and "Bob Henderson" went out while the call reported Tier 2 (8 of
 * 10 real runs). These are the review's exact raw replies.
 */
const TEXT = 'Call Bob Henderson, SSN 123-45-6789, at 774-555-0134\n';
const REAL_DUPLICATE_ORG =
  '{"entities":[{"text":"Bob Henderson","kind":"person"}],"entities":[{"text":"[PHONE_1]","kind":"org"},{"text":"[SSN_1]","kind":"location"}]}';
const REAL_DUPLICATE_LOCATION =
  '{"entities":[{"text":"Bob Henderson","kind":"person"}],"entities":[{"text":"[PHONE_1]","kind":"location"},{"text":"[SSN_1]","kind":"location"}]}';
const REAL_SINGLE =
  '{"entities":[{"text":"Bob Henderson","kind":"person"},{"text":"[PHONE_1]","kind":"location"},{"text":"[SSN_1]","kind":"location"}]}';

function model(reply: string): OllamaClient {
  return { available: async () => true, generateJson: async () => reply } as unknown as OllamaClient;
}

describe('ADR 0060 kill shot: the name model reply is read in full', () => {
  for (const [label, reply] of [['duplicate key, org', REAL_DUPLICATE_ORG], ['duplicate key, location', REAL_DUPLICATE_LOCATION], ['single key', REAL_SINGLE]] as const) {
    for (const tier of [2, 3] as const) {
      it(`K1: ${label} at Tier ${tier} masks Bob Henderson`, async () => {
        const r = await redact(TEXT, { tier }, model(reply));
        expect(r.redacted).not.toContain('Henderson');
        expect(r.tier2Degraded).toBe(false);
        expect(r.tierApplied).toBe(tier);
      });
    }
  }

  it('K2: every entity from every "entities" occurrence is kept, and a repeated "text" key is two spans', () => {
    expect(readNerReply(REAL_DUPLICATE_ORG).map((e) => e.text)).toEqual(['Bob Henderson', '[PHONE_1]', '[SSN_1]']);
    expect(readNerReply('{"entities":[{"text":"Ann Lee","text":"Bo Park","kind":"person"}]}').map((e) => e.text)).toEqual(['Ann Lee', 'Bo Park']);
  });

  it('K3: a reply that cannot be fully accounted for is a failure, never a clean pass', async () => {
    for (const reply of [
      '{"entities":[{"text":"Bob Henderson","kind":"person"}],"people":["Bob Henderson"]}',
      '{"entities":[{"text":"Bob Henderson"}]} trailing words',
      '{"entities":{"text":"Bob Henderson"}}',
      '{"entities":[{"name":"Bob Henderson"}]}',
      '{"entities":[{"text":42}]}',
      '{"result":[]}',
      '[{"text":"Bob Henderson"}]',
      '{"entities":[',
    ]) {
      expect(() => readNerReply(reply), reply).toThrow();
      const t2 = await redact(TEXT, { tier: 2 }, model(reply));
      expect(t2.tier2Degraded, reply).toBe(true);
      expect(t2.tierApplied, reply).toBe(1);
      const t3 = await redact(TEXT, { tier: 3 }, model(reply));
      expect(t3.tier2Degraded, reply).toBe(true);
    }
  });

  it('K4: an empty or whitespace-padded clean reply is still accepted', async () => {
    expect(readNerReply(' {"entities":[]}\n')).toEqual([]);
    const r = await redact('Nothing to see here.', { tier: 2 }, model('\n{ "entities" : [ ] }\n'));
    expect(r.tier2Degraded).toBe(false);
  });
});

describe('ADR 0060 code review recheck: names under an unexpected key', () => {
  const NESTED = '{"entities":[{"text":"x","entities":[{"text":"Bob Henderson","kind":"person"}]}]}';
  const OTHER_KEY = '{"entities":[{"text":"x","name":"Bob Henderson"}]}';

  it('R2: a nested "entities" list or a name under another key fails the reply; Tier 2 refuses, Tier 3 is deterministic only', async () => {
    for (const reply of [NESTED, OTHER_KEY]) {
      expect(() => readNerReply(reply), reply).toThrow();
      const t2 = await redact(TEXT, { tier: 2 }, model(reply));
      expect(t2.tier2Degraded, reply).toBe(true);
      expect(t2.tierApplied, reply).toBe(1);
      const t3 = await redact(TEXT, { tier: 3 }, model(reply));
      expect(t3.tier2Degraded, reply).toBe(true);
      expect(t3.tierApplied, reply).toBe(3);
    }
  });
});

