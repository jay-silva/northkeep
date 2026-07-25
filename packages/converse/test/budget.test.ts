import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  budgetPath,
  daySpend,
  DEFAULT_TOOL_BUDGET,
  getToolBudget,
  listBudgetedTools,
  loadBudget,
  recordSpend,
  setToolBudget,
  withinDailyCap,
} from '../src/index.js';
// reserveDailySpend (ADR 0031 Decision 5) is not re-exported through index.js —
// the lead wires that export separately — so import it straight from the module.
import { reserveDailySpend } from '../src/tools/budget.js';

/**
 * M10d — the ADR-0030 (decision 4) tool-spend budget (~/.northkeep/budget.json).
 * Same file idiom as permissions.json: 0600, tolerant loader, strict writer.
 * FAIL-CLOSED DIRECTION is inverted from policy.ts: a corrupt/absent file must
 * yield NO configured caps and ZERO spend — which allows a first call but never
 * an unbounded run, because getToolBudget still returns DEFAULT_TOOL_BUDGET and
 * withinDailyCap always measures against that default cap.
 */

const DAY1 = new Date('2026-07-24T09:00:00Z');
const DAY1_LATE = new Date('2026-07-24T23:59:00Z'); // same UTC day as DAY1
const DAY2 = new Date('2026-07-25T00:30:00Z'); // next UTC day

describe('budget store', () => {
  let home: string;
  let priorHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-budget-'));
    priorHome = process.env.NORTHKEEP_HOME;
    process.env.NORTHKEEP_HOME = home;
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.NORTHKEEP_HOME;
    else process.env.NORTHKEEP_HOME = priorHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('defaults to no caps and zero spend when no file exists', () => {
    expect(loadBudget()).toEqual({ version: 1, tools: {} });
    expect(daySpend('web_search', DAY1)).toBe(0);
  });

  it('getToolBudget returns DEFAULT_TOOL_BUDGET for an unconfigured tool', () => {
    expect(getToolBudget('web_search')).toEqual(DEFAULT_TOOL_BUDGET);
    // and a fresh object, not the shared constant (callers must not mutate it)
    expect(getToolBudget('web_search')).not.toBe(DEFAULT_TOOL_BUDGET);
  });

  it('fails CLOSED on garbage: unparseable file → defaults, zero spend, still bounded', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(budgetPath(), 'not json {{{');
    expect(loadBudget()).toEqual({ version: 1, tools: {} });
    expect(getToolBudget('web_search')).toEqual(DEFAULT_TOOL_BUDGET); // default cap applies
    expect(daySpend('web_search', DAY1)).toBe(0); // zero spend
    expect(withinDailyCap('web_search', DAY1)).toBe(true); // first call allowed…
    // …but never unbounded: the default cap still bounds it.
    expect(getToolBudget('web_search').dailyCap).toBe(DEFAULT_TOOL_BUDGET.dailyCap);
  });

  it('ignores a wrong-version file entirely (unknown format → defaults, zero spend)', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      budgetPath(),
      JSON.stringify({
        version: 2,
        tools: { web_search: { dailyCap: 999, perConversationCap: 999 } },
        spend: { web_search: { '2026-07-24': 5 } },
      }),
    );
    expect(loadBudget().tools).toEqual({});
    expect(getToolBudget('web_search')).toEqual(DEFAULT_TOOL_BUDGET);
    expect(daySpend('web_search', DAY1)).toBe(0);
  });

  it('drops malformed cap/spend entries but keeps well-formed ones (tolerant read)', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      budgetPath(),
      JSON.stringify({
        version: 1,
        tools: {
          good: { dailyCap: 10, perConversationCap: 3 },
          badCap: { dailyCap: -1, perConversationCap: 3 }, // negative
          badType: { dailyCap: 'x', perConversationCap: 3 }, // wrong type
          badShape: 42, // not an object
          missing: { dailyCap: 10 }, // missing perConversationCap
        },
        spend: {
          good: { '2026-07-24': 4, '2026-07-23': 'nope' }, // bad count dropped
          badBucket: 7, // not an object
        },
      }),
    );
    expect(loadBudget().tools).toEqual({ good: { dailyCap: 10, perConversationCap: 3 } });
    expect(getToolBudget('badCap')).toEqual(DEFAULT_TOOL_BUDGET); // dropped → default
    expect(daySpend('good', DAY1)).toBe(4); // well-formed count survives
  });

  it('ignores partial files where tools/spend are not objects', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(budgetPath(), JSON.stringify({ version: 1, tools: [1, 2], spend: 'oops' }));
    expect(loadBudget().tools).toEqual({});
    expect(daySpend('web_search', DAY1)).toBe(0);
  });

  it('writes 0600 on a new file', () => {
    setToolBudget('web_search', { dailyCap: 40, perConversationCap: 4 });
    expect(fs.statSync(budgetPath()).mode & 0o777).toBe(0o600);
  });

  it('re-applies 0600 to a PRE-EXISTING loose-permission budget file (G1 review)', () => {
    fs.writeFileSync(budgetPath(), '{"version":1,"tools":{},"spend":{}}\n', { mode: 0o644 });
    expect(fs.statSync(budgetPath()).mode & 0o777).toBe(0o644);
    setToolBudget('web_search', { dailyCap: 40, perConversationCap: 4 });
    expect(fs.statSync(budgetPath()).mode & 0o777).toBe(0o600);
    // recordSpend writes too — it must also enforce 0600.
    fs.chmodSync(budgetPath(), 0o644);
    recordSpend('web_search', DAY1);
    expect(fs.statSync(budgetPath()).mode & 0o777).toBe(0o600);
  });

  it('setToolBudget upserts and accepts ANY tool name (not registry-allowlisted)', () => {
    setToolBudget('web_search', { dailyCap: 40, perConversationCap: 4 });
    expect(getToolBudget('web_search')).toEqual({ dailyCap: 40, perConversationCap: 4 });
    // upsert: a second set replaces
    setToolBudget('web_search', { dailyCap: 20, perConversationCap: 2 });
    expect(getToolBudget('web_search')).toEqual({ dailyCap: 20, perConversationCap: 2 });
    // a not-yet-registered tool name is accepted (web_search isn't in KNOWN_TOOL_NAMES yet)
    setToolBudget('some_future_tool', { dailyCap: 1, perConversationCap: 1 });
    expect(getToolBudget('some_future_tool')).toEqual({ dailyCap: 1, perConversationCap: 1 });
  });

  it('setToolBudget is a partial upsert: unset fields keep the current value', () => {
    setToolBudget('web_search', { dailyCap: 40, perConversationCap: 4 });
    setToolBudget('web_search', { dailyCap: 10 }); // only daily
    expect(getToolBudget('web_search')).toEqual({ dailyCap: 10, perConversationCap: 4 });
  });

  it('setToolBudget rejects garbage numbers loudly (strict write)', () => {
    expect(() => setToolBudget('web_search', { dailyCap: -1 })).toThrow();
    expect(() => setToolBudget('web_search', { perConversationCap: 2.5 })).toThrow();
    expect(() => setToolBudget('', { dailyCap: 1 })).toThrow();
  });

  it('setToolBudget leaves the spend ledger untouched', () => {
    recordSpend('web_search', DAY1); // spend = 1
    setToolBudget('web_search', { dailyCap: 10, perConversationCap: 2 });
    expect(daySpend('web_search', DAY1)).toBe(1); // count unchanged by a config write
  });

  it('recordSpend increments today’s persisted count', () => {
    expect(daySpend('web_search', DAY1)).toBe(0);
    recordSpend('web_search', DAY1);
    recordSpend('web_search', DAY1_LATE); // same UTC day
    expect(daySpend('web_search', DAY1)).toBe(2);
  });

  it('a call on a NEW day sees 0 (spend is per UTC calendar day)', () => {
    recordSpend('web_search', DAY1);
    recordSpend('web_search', DAY1);
    expect(daySpend('web_search', DAY1)).toBe(2);
    expect(daySpend('web_search', DAY2)).toBe(0); // fresh day starts at zero
  });

  it('withinDailyCap: true below the cap, false at the cap', () => {
    setToolBudget('web_search', { dailyCap: 2, perConversationCap: 5 });
    expect(withinDailyCap('web_search', DAY1)).toBe(true); // 0 < 2
    recordSpend('web_search', DAY1);
    expect(withinDailyCap('web_search', DAY1)).toBe(true); // 1 < 2
    recordSpend('web_search', DAY1);
    expect(withinDailyCap('web_search', DAY1)).toBe(false); // 2 == 2, at cap
    // …but the very next day is clear again.
    expect(withinDailyCap('web_search', DAY2)).toBe(true);
  });

  it('withinDailyCap uses the DEFAULT cap for an unconfigured tool', () => {
    expect(withinDailyCap('web_search', DAY1)).toBe(true);
    // spend up to the default cap → denied at it
    for (let i = 0; i < DEFAULT_TOOL_BUDGET.dailyCap; i++) recordSpend('web_search', DAY1);
    expect(daySpend('web_search', DAY1)).toBe(DEFAULT_TOOL_BUDGET.dailyCap);
    expect(withinDailyCap('web_search', DAY1)).toBe(false);
  });

  it('prunes old-day spend entries on write (keeps the file bounded)', () => {
    recordSpend('web_search', DAY1); // ledger has DAY1
    recordSpend('web_search', DAY2); // writing on DAY2 prunes DAY1
    const onDisk = JSON.parse(fs.readFileSync(budgetPath(), 'utf8')) as {
      spend: Record<string, Record<string, number>>;
    };
    expect(Object.keys(onDisk.spend['web_search']!)).toEqual(['2026-07-25']);
    expect(onDisk.spend['web_search']!['2026-07-25']).toBe(1);
    expect(daySpend('web_search', DAY1)).toBe(0); // old day gone
  });

  it('pruning does not lose OTHER tools that also spent today', () => {
    recordSpend('web_search', DAY1);
    recordSpend('other_tool', DAY1);
    recordSpend('web_search', DAY1); // a write on the same day keeps both tools
    expect(daySpend('web_search', DAY1)).toBe(2);
    expect(daySpend('other_tool', DAY1)).toBe(1);
  });

  it('listBudgetedTools returns the union of configured and spent-today tools, sorted', () => {
    expect(listBudgetedTools(DAY1)).toEqual([]);
    setToolBudget('web_search', { dailyCap: 40, perConversationCap: 4 });
    recordSpend('zzz_tool', DAY1);
    expect(listBudgetedTools(DAY1)).toEqual(['web_search', 'zzz_tool']);
    // a tool that only spent on a PRIOR day is not listed today
    expect(listBudgetedTools(DAY2)).toEqual(['web_search']);
  });

  // ADR 0031 Decision 5 — the atomic reserve that closes M10d's check→record
  // TOCTOU. reserveDailySpend is the AUTHORITY for the daily cap; the property
  // it guarantees is verified sequentially here because the function is
  // synchronous (no await between read and write), which is exactly why two
  // concurrent runTask calls in single-threaded Node cannot both reserve.
  it('reserveDailySpend below the cap returns true and increments daySpend by 1', () => {
    setToolBudget('web_search', { dailyCap: 5, perConversationCap: 5 });
    expect(daySpend('web_search', DAY1)).toBe(0);
    expect(reserveDailySpend('web_search', DAY1)).toBe(true);
    expect(daySpend('web_search', DAY1)).toBe(1); // incremented by exactly one
  });

  it('reserveDailySpend AT the cap returns false and does NOT change daySpend', () => {
    setToolBudget('web_search', { dailyCap: 2, perConversationCap: 5 });
    recordSpend('web_search', DAY1);
    recordSpend('web_search', DAY1); // count now 2 == cap
    expect(daySpend('web_search', DAY1)).toBe(2);
    expect(reserveDailySpend('web_search', DAY1)).toBe(false); // at cap → denied
    expect(daySpend('web_search', DAY1)).toBe(2); // unchanged: wrote nothing
  });

  it('two sequential reserves against dailyCap:1 → first true, second false, ends at 1', () => {
    // The concurrency-safety property: the first reserve takes the last slot and
    // the second reads the incremented count and fails — no double-reserve.
    setToolBudget('web_search', { dailyCap: 1, perConversationCap: 5 });
    expect(reserveDailySpend('web_search', DAY1)).toBe(true);
    expect(reserveDailySpend('web_search', DAY1)).toBe(false);
    expect(daySpend('web_search', DAY1)).toBe(1); // exactly one slot consumed
  });

  it('reserveDailySpend on a NEW day succeeds again (per-UTC-day reset)', () => {
    setToolBudget('web_search', { dailyCap: 1, perConversationCap: 5 });
    expect(reserveDailySpend('web_search', DAY1)).toBe(true);
    expect(reserveDailySpend('web_search', DAY1)).toBe(false); // DAY1 exhausted
    expect(reserveDailySpend('web_search', DAY2)).toBe(true); // fresh day, fresh slot
    expect(daySpend('web_search', DAY2)).toBe(1);
  });

  it('reserveDailySpend uses getToolBudget’s DEFAULT cap for an unconfigured tool', () => {
    // No setToolBudget → the default cap bounds it (never unbounded, never zero).
    for (let i = 0; i < DEFAULT_TOOL_BUDGET.dailyCap; i++) {
      expect(reserveDailySpend('web_search', DAY1)).toBe(true);
    }
    expect(daySpend('web_search', DAY1)).toBe(DEFAULT_TOOL_BUDGET.dailyCap);
    expect(reserveDailySpend('web_search', DAY1)).toBe(false); // at the default cap
  });

  it('reserveDailySpend preserves 0600 on the write', () => {
    setToolBudget('web_search', { dailyCap: 5, perConversationCap: 5 });
    fs.chmodSync(budgetPath(), 0o644); // loosen before the reserve writes
    expect(reserveDailySpend('web_search', DAY1)).toBe(true);
    expect(fs.statSync(budgetPath()).mode & 0o777).toBe(0o600);
  });
});
