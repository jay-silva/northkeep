import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { MemoryEntry } from '@northkeep/core';
import {
  createRedactionSession,
  maskContentInSession,
  maskScopeInSession,
  type RedactionSession,
} from '../../redact/src/index.js';
import { formatReviewPrompt, runReviewPass, type ReviewOutbound } from '../src/review.js';
import { restoreReviewReply, type ReviewPackHandle } from '../src/reviewRestore.js';
import { validateProposals } from '../src/reviewSchema.js';

/**
 * ADR 0060 1.4: restoring a cloud review's reply. The packs are masked with
 * the real redaction session, so these tests run what the adapter sends.
 */

const ID = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

function entry(n: number, content: string, scope = 'personal'): MemoryEntry {
  return {
    id: ID(n), type: 'semantic', content, scope, source: 'cli', source_model: null, confidence: 1,
    created_at: '2026-09-01T10:00:00.000Z', valid_from: null, superseded_at: null, superseded_by: null,
    forgotten_at: null, prev_hash: '', entry_hash: '', metadata: null,
  };
}

/** Mask a pack the way the adapter does and build the handle it would hand out. */
async function prepare(session: RedactionSession, pack: MemoryEntry[], tier: 1 | 2 | 3 = 1): Promise<{ handle: ReviewPackHandle; wire: string[] }> {
  const tokens = new Set<string>();
  const wire: string[] = [];
  for (const e of pack) {
    const c = await maskContentInSession(session, e.content, tier, null);
    const s = maskScopeInSession(session, e.scope, tier);
    for (const t of [...c.issued, ...s.issued]) tokens.add(t);
    wire.push(c.wire);
  }
  const tokenInfo = new Map([...tokens].map((t) => {
    const info = session.tokens.get(t)!;
    return [t, { original: info.original, nameKind: info.nameKind }] as const;
  }));
  return { handle: { tag: session.tag, tokens, tokenInfo }, wire };
}

function reply(proposals: unknown[]): unknown {
  return { proposals };
}

function stale(target: MemoryEntry, quote: string, proposed: string, cite: MemoryEntry[] = [target]): unknown {
  return {
    kind: 'stale', entry_ids: cite.map((e) => e.id), quotes: [{ entry_id: target.id, quote }],
    explanation: 'x', target_entry_id: target.id, proposed_content: proposed, question: null,
  };
}

describe('ADR 0060 1.4: quotes and restoration', () => {
  it('C4: a quote containing a token validates against stored text and keeps the stored span', async () => {
    const m = entry(1, 'Email mom.h+old@example.com; Dad born 04/02/1948, Mom born 03/15/1948');
    const session = createRedactionSession([m.content], () => 'k7q2');
    const { handle, wire } = await prepare(session, [m], 3);
    expect(wire[0]).toContain('[k7q2:DATE_1948_1]');
    expect(wire[0]).toContain('[k7q2:DATE_1948_2]');
    const quote = 'Dad born [k7q2:DATE_1948_1]';
    const restored = restoreReviewReply(reply([{
      kind: 'question', entry_ids: [m.id, m.id], quotes: [{ entry_id: m.id, quote }], explanation: 'x',
      target_entry_id: null, proposed_content: null, question: 'Which date?',
    }]), [m], handle);
    const q = ((restored.parsed as { proposals: Array<{ quotes: Array<{ quote: string }> }> }).proposals[0]!).quotes[0]!;
    expect(q.quote).toBe('Dad born 04/02/1948');
    expect(m.content.includes(q.quote)).toBe(true);
  });

  it('C4: a lowercased pseudonym original still matches the stored spelling', async () => {
    const m = entry(1, 'Donna Keller owes me $40.');
    const session = createRedactionSession([m.content], () => 'k7q2');
    session.tokenFor({ placeholder: 'Person-1', original: 'donna keller', kind: 'person' });
    const token = [...session.tokens.keys()][0]!;
    const handle: ReviewPackHandle = { tag: 'k7q2', tokens: new Set([token]), tokenInfo: new Map([[token, { original: 'donna keller', nameKind: true }]]) };
    const out = restoreReviewReply(reply([stale(m, `${token} owes me $40.`, `${token} paid me back.`)]), [m], handle);
    const p = (out.parsed as { proposals: Array<{ quotes: Array<{ quote: string }>; proposed_content: string }> }).proposals[0]!;
    expect(p.quotes[0]!.quote).toBe('Donna Keller owes me $40.');
    expect(p.proposed_content).toBe('Donna Keller paid me back.');
  });

  it('C5: proposed_content is restored including Tier-1 values; unmapped untagged placeholders drop', async () => {
    const m = entry(1, 'Reach me at old@example.com.');
    const session = createRedactionSession([m.content], () => 'k7q2');
    const { handle } = await prepare(session, [m]);
    const ok = restoreReviewReply(reply([stale(m, 'Reach me at [k7q2:EMAIL_1].', 'Reach me at [k7q2:EMAIL_1] on weekdays.')]), [m], handle);
    expect((ok.parsed as { proposals: Array<{ proposed_content: string }> }).proposals[0]!.proposed_content)
      .toBe('Reach me at old@example.com on weekdays.');
    const bad = restoreReviewReply(reply([stale(m, 'Reach me at [k7q2:EMAIL_1].', 'Reach me at [EMAIL_1].')]), [m], handle);
    expect(bad.drops).toEqual({ unmapped_placeholder: 1 });
    expect((bad.parsed as { proposals: unknown[] }).proposals).toHaveLength(0);
  });

  it('C5b: explanation and question restore this pack\'s tokens and keep others visible, without dropping', async () => {
    const m = entry(1, 'Reach me at old@example.com.');
    const session = createRedactionSession([m.content], () => 'k7q2');
    const { handle } = await prepare(session, [m]);
    const out = restoreReviewReply(reply([{
      kind: 'question', entry_ids: [m.id, m.id], quotes: [{ entry_id: m.id, quote: 'Reach me' }],
      explanation: 'About [k7q2:EMAIL_1] and [k7q2:EMAIL_9].', target_entry_id: null, proposed_content: null,
      question: 'Still [k7q2:EMAIL_1]?',
    }]), [m], handle);
    const p = (out.parsed as { proposals: Array<{ explanation: string; question: string }> }).proposals[0]!;
    expect(p.explanation).toBe('About old@example.com and [k7q2:EMAIL_9].');
    expect(p.question).toBe('Still old@example.com?');
    expect(out.drops).toEqual({});
  });

  it('C5c: restoration runs on parsed leaves, so an original with a quote mark and a backslash round-trips', async () => {
    // Built at runtime and fake, never a committed key shape (ADR 0059 Decision 7).
    const fakeKey = ['sk', 'live', 'FakeTestKey0'.repeat(2)].join('_');
    const m = entry(1, `Key: "${fakeKey}" \\ end`);
    const session = createRedactionSession([m.content], () => 'k7q2');
    const { handle, wire } = await prepare(session, [m]);
    expect(wire[0]).not.toContain(fakeKey);
    const token = [...handle.tokens][0]!;
    const raw = JSON.parse(JSON.stringify(reply([stale(m, `Key: "${token}"`, `Key: "${token}" (rotated) \\ end`)])));
    const out = restoreReviewReply(raw, [m], handle);
    expect((out.parsed as { proposals: Array<{ proposed_content: string }> }).proposals[0]!.proposed_content)
      .toBe(`Key: "${fakeKey}" (rotated) \\ end`);
  });
});

describe('ADR 0060 F1, F2: literals, foreign tokens and cited originals', () => {
  it('C20 (A1): the therapist\'s email is never spliced into the note about the ex', async () => {
    const m1 = entry(1, "Old note: [EMAIL_1] is my ex's address; never reply.", 'family');
    const m2 = entry(2, "My therapist's email is t.reyes@clinic-example.org.", 'health');
    const session = createRedactionSession([m1.content, m2.content], () => 'k7q2');
    const { handle, wire } = await prepare(session, [m1, m2]);
    expect(wire).toEqual([m1.content, "My therapist's email is [k7q2:EMAIL_1]."]);
    // An honest copy of m1's own text keeps its literal placeholder.
    const honest = restoreReviewReply(reply([stale(m1, "Old note: [EMAIL_1] is my ex's address", "Old note: [EMAIL_1] is my ex's address; never reply.", [m1, m2])]), [m1, m2], handle);
    expect((honest.parsed as { proposals: Array<{ proposed_content: string }> }).proposals[0]!.proposed_content)
      .not.toContain('t.reyes');
    // The real token, citing only m1, cannot bring m2's value in.
    const splice = restoreReviewReply(reply([stale(m1, "Old note: [EMAIL_1] is my ex's address", "Old note: [k7q2:EMAIL_1] is my ex's address.")]), [m1, m2], handle);
    expect(splice.drops).toEqual({ uncited_original: 1 });
  });

  it('C20 (A3): a literal Person-1 stays literal at Tier 3 and is never restored to a real name', async () => {
    const m1 = entry(1, 'Person-1 owes me $40 (still unpaid).');
    const m2 = entry(2, 'Dr. Donna Keller is my oncologist.');
    const session = createRedactionSession([m1.content, m2.content], () => 'k7q2');
    session.pseudonyms['donna keller'] = 'Person-1';
    const { handle, wire } = await prepare(session, [m1, m2], 2);
    expect(wire[0]).toBe(m1.content);
    const out = restoreReviewReply(reply([stale(m1, 'Person-1 owes me $40', 'Person-1 owes me $40 (still unpaid).')]), [m1, m2], handle);
    const text = (out.parsed as { proposals: Array<{ proposed_content: string }> }).proposals[0]!.proposed_content;
    expect(text).toBe('Person-1 owes me $40 (still unpaid).');
    expect(text).not.toContain('Donna');
  });

  it('C20 (A4): a memory holding a literal placeholder and a real email restores only the real one', async () => {
    const m = entry(1, 'Earlier masked: [EMAIL_1]. Real: zed@example.net');
    const session = createRedactionSession([m.content], () => 'k7q2');
    const { handle, wire } = await prepare(session, [m]);
    expect(wire[0]).toBe('Earlier masked: [EMAIL_1]. Real: [k7q2:EMAIL_1]');
    const out = restoreReviewReply(reply([stale(m, 'Earlier masked: [EMAIL_1]. Real: [k7q2:EMAIL_1]', 'Earlier masked: [EMAIL_1]. Real: [k7q2:EMAIL_1]')]), [m], handle);
    expect((out.parsed as { proposals: Array<{ proposed_content: string }> }).proposals[0]!.proposed_content)
      .toBe('Earlier masked: [EMAIL_1]. Real: zed@example.net');
  });

  it('C22 (A2): a reply for pack B naming a token only pack A was shown is dropped as foreign', async () => {
    const a = entry(1, 'Health contact alice.h@private-example.com', 'health');
    const b = entry(2, 'Work contact bob@work-example.com', 'work');
    const session = createRedactionSession([a.content, b.content], () => 'k7q2');
    await prepare(session, [a]);
    const { handle: hb } = await prepare(session, [b]);
    expect([...hb.tokens]).toEqual(['[k7q2:EMAIL_2]']);
    const out = restoreReviewReply(reply([stale(b, 'Work contact [k7q2:EMAIL_2]', 'Work contact for invoices: [k7q2:EMAIL_1]')]), [b], hb);
    expect(out.drops).toEqual({ foreign_placeholder: 1 });
    const minted = restoreReviewReply(reply([stale(b, 'Work contact [k7q2:EMAIL_2]', 'Work contact: [k7q2:EMAIL_9]')]), [b], hb);
    expect(minted.drops).toEqual({ foreign_placeholder: 1 });
  });

  it('C23: an original seen only in a scope line can never be restored into a suggestion', async () => {
    const m = entry(1, 'Call back about the results.', 'patient:508-555-0142');
    const session = createRedactionSession([m.content, m.scope], () => 'k7q2');
    const { handle } = await prepare(session, [m]);
    expect(handle.tokens.has('[k7q2:PHONE_1]')).toBe(true);
    const out = restoreReviewReply(reply([stale(m, 'Call back about the results.', 'Call [k7q2:PHONE_1] about the results.')]), [m], handle);
    expect(out.drops).toEqual({ uncited_original: 1 });
  });

  it('C34: variant forms of a run token drop the suggestion', async () => {
    const m = entry(1, 'Reach me at old@example.com.');
    const session = createRedactionSession([m.content], () => 'k7q2');
    const { handle } = await prepare(session, [m]);
    for (const variant of ['[K7Q2:EMAIL_1]', 'k7q2:EMAIL_1', '[k7q2:email_1]', '[k7q2:EMAIL_1']) {
      const out = restoreReviewReply(reply([stale(m, 'Reach me', `Reach me at ${variant}.`)]), [m], handle);
      expect(out.drops, variant).toEqual({ foreign_placeholder: 1 });
    }
  });

  it('C33: the prompt example token is never in a pack\'s set, so it is never restored', async () => {
    const m = entry(1, 'Reach me at old@example.com.');
    const session = createRedactionSession([m.content], () => 'k7q2');
    const { handle } = await prepare(session, [m]);
    expect(handle.tokens.has('[k7q2:EMAIL_0]')).toBe(false);
    expect(formatReviewPrompt([m], { placeholderTag: 'k7q2' })).toContain('[k7q2:EMAIL_0]');
    const out = restoreReviewReply(reply([{
      kind: 'question', entry_ids: [m.id, m.id], quotes: [{ entry_id: m.id, quote: 'Reach me' }],
      explanation: 'Like [k7q2:EMAIL_0].', target_entry_id: null, proposed_content: null, question: 'q',
    }]), [m], handle);
    expect((out.parsed as { proposals: Array<{ explanation: string }> }).proposals[0]!.explanation).toBe('Like [k7q2:EMAIL_0].');
  });

  it('the merge case is accepted: a proposal citing both memories may carry one\'s value into the other', async () => {
    const m1 = entry(1, "Old note: x is my ex's address.");
    const m2 = entry(2, 'The ex now uses new@example.com.');
    const session = createRedactionSession([m1.content, m2.content], () => 'k7q2');
    const { handle } = await prepare(session, [m1, m2]);
    const merge = stale(m1, "Old note: x is my ex's address.", "Old note: [k7q2:EMAIL_1] is my ex's address.", [m1, m2]) as { quotes: unknown[] };
    merge.quotes.push({ entry_id: m2.id, quote: 'The ex now uses [k7q2:EMAIL_1].' });
    const out = restoreReviewReply(reply([merge]), [m1, m2], handle);
    expect((out.parsed as { proposals: Array<{ proposed_content: string }> }).proposals[0]!.proposed_content)
      .toBe("Old note: new@example.com is my ex's address.");
    expect(validateProposals(out.parsed, [m1, m2]).proposals).toHaveLength(1);
  });
});

describe('runReviewPass with an outbound adapter', () => {
  it('prepares every pack before the first send and restores each reply against its own handle', async () => {
    const m1 = entry(1, 'Mom lives at old@example.com.');
    const m2 = entry(2, 'Mom moved; mail new@example.com.');
    const session = createRedactionSession([m1.content, m2.content], () => 'k7q2');
    const events: string[] = [];
    const outbound: ReviewOutbound = {
      async prepare(packs) {
        events.push(`prepare ${packs.length}`);
        const out: ReviewPackHandle[] = [];
        for (const pack of packs) out.push((await prepare(session, pack)).handle);
        return out;
      },
      async send(handle) {
        events.push('send');
        expect(handle.tokens.size).toBe(2);
        const p = stale(m1, 'Mom lives at [k7q2:EMAIL_1].', 'Mom lives at [k7q2:EMAIL_2].', [m1, m2]) as { quotes: unknown[] };
        p.quotes.push({ entry_id: m2.id, quote: 'mail [k7q2:EMAIL_2]' });
        return JSON.stringify(reply([p]));
      },
    };
    const result = await runReviewPass([m1, m2], outbound, { embed: async () => [1, 0, 0] });
    expect(events).toEqual(['prepare 1', 'send']);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]!.proposed_content).toBe('Mom lives at new@example.com.');
    expect(result.proposals[0]!.quotes[0]!.quote).toBe('Mom lives at old@example.com.');
  });
});

describe('ADR 0060 1.8: the local review path is unchanged', () => {
  it('C8g: the prompt sent to a local model is byte-identical to the pre-0060 prompt', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const expected = fs.readFileSync(path.join(here, 'fixtures', 'local-review-prompt.txt'), 'utf8');
    const m1 = entry(1, 'Mom lives in Boston.');
    const m2 = entry(2, 'Mom moved to Denver in 2025.');
    let captured: string | null = null;
    await runReviewPass([m1, m2], { generateJson: async (p: string) => { captured = p; return '{"proposals":[]}'; } }, { embed: async () => [1, 0, 0] });
    expect(captured).toBe(expected);
  });
});

describe('ADR 0060 code review round 1', () => {
  it('A-W1 (F1): a fabricated quote from another memory lends none of its values', async () => {
    const m1 = entry(1, 'Therapist email is therapist@clinic.example.com for appointments.');
    const m2 = entry(2, 'The ex lives on Elm Street and never calls.');
    const session = createRedactionSession([m1.content, m2.content], () => 'k7q2');
    const { handle } = await prepare(session, [m1, m2]);
    const hostile = {
      kind: 'stale', entry_ids: [m2.id], target_entry_id: m2.id, explanation: 'x', question: null,
      quotes: [{ entry_id: m2.id, quote: 'The ex lives on Elm Street' }, { entry_id: m1.id, quote: 'no such text in m1' }],
      proposed_content: 'The ex can be reached at [k7q2:EMAIL_1].',
    };
    const out = restoreReviewReply(reply([hostile]), [m1, m2], handle);
    expect(out.drops).toEqual({ uncited_original: 1 });
    expect(JSON.stringify(out.parsed)).not.toContain('therapist@clinic.example.com');
    // An id listed in entry_ids without a validated quote lends nothing either.
    const listed = { ...hostile, entry_ids: [m2.id, m1.id], quotes: [hostile.quotes[0]] };
    expect(restoreReviewReply(reply([listed]), [m1, m2], handle).drops).toEqual({ uncited_original: 1 });
  });

  it('A-W1 control: the same value with a validated quote from its memory is restored', async () => {
    const m1 = entry(1, 'Therapist email is therapist@clinic.example.com for appointments.');
    const m2 = entry(2, 'The ex lives on Elm Street and never calls.');
    const session = createRedactionSession([m1.content, m2.content], () => 'k7q2');
    const { handle } = await prepare(session, [m1, m2]);
    const ok = {
      kind: 'stale', entry_ids: [m2.id, m1.id], target_entry_id: m2.id, explanation: 'x', question: null,
      quotes: [{ entry_id: m2.id, quote: 'The ex lives on Elm Street' }, { entry_id: m1.id, quote: 'Therapist email is [k7q2:EMAIL_1]' }],
      proposed_content: 'The ex can be reached at [k7q2:EMAIL_1].',
    };
    const out = restoreReviewReply(reply([ok]), [m1, m2], handle);
    expect((out.parsed as { proposals: Array<{ proposed_content: string }> }).proposals[0]!.proposed_content)
      .toBe('The ex can be reached at therapist@clinic.example.com.');
  });

  it('Claims-review wire case: tag-stripped and other mis-copied placeholders never reach a suggestion', async () => {
    const m = entry(1, 'Family note number 1. Born 03/15/1948, mail mom@example.com.');
    const session = createRedactionSession([m.content], () => 'k7q2');
    const { handle } = await prepare(session, [m], 3);
    for (const proposed of [
      'Family note: born [DATE_1948_1].',
      'Family note: mail EMAIL_1.',
      'Family note: mail <EMAIL_1>.',
      'Family note: mail [k7q2 EMAIL_1].',
      'Family note: born [DATE-1948].',
      'Family note: born DATE_1948_1 and [REDACTED].',
      'Family note: mail [email_1].',
    ]) {
      const out = restoreReviewReply(reply([stale(m, 'Family note number 1.', proposed)]), [m], handle);
      expect((out.parsed as { proposals: unknown[] }).proposals, proposed).toHaveLength(0);
    }
    const prose = restoreReviewReply(reply([stale(m, 'Family note number 1.', 'Family note: date of birth and email are on file.')]), [m], handle);
    expect((prose.parsed as { proposals: unknown[] }).proposals).toHaveLength(1);
  });
});

describe('ADR 0060 code review recheck', () => {
  async function pair() {
    const m1 = entry(1, 'Therapist email is therapist@clinic.example.com for appointments.');
    const m2 = entry(2, 'The ex lives on Elm Street now.');
    const session = createRedactionSession([m1.content, m2.content], () => 'k7q2');
    const { handle } = await prepare(session, [m1, m2]);
    const splice = (m1Quote: string) => ({
      kind: 'stale', entry_ids: [m2.id], target_entry_id: m2.id, explanation: 'x', question: null,
      quotes: [{ entry_id: m2.id, quote: 'The ex lives on Elm Street now' }, { entry_id: m1.id, quote: m1Quote }],
      proposed_content: 'The ex can be reached at [k7q2:EMAIL_1].',
    });
    return { m1, m2, handle, splice };
  }

  it('R1a (F1): a validated quote of memory 1\'s own placeholder does not cite memory 1 when only memory 2 is listed', async () => {
    const { m1, m2, handle, splice } = await pair();
    const out = restoreReviewReply(reply([splice('[k7q2:EMAIL_1]')]), [m1, m2], handle);
    expect(out.drops).toEqual({ uncited_original: 1 });
    expect(JSON.stringify(out.parsed)).not.toContain('therapist@clinic.example.com');
  });

  it('R1b (F1): one real character quoted from memory 1 does not cite memory 1 when only memory 2 is listed', async () => {
    const { m1, m2, handle, splice } = await pair();
    const out = restoreReviewReply(reply([splice('f')]), [m1, m2], handle);
    expect(out.drops).toEqual({ uncited_original: 1 });
    expect(JSON.stringify(out.parsed)).not.toContain('therapist@clinic.example.com');
  });

  it('R3: prose that only looks like a placeholder label is kept', async () => {
    const m = entry(1, 'Family note number 1.');
    const session = createRedactionSession([m.content], () => 'k7q2');
    const { handle } = await prepare(session, [m]);
    for (const proposed of [
      'Mail goes to the Cape office (ZIP 02532).',
      'The server is ip-10-0-0-12 in the rack.',
      'Reach her by phone (email) instead.',
    ]) {
      const out = restoreReviewReply(reply([stale(m, 'Family note number 1.', proposed)]), [m], handle);
      expect((out.parsed as { proposals: Array<{ proposed_content: string }> }).proposals[0]?.proposed_content, proposed).toBe(proposed);
    }
  });
});

