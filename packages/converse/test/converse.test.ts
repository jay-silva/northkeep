import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryEntry, RememberInput, RetrieveOptions, ScoredEntry, ListFilter } from '@northkeep/core';
import { redact, type Replacement } from '@northkeep/redact';
import type { CallLogEntry } from '@northkeep/mcp-server';
import {
  addEndpoint,
  classifyEndpoint,
  createSession,
  getEndpointKey,
  listEndpoints,
  normalizeBaseUrl,
  providersPath,
  removeEndpoint,
  runTurn,
  TurnError,
  type ChatMessage,
  type ChatOptions,
  type ModelProvider,
} from '../src/index.js';

// ---------- host → tier classifier ----------

describe('classifyEndpoint', () => {
  const privateCases = [
    'http://127.0.0.1:11434',
    'http://127.8.9.10/',
    'http://localhost:1234',
    'http://models.localhost/',
    'http://user:pass@127.0.0.1:8080/v1', // userinfo must not confuse the host
    'http://2130706433/', // integer IPv4 — WHATWG canonicalizes to 127.0.0.1
    'http://[::1]:8080',
    'http://[0:0:0:0:0:0:0:1]/', // uncompressed loopback
    'http://[::ffff:192.168.1.7]/', // IPv4-mapped private
    'http://[fd00::1]/', // unique-local
    'http://[fe80::1]/', // link-local
    'http://10.0.0.5:8000',
    'http://172.16.0.1/',
    'http://172.31.255.254/',
    'http://192.168.1.10:5000',
    'http://169.254.10.10/',
    'http://mini.local:11434',
  ];
  for (const url of privateCases) {
    it(`classifies ${url} as private`, () => {
      expect(classifyEndpoint(url).tier).toBe('private');
    });
  }

  const boundedCases = [
    'https://api.openai.com/v1',
    'https://api.deepseek.com',
    'http://127.0.0.1.evil.com/', // public DNS name wearing a loopback mask
    'http://localhost.evil.com/',
    'http://mylocalhost.com/',
    'http://notreally.local.evil.com/',
    'http://8.8.8.8/',
    'http://172.32.0.1/', // just past RFC-1918 172.16/12
    'http://192.169.1.1/', // just past 192.168/16
    'http://[2001:4860:4860::8888]/',
    'http://[::ffff:8.8.8.8]/', // IPv4-mapped public
    'http://[::]/', // unspecified — fail closed
    'http://nas/', // bare single-label host — cannot prove it is local
  ];
  for (const url of boundedCases) {
    it(`classifies ${url} as bounded`, () => {
      expect(classifyEndpoint(url).tier).toBe('bounded');
    });
  }

  it('rejects non-http(s) and garbage', () => {
    expect(() => classifyEndpoint('ftp://127.0.0.1/')).toThrow(/http/);
    expect(() => classifyEndpoint('not a url')).toThrow(/valid endpoint/);
  });
});

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes and a trailing /v1', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:11434/')).toBe('http://127.0.0.1:11434');
    expect(normalizeBaseUrl('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com');
    expect(normalizeBaseUrl('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com');
  });
  it('rejects garbage', () => {
    expect(() => normalizeBaseUrl('battlestar')).toThrow();
  });
});

// ---------- the turn loop, with fakes ----------

function makeEntry(partial: Partial<MemoryEntry> & { id: string; content: string }): MemoryEntry {
  return {
    type: 'semantic',
    scope: 'personal',
    source: 'test',
    source_model: null,
    confidence: 0.9,
    created_at: '2026-07-01T00:00:00.000Z',
    valid_from: null,
    superseded_at: null,
    superseded_by: null,
    forgotten_at: null,
    prev_hash: '0'.repeat(64),
    entry_hash: '1'.repeat(64),
    metadata: null,
    ...partial,
  };
}

class FakeVault {
  commits = 0;
  remembered: RememberInput[] = [];
  constructor(private entries: MemoryEntry[]) {}
  retrieve(_query: string, _options?: RetrieveOptions): ScoredEntry[] {
    return this.entries.map((entry) => ({ entry, score: 1 }));
  }
  list(_filter?: ListFilter): MemoryEntry[] {
    return this.entries;
  }
  commit(inputs: RememberInput[]): MemoryEntry[] {
    this.commits += 1;
    return inputs.map((input) => {
      this.remembered.push(input);
      return makeEntry({ id: `new-${this.remembered.length}`, content: input.content });
    });
  }
}

class FakeProvider implements ModelProvider {
  readonly kind = 'openai-compatible' as const;
  received: ChatMessage[][] = [];
  constructor(
    readonly baseUrl: string,
    private reply: string,
  ) {}
  async chat(messages: ChatMessage[], options: ChatOptions): Promise<string> {
    this.received.push(messages);
    options.onToken?.(this.reply);
    return this.reply;
  }
  async listModels(): Promise<string[]> {
    return ['fake-model'];
  }
}

/**
 * A fake redactor that mirrors the load-bearing behavior of real redact() for
 * ONE known name, "Bob Henderson":
 *   - 'replay-only'  → NER never runs; the name is masked ONLY if it is already
 *     in the pseudonym map (replay). Empty map → the name passes through in the
 *     clear (this is exactly the leak path the fix closes).
 *   - 'on' at tier ≥ 2 → NER discovers the name, records it in the shared map,
 *     and masks it to "Person-1". (Tier 1 has no name layer, like real redact.)
 * With { degraded: true } the NER model is "offline" (no Ollama): a Tier-2 'on'
 * call does NOT discover/mask the name and reports tier2Degraded (tierApplied
 * drops to 1) — the replay layer for an already-KNOWN name still works, exactly
 * like real redact when the model is down.
 * Every call is logged so a test can assert the nerMode a given message got.
 */
function makeNameRedactor(
  log: Array<{ text: string; nerMode: string; tier: number }>,
  opts: { degraded?: boolean } = {},
): typeof redact {
  return async (text, options = {}) => {
    const pseudonyms = options.pseudonyms ?? {};
    const tier = options.tier ?? 1;
    const nerMode = options.nerMode ?? 'on';
    log.push({ text, nerMode, tier });
    const replacements: Replacement[] = [];
    let out = text;
    const known = 'bob henderson' in pseudonyms;
    const degraded = opts.degraded === true && tier >= 2;
    if (known && out.includes('Bob Henderson')) {
      // Replay layer (both modes, deterministic — survives a downed model).
      const placeholder = pseudonyms['bob henderson']!;
      out = out.replaceAll('Bob Henderson', placeholder);
      replacements.push({ placeholder, original: 'Bob Henderson', tier: 2, kind: 'person', restorable: true });
    } else if (nerMode === 'on' && tier >= 2 && !degraded && out.includes('Bob Henderson')) {
      // NER discovery — unavailable when the model is degraded/offline.
      pseudonyms['bob henderson'] = 'Person-1';
      out = out.replaceAll('Bob Henderson', 'Person-1');
      replacements.push({ placeholder: 'Person-1', original: 'Bob Henderson', tier: 2, kind: 'person', restorable: true });
    }
    return {
      redacted: out,
      replacements,
      tierApplied: degraded ? 1 : tier === 3 ? 3 : tier >= 2 ? 2 : 1,
      tier2Degraded: degraded,
    };
  };
}

describe('runTurn', () => {
  const vaultEntries = [
    makeEntry({ id: 'aaaa1111-0000-0000-0000-000000000000', content: 'Jay takes his coffee black.' }),
  ];

  it('masks Tier-1 secrets before the provider sees them, and audits content-free', async () => {
    const provider = new FakeProvider('http://127.0.0.1:9999', 'Got it, noted.');
    const vault = new FakeVault(vaultEntries);
    const audits: CallLogEntry[] = [];
    const session = createSession();

    const result = await runTurn({
      message: 'My SSN is 219-09-9999 — remind me what coffee I like?',
      session,
      provider,
      model: 'fake-model',
      vault,
      redactTier: 1,
      distill: false,
      auditFn: (e) => audits.push(e),
    });

    const outbound = JSON.stringify(provider.received[0]);
    expect(outbound).not.toContain('219-09-9999');
    expect(outbound).toContain('[SSN_1]');
    expect(outbound).toContain('coffee black'); // memory context was injected
    expect(result.privacy).toBe('private');
    expect(result.tierApplied).toBe(1);
    expect(result.memoriesUsed.map((m) => m.id)).toEqual([vaultEntries[0]!.id]);

    expect(audits).toHaveLength(1);
    const row = JSON.stringify(audits[0]);
    expect(row).not.toContain('219-09-9999');
    expect(row).not.toContain('coffee'); // never content
    expect(audits[0]!.endpoint_host).toBe('127.0.0.1');
    expect(audits[0]!.privacy).toBe('private');
    expect(audits[0]!.result_ids).toEqual([vaultEntries[0]!.id]);
  });

  it('restores Tier-2 pseudonyms in the reply and keeps wire history in wire space', async () => {
    const provider = new FakeProvider('http://127.0.0.1:9999', 'Tell Person-1 the closing moved.');
    const vault = new FakeVault([]);
    const session = createSession();

    // Injected tier-2-capable redactor: pseudonymize then real Tier-1.
    const fakeRedact: typeof redact = async (text, options = {}) => {
      const pseudonyms = options.pseudonyms ?? {};
      pseudonyms['bob henderson'] = 'Person-1';
      const swapped = text.replace(/Bob Henderson/g, 'Person-1');
      const t1 = await redact(swapped, { tier: 1 });
      return {
        redacted: t1.redacted,
        replacements: [
          ...(text.includes('Bob Henderson')
            ? [{ placeholder: 'Person-1', original: 'Bob Henderson', tier: 2 as const, kind: 'person' as const, restorable: true }]
            : []),
          ...t1.replacements,
        ],
        tierApplied: 2 as const,
        tier2Degraded: false,
      };
    };

    const result = await runTurn({
      message: 'Email Bob Henderson about the closing.',
      session,
      provider,
      model: 'fake-model',
      vault,
      redactTier: 2,
      distill: false,
      redactFn: fakeRedact,
      auditFn: () => {},
    });

    expect(JSON.stringify(provider.received[0])).not.toContain('Bob Henderson');
    expect(result.reply).toBe('Tell Bob Henderson the closing moved.');
    // History is stored as PLAINTEXT (real names) so it can be re-redacted at
    // whatever tier the NEXT turn's endpoint requires — never replayed in a
    // stale weaker form. What went over the wire was pseudonymized.
    const history = JSON.stringify(session.plainHistory);
    expect(history).toContain('Bob Henderson');
    expect(history).not.toContain('Person-1');
  });

  it('re-redacts prior plaintext history when the endpoint switches private→bounded', async () => {
    // Regression for the M6 adversarial-review CRITICAL: a session started on a
    // private endpoint with redaction OFF must not leak its stored plaintext
    // when the conversation later moves to a bounded (cloud) endpoint.
    const session = createSession();
    const vault = new FakeVault([]);

    // Turn 1 — private endpoint, tier 0: plaintext SSN is sent (fine, it's
    // loopback) and stored in history in the clear.
    const localProvider = new FakeProvider('http://127.0.0.1:9999', 'noted');
    await runTurn({
      message: 'My SSN is 219-09-9999, keep it handy.',
      session,
      provider: localProvider,
      model: 'local',
      vault,
      redactTier: 0,
      distill: false,
      auditFn: () => {},
    });
    expect(JSON.stringify(localProvider.received[0])).toContain('219-09-9999'); // private: OK
    expect(JSON.stringify(session.plainHistory)).toContain('219-09-9999');

    // Turn 2 — swap to a bounded endpoint. The stored plaintext SSN MUST be
    // masked before it goes out.
    const cloudProvider = new FakeProvider('https://api.example.com', 'ok');
    await runTurn({
      message: 'Anything else?',
      session,
      provider: cloudProvider,
      model: 'cloud',
      vault,
      redactTier: 1,
      distill: false,
      auditFn: () => {},
    });
    const outbound = JSON.stringify(cloudProvider.received[0]);
    expect(outbound, 'history plaintext leaked to bounded endpoint').not.toContain('219-09-9999');
    expect(outbound).toContain('[SSN_1]'); // the history was re-redacted
  });

  it('re-runs full NER on a NAME first seen at a lower tier (private→bounded swap-up)', async () => {
    // Regression for the M6 verified PII leak: a name (NER-only PII, no
    // deterministic layer to catch it) that entered history on a private/Tier-0
    // turn — where the pseudonym map was never populated — must be re-run through
    // full NER, not replayed over an empty map, when the conversation later moves
    // to a bounded endpoint at Tier 2. Before the fix, history was hard-coded to
    // 'replay-only' and "Bob Henderson" shipped to the cloud in PLAINTEXT.
    const nerLog: Array<{ text: string; nerMode: string; tier: number }> = [];
    const fakeRedact = makeNameRedactor(nerLog);
    const session = createSession();
    const vault = new FakeVault([]);

    // Turn 1 — private endpoint, Tier 0: redaction is skipped entirely, so the
    // NER model never runs and the map stays empty; the real name is stored plain.
    const localProvider = new FakeProvider('http://127.0.0.1:9999', 'Will do.');
    await runTurn({
      message: 'Ask Bob Henderson about the closing.',
      session,
      provider: localProvider,
      model: 'local',
      vault,
      redactTier: 0,
      distill: false,
      redactFn: fakeRedact,
      auditFn: () => {},
    });
    expect(nerLog).toHaveLength(0); // Tier 0 skips redaction outright
    expect(JSON.stringify(session.plainHistory)).toContain('Bob Henderson');
    expect(Object.keys(session.pseudonyms)).toHaveLength(0); // map never captured it
    expect(session.historyTiers).toEqual([0, 0]); // user + reply both never NER'd

    // Turn 2 — swap to a bounded endpoint at Tier 2. The stored plaintext name
    // MUST be masked before it leaves the machine.
    const cloudProvider = new FakeProvider('https://api.example.com', 'Sure.');
    await runTurn({
      message: 'Anything else?',
      session,
      provider: cloudProvider,
      model: 'cloud',
      vault,
      redactTier: 2,
      distill: false,
      redactFn: fakeRedact,
      auditFn: () => {},
    });
    const outbound = JSON.stringify(cloudProvider.received[0]);
    expect(outbound, 'history name leaked to bounded endpoint').not.toContain('Bob Henderson');
    expect(outbound).toContain('Person-1'); // history was re-NER'd, not replayed blind
    // The history message ran full NER because historyTiers said 0 < 2.
    const historyCall = nerLog.find((c) => c.text === 'Ask Bob Henderson about the closing.');
    expect(historyCall?.nerMode).toBe('on');
    // ...and its coverage is now recorded at the tier it was actually masked to.
    expect(session.historyTiers[0]).toBe(2);
  });

  it('keeps replay-only for history already covered at the current tier (optimization preserved)', async () => {
    // The desktop-hang fix must survive: a message already full-NER-redacted at
    // the current tier is replayed from the map, NOT re-run through the 3B model.
    const nerLog: Array<{ text: string; nerMode: string; tier: number }> = [];
    const fakeRedact = makeNameRedactor(nerLog);
    const session = createSession();
    const vault = new FakeVault([]);

    // Turn 1 — bounded Tier 2: the user message runs full NER and populates the map.
    const provider1 = new FakeProvider('https://api.example.com', 'Done.');
    await runTurn({
      message: 'Email Bob Henderson about the closing.',
      session,
      provider: provider1,
      model: 'cloud',
      vault,
      redactTier: 2,
      distill: false,
      redactFn: fakeRedact,
      auditFn: () => {},
    });
    expect(session.pseudonyms['bob henderson']).toBe('Person-1');
    expect(session.historyTiers).toEqual([2, 0]); // user covered at 2, reply never NER'd

    nerLog.length = 0; // observe only turn 2

    // Turn 2 — SAME bounded Tier-2 endpoint.
    const provider2 = new FakeProvider('https://api.example.com', 'Okay.');
    await runTurn({
      message: 'And CC the broker.',
      session,
      provider: provider2,
      model: 'cloud',
      vault,
      redactTier: 2,
      distill: false,
      redactFn: fakeRedact,
      auditFn: () => {},
    });
    // The turn-1 user message (already covered at tier 2) must be REPLAYED, not
    // re-NER'd — this is the optimization that stops long chats from hanging.
    const userCall = nerLog.find((c) => c.text === 'Email Bob Henderson about the closing.');
    expect(userCall?.nerMode).toBe('replay-only');
    // The tier-0 assistant reply, tracked independently, is re-NER'd exactly once.
    const replyCall = nerLog.find((c) => c.text === 'Done.');
    expect(replyCall?.nerMode).toBe('on');
    // Replay still masks the name — the optimization does not reopen the leak.
    const outbound = JSON.stringify(provider2.received[0]);
    expect(outbound).not.toContain('Bob Henderson');
    expect(outbound).toContain('Person-1');
  });

  it('records DEGRADED Tier-2 coverage as the real tier (1), so a later working Tier-2 re-NERs', async () => {
    // This is the test that pins the deviation from the original spec: coverage
    // is recorded at the tier ACTUALLY applied (tierApplied), never the tier
    // REQUESTED (effectiveTier). When Tier-2 NER degrades on a private endpoint,
    // the turn proceeds at tier 1 with the name UNMASKED and the map empty — so
    // the history message must be recorded as covered at 1, forcing a full re-NER
    // when the conversation later reaches a working Tier-2 bounded endpoint.
    // Recording the requested tier (2) would replay-only over the empty map and
    // ship the real name to the cloud in plaintext.
    const session = createSession();
    const vault = new FakeVault([]);

    // Turn 1 — private, Tier 0: plaintext name stored, map empty, tiers [0,0].
    await runTurn({
      message: 'Ask Bob Henderson about the closing.',
      session,
      provider: new FakeProvider('http://127.0.0.1:9999', 'Will do.'),
      model: 'local',
      vault,
      redactTier: 0,
      distill: false,
      redactFn: makeNameRedactor([]),
      auditFn: () => {},
    });
    expect(session.historyTiers).toEqual([0, 0]);

    // Turn 2 — private, Tier 2, NER OFFLINE: history runs 'on' but degrades, so
    // the name is NOT masked and the map stays empty; a private endpoint proceeds
    // at tier 1 (no abort).
    const r2 = await runTurn({
      message: 'And the survey?',
      session,
      provider: new FakeProvider('http://127.0.0.1:9999', 'Okay.'),
      model: 'local',
      vault,
      redactTier: 2,
      distill: false,
      redactFn: makeNameRedactor([], { degraded: true }),
      auditFn: () => {},
    });
    expect(r2.tier2Degraded).toBe(true);
    expect(r2.tierApplied).toBe(1);
    expect(Object.keys(session.pseudonyms)).toHaveLength(0); // NER never ran
    // The history name is recorded at the REAL coverage (1) — NOT the requested 2.
    // Under the original spec (effectiveTier) this would be 2 and turn 3 leaks.
    expect(session.historyTiers[0]).toBe(1);

    // Turn 3 — bounded, Tier 2, NER back up. historyTiers[0] === 1 < 2, so the
    // history message is re-NER'd and the name is masked, not shipped in plaintext.
    const cloudProvider = new FakeProvider('https://api.example.com', 'Sure.');
    await runTurn({
      message: 'Anything else?',
      session,
      provider: cloudProvider,
      model: 'cloud',
      vault,
      redactTier: 2,
      distill: false,
      redactFn: makeNameRedactor([]),
      auditFn: () => {},
    });
    const outbound = JSON.stringify(cloudProvider.received[0]);
    expect(outbound, 'degraded-tier history name leaked to cloud').not.toContain('Bob Henderson');
    expect(outbound).toContain('Person-1');
  });

  it('does not mutate historyTiers when a Tier-2 turn aborts toward a bounded endpoint', async () => {
    // The reNerd coverage update is deliberately deferred past the abort guard, so
    // a turn that refuses to send (Tier-2 degraded → bounded) leaves shared session
    // state exactly as it was: nothing sent, nothing recorded, no desync.
    const session = createSession();
    const vault = new FakeVault([]);
    await runTurn({
      message: 'Ask Bob Henderson about it.',
      session,
      provider: new FakeProvider('http://127.0.0.1:9999', 'Will do.'),
      model: 'local',
      vault,
      redactTier: 0,
      distill: false,
      redactFn: makeNameRedactor([]),
      auditFn: () => {},
    });
    const before = [...session.historyTiers];
    expect(before).toEqual([0, 0]);

    await expect(
      runTurn({
        message: 'And the rest?',
        session,
        provider: new FakeProvider('https://api.example.com', 'nope'),
        model: 'cloud',
        vault,
        redactTier: 2,
        distill: false,
        redactFn: makeNameRedactor([], { degraded: true }),
        auditFn: () => {},
      }),
    ).rejects.toThrowError(TurnError);
    expect(session.historyTiers).toEqual(before); // no corruption on abort
    expect(session.plainHistory).toHaveLength(2); // the append never happened
  });

  it('refuses to send when Tier-2 degrades toward a bounded endpoint', async () => {
    const provider = new FakeProvider('https://api.example.com', 'nope');
    const vault = new FakeVault([]);
    const audits: CallLogEntry[] = [];

    const degradedRedact: typeof redact = async (text) => {
      const t1 = await redact(text, { tier: 1 });
      return { ...t1, tierApplied: 1 as const, tier2Degraded: true };
    };

    await expect(
      runTurn({
        message: 'sensitive thing about Bob',
        session: createSession(),
        provider,
        model: 'fake-model',
        vault,
        redactTier: 2,
        distill: false,
        redactFn: degradedRedact,
        auditFn: (e) => audits.push(e),
      }),
    ).rejects.toThrowError(TurnError);
    expect(provider.received).toHaveLength(0); // nothing was sent
    expect(audits).toHaveLength(1);
    expect(audits[0]!.ok).toBe(false);
    expect(audits[0]!.denied).toBe(true);
  });

  it('forces Tier-1 minimum on a bounded endpoint even when asked for 0', async () => {
    const provider = new FakeProvider('https://api.example.com', 'ok');
    const result = await runTurn({
      message: 'my email is jay@example.com',
      session: createSession(),
      provider,
      model: 'fake-model',
      vault: new FakeVault([]),
      redactTier: 0,
      distill: false,
      auditFn: () => {},
    });
    expect(result.tierApplied).toBe(1);
    expect(result.privacy).toBe('bounded');
    expect(JSON.stringify(provider.received[0])).not.toContain('jay@example.com');
  });

  it('allows redaction OFF only on a private endpoint', async () => {
    const provider = new FakeProvider('http://192.168.1.20:8080', 'ok');
    const result = await runTurn({
      message: 'my email is jay@example.com',
      session: createSession(),
      provider,
      model: 'fake-model',
      vault: new FakeVault([]),
      redactTier: 0,
      distill: false,
      auditFn: () => {},
    });
    expect(result.tierApplied).toBe(0);
    expect(JSON.stringify(provider.received[0])).toContain('jay@example.com');
  });

  it('distills the exchange into memory (heuristic path) and persists', async () => {
    const provider = new FakeProvider('http://127.0.0.1:9999', 'Nice, Dartmouth is lovely.');
    const vault = new FakeVault([]);
    const result = await runTurn({
      message: 'I live in Dartmouth and I love my morning walks.',
      session: createSession(),
      provider,
      model: 'fake-model',
      vault,
      redactTier: 1,
      distillOllama: null, // heuristic
      auditFn: () => {},
    });
    expect(result.distillMode).toBe('heuristic');
    expect(vault.remembered.length).toBeGreaterThan(0);
    expect(vault.remembered[0]!.source).toBe('converse');
    expect(vault.commits).toBe(1);
    expect(result.memoriesCreated.length).toBe(vault.remembered.length);
  });

  it('never distills a Tier-1 secret into memory', async () => {
    const provider = new FakeProvider('http://127.0.0.1:9999', 'Noted.');
    const vault = new FakeVault([]);
    // A distillation model that (wrongly) proposes memorizing a secret plus a
    // benign fact. The secret candidate must be dropped; the benign one kept.
    const ollama = {
      async available() {
        return true;
      },
      async generateJson() {
        return JSON.stringify({
          memories: [
            { type: 'semantic', content: 'The user has a Social Security number of 219-09-9999.', confidence: 0.9 },
            { type: 'semantic', content: 'The user lives in Dartmouth.', confidence: 0.8 },
          ],
        });
      },
    };
    await runTurn({
      message: 'My SSN is 219-09-9999 and I live in Dartmouth.',
      session: createSession(),
      provider,
      model: 'fake-model',
      vault,
      redactTier: 1,
      distillOllama: ollama,
      auditFn: () => {},
    });
    const stored = vault.remembered.map((m) => m.content).join(' | ');
    expect(stored).not.toContain('219-09-9999');
    expect(stored).not.toMatch(/social security/i);
    expect(stored).toContain('Dartmouth'); // the benign fact still lands
  });

  it('drops the weak tail of loosely-matching memories (relevance floor)', async () => {
    // Query loosely touches many memories; only the strong match should inject.
    const strong = makeEntry({
      id: 'strong-00000000-0000-0000-0000-000000000000',
      content: 'Jay takes his coffee black.',
    });
    const weak = makeEntry({
      id: 'weak-000000000-0000-0000-0000-000000000000',
      content: 'The user has a friend named Sam.',
    });
    // FakeVault.retrieve returns score 1 for every entry, so to exercise the
    // floor we give a vault that scores realistically.
    const scoredVault = {
      commits: 0,
      remembered: [] as RememberInput[],
      retrieve(): ScoredEntry[] {
        return [
          { entry: strong, score: 1.0 },
          { entry: weak, score: 0.3 }, // below 0.6 * top → dropped
        ];
      },
      list(): MemoryEntry[] {
        return [];
      },
      commit(inputs: RememberInput[]): MemoryEntry[] {
        return inputs.map((i) => makeEntry({ id: 'n', content: i.content }));
      },
    };
    const provider = new FakeProvider('http://127.0.0.1:9999', 'ok');
    const result = await runTurn({
      message: 'my friend wants to know what coffee I drink',
      session: createSession(),
      provider,
      model: 'fake-model',
      vault: scoredVault,
      redactTier: 1,
      distill: false,
      auditFn: () => {},
    });
    expect(result.memoriesUsed.map((m) => m.id)).toEqual([strong.id]);
    const outbound = JSON.stringify(provider.received[0]);
    expect(outbound).toContain('coffee black');
    expect(outbound).not.toContain('friend named Sam');
  });

  it('audits a provider failure without leaking content', async () => {
    const failing: ModelProvider = {
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:9999',
      async chat() {
        throw new Error('Model endpoint returned HTTP 500.');
      },
      async listModels() {
        return [];
      },
    };
    const audits: CallLogEntry[] = [];
    await expect(
      runTurn({
        message: 'hello there',
        session: createSession(),
        provider: failing,
        model: 'fake-model',
        vault: new FakeVault([]),
        redactTier: 1,
        distill: false,
        auditFn: (e) => audits.push(e),
      }),
    ).rejects.toThrowError(TurnError);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.ok).toBe(false);
    expect(JSON.stringify(audits[0])).not.toContain('hello there');
  });
});

// ---------- settings / key hygiene ----------

describe('endpoint settings', () => {
  let home: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-converse-'));
    process.env.NORTHKEEP_HOME = home;
    process.env.NORTHKEEP_NO_KEYCHAIN = '1';
  });
  afterEach(() => {
    process.env = { ...savedEnv };
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('persists endpoints 0600 and never writes API keys to the file', () => {
    const ep = addEndpoint({
      label: 'Local Ollama',
      baseUrl: 'http://127.0.0.1:11434/',
      model: 'llama3.2:3b',
    });
    expect(ep.hasKey).toBe(false);
    const mode = fs.statSync(providersPath()).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(listEndpoints()).toHaveLength(1);

    // With no Keychain, storing a key must refuse loudly — and leave no trace.
    expect(() =>
      addEndpoint({
        label: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        apiKey: 'sk-test-not-a-real-key',
      }),
    ).toThrow(/Keychain/);
    const raw = fs.readFileSync(providersPath(), 'utf8');
    expect(raw).not.toContain('sk-test-not-a-real-key');
    expect(listEndpoints()).toHaveLength(1); // the failed add left nothing behind
  });

  it('refuses an API key on a plain-http public endpoint', () => {
    expect(() =>
      addEndpoint({
        label: 'Sketchy',
        baseUrl: 'http://api.example.com',
        model: 'x',
        apiKey: 'sk-test-not-a-real-key',
      }),
    ).toThrow(/https/);
  });

  it('resolves keys from the env escape hatch and removes endpoints cleanly', () => {
    const ep = addEndpoint({
      label: 'Fake Cloud',
      baseUrl: 'https://api.example.com',
      model: 'x',
    });
    const envVar = `NORTHKEEP_PROVIDER_KEY_${ep.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    process.env[envVar] = 'sk-test-env-key';
    expect(getEndpointKey(ep.id)).toBe('sk-test-env-key');
    expect(removeEndpoint(ep.id)).toBe(true);
    expect(listEndpoints()).toHaveLength(0);
  });
});
