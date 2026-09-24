import { describe, expect, it } from 'vitest';
import type { OllamaClient } from '@northkeep/librarian';
import {
  applyTier1,
  createRedactionSession,
  maskContentInSession,
  maskScopeInSession,
  redact,
} from '../src/index.js';

const noModel = null as unknown as OllamaClient;

describe('ADR 0060 1.3: one tagged numbering per review run', () => {
  it('C3: two different emails in two calls get two tokens; the same email twice gets one', async () => {
    const session = createRedactionSession(['a', 'b'], () => 'k7q2');
    const a = await maskContentInSession(session, 'mail bob@example.com', 1, noModel);
    const b = await maskContentInSession(session, 'mail carol@example.com and bob@example.com', 1, noModel);
    expect(a.wire).toBe('mail [k7q2:EMAIL_1]');
    expect(b.wire).toBe('mail [k7q2:EMAIL_2] and [k7q2:EMAIL_1]');
    expect([...b.issued].sort()).toEqual(['[k7q2:EMAIL_1]', '[k7q2:EMAIL_2]']);
    // Old code: two separate calls both number from 1 and collide.
    expect(applyTier1('carol@example.com').text).toBe(applyTier1('bob@example.com').text);
  });

  it('C3: two different 1948 dates get two tokens at Tier 3', async () => {
    const session = createRedactionSession([''], () => 'k7q2');
    const r = await maskContentInSession(session, 'Mom born 03/15/1948, Dad born 04/02/1948', 3, noModel);
    expect(r.wire).toContain('[k7q2:DATE_1948_1]');
    expect(r.wire).toContain('[k7q2:DATE_1948_2]');
    expect(r.wire).not.toMatch(/1948,|\/1948/);
  });

  it('C20 (redact side): literal placeholder text is plain text, never a token or an original', async () => {
    const stored = ['Old note: [EMAIL_1] is my ex\'s address; never reply.', "My therapist's email is t.reyes@clinic-example.org."];
    const session = createRedactionSession(stored, () => 'k7q2');
    const m1 = await maskContentInSession(session, stored[0]!, 1, noModel);
    const m2 = await maskContentInSession(session, stored[1]!, 1, noModel);
    expect(m1.wire).toBe(stored[0]);
    expect(m1.issued.size).toBe(0);
    expect(m2.wire).toBe("My therapist's email is [k7q2:EMAIL_1].");
  });

  it('C21: the run tag is redrawn while stored text contains it, in any case', () => {
    const draws = ['k7q2', 'ab12', 'zz99'];
    const session = createRedactionSession(['see [K7Q2:EMAIL_1]', 'and [ab12:x'], () => draws.shift()!);
    expect(session.tag).toBe('zz99');
    expect(() => createRedactionSession(['[aaaa:'], () => 'aaaa')).toThrow(/absent/);
  });

  it('F6/F7: a collection name gets Tier 1 at every tier, and dates to year at Tier 3 only', () => {
    const session = createRedactionSession([''], () => 'k7q2');
    expect(maskScopeInSession(session, 'patient:508-555-0142', 1).wire).toBe('patient:[k7q2:PHONE_1]');
    expect(maskScopeInSession(session, 'visit:2026-10-03', 2).wire).toBe('visit:2026-10-03');
    expect(maskScopeInSession(session, 'visit:2026-10-03', 3).wire).toBe('visit:[k7q2:DATE_2026_1]');
  });

  it('C3g: without a session, redact() output is unchanged', async () => {
    const r = await redact('Reach bob@example.com, born 03/15/1948', { tier: 3 }, noModel);
    expect(r.redacted).toBe('Reach [EMAIL_1], born [DATE-1948]');
  });
});

describe('ADR 0060 code review F2: detect across the run, then render', () => {
  it('A-W2 (redact side): a name found in a later memory is masked in an earlier one too', async () => {
    const { detectContentInSession, renderInSession } = await import('../src/index.js');
    // Finds the name only in the sentence that mentions the clinic.
    const clinicOnly = {
      available: async () => true,
      generateJson: async (prompt: string) => {
        const text = prompt.slice(prompt.lastIndexOf('\nText:\n') + 7);
        return JSON.stringify({ entities: text.includes('clinic') && text.includes('Zyler Okonkwo') ? [{ text: 'Zyler Okonkwo', kind: 'person' }] : [] });
      },
    } as unknown as OllamaClient;
    const a = 'Zyler Okonkwo called about the lease renewal.';
    const b = 'Met Zyler Okonkwo at the clinic on Tuesday.';
    const session = createRedactionSession([a, b], () => 'k7q2');
    await detectContentInSession(session, a, 2, clinicOnly);
    await detectContentInSession(session, b, 2, clinicOnly);
    expect(renderInSession(session, a).wire).toBe('[k7q2:PERSON_1] called about the lease renewal.');
    expect(renderInSession(session, b).wire).toBe('Met [k7q2:PERSON_1] at the clinic on Tuesday.');
  });

  it('PLACEHOLDER_LABELS covers every kind the redactor can emit', async () => {
    const { PLACEHOLDER_LABELS } = await import('../../librarian/src/reviewRestore.js');
    const kinds = ['email', 'phone', 'ssn', 'credit_card', 'ip', 'api_key', 'iban', 'record_id', 'gps', 'zip', 'address', 'person', 'org', 'location', 'date'];
    for (const k of kinds) expect(PLACEHOLDER_LABELS, k).toContain(k.toUpperCase());
    expect(PLACEHOLDER_LABELS).toContain('PLACE');
  });
});
