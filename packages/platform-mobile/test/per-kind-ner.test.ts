import { describe, expect, it } from 'vitest';
import {
  MAX_ENTITIES_PER_PASS,
  MIN_PASS_BUDGET_MS,
  NER_PASSES,
  NER_PROMPT_TEXT_MARKER,
  NerPassTimeoutError,
  extractNerText,
  mergeEntities,
  parseEntityReply,
  runPerKindNer,
  salvageEntityJson,
  type NerEntity,
  type NerPassEvent,
} from '../src/local-model/per-kind-ner.js';

/**
 * Pure-logic tests for the per-kind NER decomposition, with a FAKE model
 * function. No React Native / Expo imports (repo convention). What these
 * prove: prompt-table hygiene, salvage/dup-key repair on every pass, the
 * merge rules, and the degraded-proceeds fold. What they can NOT prove:
 * actual recall gain, which needs the on-phone eval screen.
 */

/** The applyTier2-shaped prompt (instructions, then the marker, then text). */
function tier2Prompt(text: string): string {
  return `Extract named entities from the text. Respond with JSON only:\n{"entities":[]} if none.\n${NER_PROMPT_TEXT_MARKER.slice(1)}${text}`;
}

describe('extractNerText', () => {
  it('recovers the text under analysis from an applyTier2-shaped prompt', () => {
    const text = 'Call Priya Nair about the Ellison account.';
    expect(extractNerText(tier2Prompt(text))).toBe(text);
  });

  it('returns null when the marker is absent (legacy fallback trigger)', () => {
    expect(extractNerText('Extract entities from: Bob went to Denver.')).toBeNull();
  });

  it('splits at the FIRST marker so text containing the marker is fully recovered', () => {
    const tricky = `line one${NER_PROMPT_TEXT_MARKER}line two`;
    expect(extractNerText(tier2Prompt(tricky))).toBe(tricky);
  });
});

describe('NER_PASSES prompt table', () => {
  it('has at most 5 focused passes with unique ids and pipeline-legal kinds', () => {
    expect(NER_PASSES.length).toBeGreaterThan(1);
    expect(NER_PASSES.length).toBeLessThanOrEqual(5);
    const ids = NER_PASSES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of NER_PASSES) {
      expect(['person', 'org', 'location']).toContain(p.kind);
    }
  });

  it('every prompt embeds the text, one parseable example reply, and NO JSON Schema text', () => {
    const text = 'Maria Delgado flew to Portland.';
    for (const p of NER_PASSES) {
      const prompt = p.buildPrompt(text);
      expect(prompt).toContain(text);
      expect(prompt.endsWith(text)).toBe(true);
      // Exactly one example reply, and it parses to the wire shape.
      const examples = prompt.match(/Example reply: (\{.*\})/g) ?? [];
      expect(examples).toHaveLength(1);
      const parsed = JSON.parse(examples[0].replace('Example reply: ', '')) as {
        entities: Array<{ text: string; kind: string }>;
      };
      expect(Array.isArray(parsed.entities)).toBe(true);
      for (const e of parsed.entities) expect(e.kind).toBe(p.kind);
      // The schema dump caused the dup-key artifact; it must never come back.
      expect(prompt).not.toMatch(/additionalProperties|"type"\s*:\s*"object"|\$schema/);
      // No em dashes in any string the pipeline emits.
      expect(prompt).not.toContain('—');
    }
  });
});

describe('salvageEntityJson', () => {
  it('strips code fences and prose down to the outermost object', () => {
    const raw = 'Sure! Here you go:\n```json\n{"entities":[{"text":"Bob","kind":"person"}]}\n```';
    expect(JSON.parse(salvageEntityJson(raw))).toEqual({
      entities: [{ text: 'Bob', kind: 'person' }],
    });
  });

  it('repairs the observed duplicated-key artifact', () => {
    const raw = '{"entities":[{"text": "text":"John Whitfield","kind": "kind":"person"}]}';
    expect(JSON.parse(salvageEntityJson(raw))).toEqual({
      entities: [{ text: 'John Whitfield', kind: 'person' }],
    });
  });

  it('is idempotent on clean JSON', () => {
    const clean = '{"entities":[{"text":"Acme Corp","kind":"org"}]}';
    expect(salvageEntityJson(salvageEntityJson(clean))).toBe(clean);
  });
});

describe('parseEntityReply', () => {
  it('forces the pass kind onto every span, whatever the model echoed', () => {
    const raw = '{"entities":[{"text":"Maple Street","kind":"person"},{"text":"Denver"}]}';
    expect(parseEntityReply(raw, 'location')).toEqual([
      { text: 'Maple Street', kind: 'location' },
      { text: 'Denver', kind: 'location' },
    ]);
  });

  it('drops junk spans (non-string, too short, too long) and caps the list', () => {
    const many = Array.from({ length: MAX_ENTITIES_PER_PASS + 10 }, (_, i) => ({
      text: `Entity Number ${i}`,
      kind: 'person',
    }));
    const raw = JSON.stringify({
      entities: [{ text: 7 }, { text: 'a' }, { text: 'x'.repeat(101) }, ...many],
    });
    expect(parseEntityReply(raw, 'person')).toHaveLength(MAX_ENTITIES_PER_PASS - 3);
  });

  it('throws content-free errors on non-JSON and on a missing entities array', () => {
    expect(() => parseEntityReply('the secret is Bob', 'person')).toThrow('non-JSON reply');
    expect(() => parseEntityReply('{"items":[]}', 'person')).toThrow(
      'reply missing an entities array',
    );
  });
});

describe('mergeEntities', () => {
  it('keeps BOTH spans on overlap: applyTier2 masks longest-first whole-word, and dropping the shorter span would leak its standalone occurrences', () => {
    const merged = mergeEntities([
      [{ text: 'Bob', kind: 'person' }],
      [{ text: 'Bob Henderson', kind: 'org' }],
    ]);
    expect(merged).toEqual([
      { text: 'Bob', kind: 'person' },
      { text: 'Bob Henderson', kind: 'org' },
    ]);
  });

  it('regression: "Ann" survives alongside "Annapolis Shipyards" so a standalone "Ann" still gets masked downstream', () => {
    const merged = mergeEntities([
      [{ text: 'Ann', kind: 'person' }],
      [{ text: 'Annapolis Shipyards', kind: 'org' }],
    ]);
    expect(merged).toEqual([
      { text: 'Ann', kind: 'person' },
      { text: 'Annapolis Shipyards', kind: 'org' },
    ]);
  });

  it('collapses case-insensitive exact duplicates to the earlier pass (kind order)', () => {
    const merged = mergeEntities([
      [{ text: 'Harborview', kind: 'person' }],
      [{ text: 'HARBORVIEW', kind: 'org' }],
    ]);
    expect(merged).toEqual([{ text: 'Harborview', kind: 'person' }]);
  });

  it('keeps all non-overlapping spans across passes', () => {
    const merged = mergeEntities([
      [{ text: 'Priya Nair', kind: 'person' }],
      [{ text: 'Ellison', kind: 'org' }],
      [{ text: 'Maple Street', kind: 'location' }],
    ]);
    expect(merged).toHaveLength(3);
  });
});

describe('runPerKindNer (fake model)', () => {
  const TEXT = 'Maria Delgado from Cascade Analytics is on Maple Street in Portland.';

  /** Canned per-kind replies keyed by a distinctive fragment of each prompt. */
  function cannedModel(replies: Record<string, string>) {
    const calls: string[] = [];
    let inFlight = 0;
    let sawConcurrency = false;
    const callModel = async (prompt: string, _timeoutMs: number): Promise<string> => {
      inFlight += 1;
      if (inFlight > 1) sawConcurrency = true;
      await Promise.resolve();
      inFlight -= 1;
      for (const [needle, reply] of Object.entries(replies)) {
        if (prompt.includes(needle)) {
          calls.push(needle);
          if (reply === 'THROW') throw new Error('simulated pass failure');
          return reply;
        }
      }
      calls.push('unmatched');
      return '{"entities":[]}';
    };
    return { callModel, calls, sawConcurrency: () => sawConcurrency };
  }

  // Distinctive per-prompt openings ("Skip street addresses" in the place
  // prompt would collide with a bare 'street address' needle).
  const NEEDLES = {
    person: "Find every person's name",
    org: 'Find every organization name',
    street: 'Find every street address',
    place: 'Find every city',
  };

  it('runs one pass per kind sequentially and merges into the applyTier2 wire shape', async () => {
    const fake = cannedModel({
      [NEEDLES.person]: '{"entities":[{"text":"Maria Delgado","kind":"person"}]}',
      [NEEDLES.org]: '{"entities":[{"text":"Cascade Analytics","kind":"org"}]}',
      [NEEDLES.street]: '{"entities":[{"text":"Maple Street","kind":"location"}]}',
      [NEEDLES.place]: '{"entities":[{"text":"Portland","kind":"location"}]}',
    });
    const events: NerPassEvent[] = [];
    const out = await runPerKindNer(TEXT, fake.callModel, { onPass: (e) => events.push(e) });
    const parsed = JSON.parse(out) as { entities: NerEntity[] };
    expect(parsed.entities).toEqual(
      expect.arrayContaining([
        { text: 'Maria Delgado', kind: 'person' },
        { text: 'Cascade Analytics', kind: 'org' },
        { text: 'Maple Street', kind: 'location' },
        { text: 'Portland', kind: 'location' },
      ]),
    );
    expect(parsed.entities).toHaveLength(4);
    expect(fake.calls).toHaveLength(NER_PASSES.length);
    expect(fake.sawConcurrency()).toBe(false);
    expect(events.map((e) => e.pass)).toEqual(NER_PASSES.map((p) => p.id));
    expect(events.every((e) => e.ok)).toBe(true);
    expect(events[0]?.raw).toContain('Maria Delgado');
  });

  it('applies the dup-key repair and salvage on every pass', async () => {
    const fake = cannedModel({
      [NEEDLES.person]:
        'Here it is:\n{"entities":[{"text": "text":"Maria Delgado","kind":"person"}]}',
      [NEEDLES.org]: '```json\n{"entities":[{"text": "text":"Cascade Analytics","kind":"org"}]}\n```',
    });
    const out = await runPerKindNer(TEXT, fake.callModel);
    const parsed = JSON.parse(out) as { entities: NerEntity[] };
    expect(parsed.entities).toEqual(
      expect.arrayContaining([
        { text: 'Maria Delgado', kind: 'person' },
        { text: 'Cascade Analytics', kind: 'org' },
      ]),
    );
  });

  it('continues with the other kinds when one pass fails, recording the failure', async () => {
    const fake = cannedModel({
      [NEEDLES.person]: 'THROW',
      [NEEDLES.org]: '{"entities":[{"text":"Cascade Analytics","kind":"org"}]}',
      [NEEDLES.street]: 'not json at all',
      [NEEDLES.place]: '{"entities":[{"text":"Portland","kind":"location"}]}',
    });
    const events: NerPassEvent[] = [];
    const out = await runPerKindNer(TEXT, fake.callModel, { onPass: (e) => events.push(e) });
    const parsed = JSON.parse(out) as { entities: NerEntity[] };
    expect(parsed.entities).toEqual(
      expect.arrayContaining([
        { text: 'Cascade Analytics', kind: 'org' },
        { text: 'Portland', kind: 'location' },
      ]),
    );
    expect(parsed.entities).toHaveLength(2);
    const failed = events.filter((e) => !e.ok);
    expect(failed.map((e) => e.pass).sort()).toEqual(['person', 'street']);
    expect(failed.find((e) => e.pass === 'person')?.error).toBe('simulated pass failure');
    expect(failed.find((e) => e.pass === 'street')?.error).toBe('non-JSON reply');
    // Parse/other failures do NOT abandon the run: all four passes were issued.
    expect(fake.calls).toHaveLength(NER_PASSES.length);
  });

  it('throws (degraded, never silent) only when EVERY pass fails', async () => {
    const fake = cannedModel({
      [NEEDLES.person]: 'THROW',
      [NEEDLES.org]: 'THROW',
      [NEEDLES.street]: 'THROW',
      [NEEDLES.place]: 'THROW',
    });
    await expect(runPerKindNer(TEXT, fake.callModel)).rejects.toThrow(
      `All ${NER_PASSES.length} NER passes failed`,
    );
  });

  it('a pass that finds nothing is a success, not a failure', async () => {
    const fake = cannedModel({
      [NEEDLES.person]: '{"entities":[]}',
      [NEEDLES.org]: '{"entities":[]}',
      [NEEDLES.street]: '{"entities":[]}',
      [NEEDLES.place]: '{"entities":[]}',
    });
    const out = await runPerKindNer(TEXT, fake.callModel);
    expect(JSON.parse(out)).toEqual({ entities: [] });
  });

  it('skips remaining passes when the time budget is spent, recording each skip', async () => {
    let clock = 0;
    const timeouts: number[] = [];
    const callModel = async (_prompt: string, timeoutMs: number): Promise<string> => {
      timeouts.push(timeoutMs);
      clock += 4500; // each pass "takes" 4500 fake ms
      return '{"entities":[]}';
    };
    const events: NerPassEvent[] = [];
    const out = await runPerKindNer(TEXT, callModel, {
      onPass: (e) => events.push(e),
      now: () => clock,
      perPassTimeoutMs: 6000,
      totalBudgetMs: 10_000,
    });
    expect(JSON.parse(out)).toEqual({ entities: [] });
    // Pass 1 at t=0 (10000 left), pass 2 at t=4500 (5500 left, timeout capped
    // to the remainder), pass 3 at t=9000 with 1000 left, under the 2s floor
    // (a guaranteed timeout), so passes 3+ are skipped, not attempted.
    expect(timeouts).toEqual([6000, 5500]);
    const skipped = events.filter((e) => e.error === 'skipped: time budget exhausted');
    expect(skipped).toHaveLength(NER_PASSES.length - 2);
    expect(events).toHaveLength(NER_PASSES.length);
  });

  it(`budget floor: a pass with under ${MIN_PASS_BUDGET_MS}ms of budget left is skipped, not started`, async () => {
    let clock = 0;
    const calls: number[] = [];
    const callModel = async (_prompt: string, timeoutMs: number): Promise<string> => {
      calls.push(timeoutMs);
      clock += 4100; // pass 1 finishes at t=4100, leaving 1900ms of budget
      return '{"entities":[{"text":"Maria Delgado","kind":"person"}]}';
    };
    const events: NerPassEvent[] = [];
    const out = await runPerKindNer(TEXT, callModel, {
      onPass: (e) => events.push(e),
      now: () => clock,
      perPassTimeoutMs: 5000,
      totalBudgetMs: 6000,
    });
    // 1900ms remaining is nonzero but below MIN_PASS_BUDGET_MS: starting the
    // pass would be a guaranteed failure that also wedges the bridge.
    expect(calls).toHaveLength(1);
    const skipped = events.filter((e) => e.error === 'skipped: time budget exhausted');
    expect(skipped.map((e) => e.pass)).toEqual(NER_PASSES.slice(1).map((p) => p.id));
    expect(JSON.parse(out)).toEqual({
      entities: [{ text: 'Maria Delgado', kind: 'person' }],
    });
  });

  it('a pass TIMEOUT abandons the remaining passes (wedged bridge), keeping what merged so far', async () => {
    let clock = 0;
    const issued: string[] = [];
    const callModel = async (prompt: string, timeoutMs: number): Promise<string> => {
      if (prompt.includes(NEEDLES.person)) {
        issued.push('person');
        clock += 300;
        return '{"entities":[{"text":"Maria Delgado","kind":"person"}]}';
      }
      if (prompt.includes(NEEDLES.org)) {
        issued.push('org');
        clock += timeoutMs; // the wrapper fires: the native call is still running
        throw new NerPassTimeoutError(`local NER pass timed out after ${timeoutMs}ms`);
      }
      issued.push('other');
      return '{"entities":[]}';
    };
    const events: NerPassEvent[] = [];
    const out = await runPerKindNer(TEXT, callModel, {
      onPass: (e) => events.push(e),
      now: () => clock,
    });
    // Only passes 1 and 2 were ever issued to the model.
    expect(issued).toEqual(['person', 'org']);
    // Passes 3 and 4 are recorded as skipped, never silent.
    const skipped = events.filter((e) => e.error === 'skipped: earlier pass timed out');
    expect(skipped.map((e) => e.pass)).toEqual(['street', 'place']);
    expect(events).toHaveLength(NER_PASSES.length);
    // Pass 1's entities still come back merged.
    expect(JSON.parse(out)).toEqual({
      entities: [{ text: 'Maria Delgado', kind: 'person' }],
    });
  });

  it('a TIMEOUT before any pass succeeded throws like the all-fail path (degraded, never silent)', async () => {
    const callModel = async (_prompt: string, timeoutMs: number): Promise<string> => {
      throw new NerPassTimeoutError(`local NER pass timed out after ${timeoutMs}ms`);
    };
    const events: NerPassEvent[] = [];
    await expect(
      runPerKindNer(TEXT, callModel, { onPass: (e) => events.push(e) }),
    ).rejects.toThrow(`All ${NER_PASSES.length} NER passes failed`);
    // One real timeout, the rest recorded as skipped.
    expect(events.filter((e) => e.error === 'skipped: earlier pass timed out')).toHaveLength(
      NER_PASSES.length - 1,
    );
  });

  it('overlapping spans from different passes BOTH survive the merge (nested spans are applyTier2 territory)', async () => {
    const fake = cannedModel({
      [NEEDLES.person]: '{"entities":[{"text":"Maria","kind":"person"}]}',
      [NEEDLES.org]: '{"entities":[{"text":"Maria Delgado","kind":"org"}]}',
    });
    const out = await runPerKindNer(TEXT, fake.callModel);
    expect(JSON.parse(out)).toEqual({
      entities: [
        { text: 'Maria', kind: 'person' },
        { text: 'Maria Delgado', kind: 'org' },
      ],
    });
  });
});
