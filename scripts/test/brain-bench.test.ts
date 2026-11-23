import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain Node script without type declarations
import { chanceOfSplit, compare, gradeAnswer, range95, renderReport, summarize } from '../brain-bench/grade.mjs';
// @ts-expect-error plain Node script without type declarations
import { describeKey } from '../brain-bench/judge.mjs';
// @ts-expect-error plain Node script without type declarations
import { APP_NOTES, MEMORIES, QUESTIONS } from '../brain-bench/world.mjs';
// @ts-expect-error plain Node script without type declarations
import { ARMS, INSTRUCTION_BUDGET, extraInstructions, findPage, tidyMemories } from '../brain-bench/designs.mjs';
// @ts-expect-error plain Node script without type declarations
import { assertThrowawayHome, seedHome } from '../brain-bench/seed.mjs';
// @ts-expect-error plain Node script without type declarations
import { pickQuestions } from '../brain-bench/run.mjs';
// @ts-expect-error plain Node script without type declarations
import { holdsAnswer, makeRules } from '../brain-bench/replay.mjs';
// @ts-expect-error plain Node script without type declarations
import { KEPT_CASES, RANKING_CASES, answerRank, passes } from '../brain-bench/ranking-cases.mjs';
// @ts-expect-error plain Node script without type declarations
import { PROPOSED_FOUND_FIRST, baseInstructions } from '../brain-bench/designs.mjs';
import * as searchRules from '../../packages/core/src/search-rules.js';

type Question = { id: string; cat: string; q: string; expect: string; must: string[][]; must_not: string[]; both?: string[] };
const question = (id: string): Question => (QUESTIONS as Question[]).find((x) => x.id === id)!;
const verdict = (id: string, answer: string) => gradeAnswer(question(id), answer).verdict;

describe('brain-bench grader', () => {
  it('accepts the right fact however it is punctuated', () => {
    expect(verdict('changed-05', 'Rent is **$2,450** a month since the June renewal.')).toBe('correct');
    expect(verdict('core-07', 'Sign it "Morgan A. Vale".')).toBe('correct');
    expect(verdict('para-08', 'You hold a 100-ton master license.')).toBe('correct');
    expect(verdict('direct-02', 'Marisol Peña cleans it.')).toBe('correct');
    expect(verdict('stale-01', 'It closed at 6.75% fixed.')).toBe('correct');
    expect(verdict('stale-06', 'She charges $165/changeover.')).toBe('correct');
    expect(verdict('name-02', "Tenant calls are Dana Okafor's job.")).toBe('correct');
    expect(verdict('direct-06', 'It is due 12 Feb 2027.')).toBe('correct');
  });

  it('matches whole words and whole numbers only', () => {
    expect(verdict('direct-03', 'It has 18 beds.')).toBe('wrong');
    expect(verdict('stale-09', 'Staylark takes 12%.')).toBe('wrong');
    expect(verdict('changed-05', 'Rent is $24,500 a year.')).toBe('wrong');
    expect(verdict('direct-03', 'I only see 8 Alder Lane in your record.')).not.toBe('correct');
    expect(verdict('direct-13', 'Probably some time in 2028.')).not.toBe('correct');
  });

  it('calls the out-of-date value wrong and marks it stale', () => {
    expect(gradeAnswer(question('stale-01'), 'The refinance closed at 7.10% fixed.')).toEqual({ verdict: 'wrong', stale: true });
    expect(gradeAnswer(question('own-stale-01'), 'You go to IronWorks on Dock Street.')).toEqual({ verdict: 'wrong', stale: true });
    // Giving the current value and naming the old one is still correct.
    expect(gradeAnswer(question('own-stale-01'), 'Harbor Athletic Club. You left IronWorks in October.')).toEqual({ verdict: 'correct', stale: true });
  });

  it('separates an incomplete answer and an honest "I do not know" from a wrong one', () => {
    expect(verdict('split-01', 'Your records list one dog, Biscuit.')).toBe('incomplete');
    expect(verdict('changed-01', "I don't have a record of what car you drive.")).toBe('abstained');
    expect(verdict('changed-01', 'You drive a 2015 Honda CR-V.')).toBe('wrong');
  });

  it('wants "not recorded" when the fact is nowhere', () => {
    expect(verdict('absent-01', "I couldn't find your favorite food in your record.")).toBe('correct');
    expect(verdict('absent-01', 'Your favorite food is lobster rolls.')).toBe('wrong');
    for (const honest of ["Your record doesn't mention a favorite food.", 'NorthKeep returned no matching memories.', "That isn't something NorthKeep has on file."]) {
      expect(verdict('absent-01', honest), honest).toBe('correct');
    }
  });

  it('wants a disputed fact flagged, not picked', () => {
    expect(verdict('trap-01', 'That is disputed. The operating agreement and the loan papers name different entities.')).toBe('correct');
    expect(verdict('trap-01', 'Larkspur Holdings LLC holds your half.')).toBe('wrong');
    expect(verdict('conflict-01', 'One record says $1,700 and another says $2,000.')).toBe('correct');
    expect(verdict('conflict-02', 'Sam Whitlock is on call Christmas Day.')).toBe('wrong');
    expect(verdict('conflict-02', 'The two roster entries differ, so I cannot say.')).toBe('correct');
    expect(verdict('trap-01', 'As for which entity holds your half: Larkspur Holdings LLC.')).toBe('wrong');
  });

  it('counts misses by whether the agent looked', () => {
    const row = (id: string, v: string, looked: boolean) => ({ id, cat: 'core', rule_verdict: v, looked, stale: false, tool_calls: looked ? [{}] : [], cost_usd: 0.01, error: null });
    const s = summarize([row('a', 'correct', true), row('b', 'wrong', false), row('c', 'abstained', true), { error: 'no answer', tool_calls: [] }]);
    expect(s).toMatchObject({ total: 3, errors: 1, correct: 1, wrong: 1, abstained: 1, looked: 2, missed_without_looking: 1, missed_after_looking: 1 });
  });

  it('scores by the second grader when it ran, and counts the disagreement', () => {
    const row = { id: 'a', cat: 'stale', rule_verdict: 'correct', judge_verdict: 'wrong', looked: true, stale: true, tool_calls: [], cost_usd: 0, error: null };
    expect(summarize([row])).toMatchObject({ correct: 0, wrong: 1, graders_disagree: 1, stale_repeated: 1 });
  });

  it('tells a real gap from chance', () => {
    expect(chanceOfSplit(0, 3)).toBeCloseTo(0.25, 5);
    expect(chanceOfSplit(1, 12)).toBeLessThan(0.05);
    expect(chanceOfSplit(0, 0)).toBe(1);
    expect(range95(50, 100)).toEqual([40, 60]);
    const rows = (right: boolean[]) => right.map((ok, i) => ({ id: `q${i}`, rule_verdict: ok ? 'correct' : 'wrong', error: null }));
    expect(compare(rows([true, false, false, true]), rows([true, true, true, false]))).toMatchObject({ onlyBefore: 1, onlyAfter: 2 });
  });

  it('reports each step, and each design against the first', () => {
    const rows = (right: boolean[]) => right.map((ok, i) => ({ id: `q${i}`, cat: 'core', q: 'Q?', answer: 'A', rule_verdict: ok ? 'correct' : 'wrong', looked: true, stale: false, tool_calls: [], cost_usd: 0, error: null }));
    const none = Array.from({ length: 12 }, () => false);
    const report = renderReport({ model: 'm', app: 'chat', search: 'keyword', date: '2026-11-23', arms: { search: rows(none), nudge: rows(none.map((_, i) => i < 3)), pages: rows(none.map(() => true)) } }) as string;
    expect(report).toContain('| Today\'s search to Look-first | a firmer "look it up first" sentence | 3 | 0 | yes (25%) |');
    expect(report).toContain('## Against today\'s search');
    expect(report).toContain('| Pages | 12 | 0 | unlikely (under 0.1%) |');
  });

  it('tells the second grader what the record holds', () => {
    expect(describeKey(question('absent-01'))).toMatch(/not recorded anywhere/);
    expect(describeKey(question('conflict-01'))).toMatch(/\$1,700 and \$2,000/);
    expect(describeKey(question('own-stale-01'))).toMatch(/"harbor athletic".*out-of-date value is "ironworks"/);
  });
});

describe('brain-bench world', () => {
  it('names the old value for every question about a fact that changed', () => {
    const changed = (QUESTIONS as Question[]).filter((x) => x.cat === 'changed' || x.cat === 'own_stale');
    for (const x of changed) expect(x.must_not.length, x.id).toBeGreaterThan(0);
    expect(gradeAnswer(question('changed-03'), 'The provider is Pinecone Wireless.')).toEqual({ verdict: 'wrong', stale: true });
    expect(gradeAnswer(question('changed-03'), 'Greenline Fiber, since May 2026. It was Pinecone Wireless before.')).toEqual({ verdict: 'correct', stale: true });
  });

  it('has 100 questions with unique ids and a usable answer key', () => {
    const all = QUESTIONS as Question[];
    expect(all.length).toBe(100);
    expect(new Set(all.map((x) => x.id)).size).toBe(100);
    for (const x of all) {
      if (x.expect === 'answer') expect(x.must.length, x.id).toBeGreaterThan(0);
      expect(['answer', 'abstain', 'flag'], x.id).toContain(x.expect);
    }
  });

  it('keeps every "not recorded" answer out of the record and the app notes', () => {
    const everything = [...(MEMORIES as { text: string }[]).map((x) => x.text), ...(APP_NOTES as string[])].join('\n').toLowerCase();
    for (const word of ['favorite food', 'passport', 'property tax', 'license plate', 'password', 'frequent flyer', 'per hour', 'teacher']) {
      expect(everything, word).not.toContain(word);
    }
  });

  it('picks questions by kind, id and sample size', () => {
    expect(pickQuestions({ only: 'trap,core-01', sample: 0 }).map((x: Question) => x.id)).toEqual(['core-01', 'trap-01', 'trap-02']);
    expect(pickQuestions({ only: null, sample: 1 }).length).toBe(13);
  });
});

describe('brain-bench designs', () => {
  const facts = [
    { content: 'A confirmed fact.', type: 'identity', confirmed: true },
    { content: 'An unconfirmed fact.', type: 'semantic', confirmed: false },
  ];
  const projects = [{ slug: 'alpha', title: 'Alpha' }];
  const pages = [{ name: 'Pat Example', also: ['Pat'], kind: 'person', summary: 's', body: 'b' }];

  it('adds one thing at each step of the ladder', () => {
    const text = Object.fromEntries((ARMS as string[]).map((arm) => [arm, extraInstructions(arm, { baseLength: 900, facts, projects, pages }) as string]));
    expect(text.search).toBe('');
    expect(text.brief).toContain('A confirmed fact.');
    expect(text.brief).not.toContain('An unconfirmed fact.');
    expect(text.brief).toContain('alpha');
    expect(text.brief).not.toContain('look it up in NorthKeep first');
    expect(text.nudge).toBe(`${text.nudge.split('\n')[0]}\n${text.brief}`);
    expect(text.nudge).toContain('look it up in NorthKeep first');
    expect(text.tidy).toBe(text.nudge);
    expect(text.pages).toContain('page_get');
    expect(text.pages).not.toContain('Pat Example');
    expect(text['pages-index']).toContain('Pages: Pat Example.');
  });

  it('turns each line of a page into one ordinary memory led by the page name', () => {
    expect(tidyMemories([{ name: 'Heron Cabin', body: '- Sleeps eight.\n- Insured with Alder Mutual.\n' }])).toEqual(['Heron Cabin: Sleeps eight.', 'Heron Cabin: Insured with Alder Mutual.']);
  });

  it('drops whole lines rather than exceed what the agent will show', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ content: `Confirmed fact number ${i} about something.`, type: 'identity', confirmed: true }));
    const extra = extraInstructions('brief', { baseLength: 900, facts: many, projects, pages });
    expect(900 + 1 + extra.length).toBeLessThanOrEqual(INSTRUCTION_BUDGET);
    expect(extra.endsWith('.')).toBe(true);
  });

  it('finds a page by name or other name, ignoring case', () => {
    expect(findPage(pages, 'pat')?.name).toBe('Pat Example');
    expect(findPage(pages, 'PAT EXAMPLE')?.name).toBe('Pat Example');
    expect(findPage(pages, 'Nobody')).toBeNull();
  });
});

describe('brain-bench seed', () => {
  const dirs: string[] = [];
  const saved = { home: process.env.NORTHKEEP_HOME, keychain: process.env.NORTHKEEP_NO_KEYCHAIN };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    if (saved.home === undefined) delete process.env.NORTHKEEP_HOME; else process.env.NORTHKEEP_HOME = saved.home;
    if (saved.keychain === undefined) delete process.env.NORTHKEEP_NO_KEYCHAIN; else process.env.NORTHKEEP_NO_KEYCHAIN = saved.keychain;
  });

  it('refuses a home that is not a bench throwaway', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nk-bench-'));
    dirs.push(dir);
    expect(() => assertThrowawayHome(dir)).toThrow(/not a brain-bench throwaway/);
    expect(() => assertThrowawayHome('')).toThrow(/not a brain-bench throwaway/);
  });

  it('builds the world in a new home, with past dates, and will not write into an existing one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nk-bench-'));
    dirs.push(dir);
    const home = join(dir, 'home');
    const now = Date.parse('2026-11-23T12:00:00.000Z');
    const seeded = await seedHome(home, now);
    expect(seeded.facts.length).toBe((MEMORIES as unknown[]).length);
    expect(seeded.facts.filter((f: { confirmed: boolean }) => f.confirmed).length).toBe(18);
    expect(seeded.facts.find((f: { content: string }) => f.content === 'Felix attends Birchwood Elementary.').saved).toBe('2025-07-11');
    expect(seeded.projects.length).toBe(6);
    expect(() => assertThrowawayHome(home)).not.toThrow();
    await expect(seedHome(home, now)).rejects.toThrow(/already exists/);
  });

  it('adds the cleaned-up facts as fresh memories for the cleanup design', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nk-bench-'));
    dirs.push(dir);
    const home = join(dir, 'home');
    await seedHome(home, Date.now(), ['Heron Cabin: Sleeps eight.']);
    process.env.NORTHKEEP_HOME = home;
    // @ts-expect-error built output without a path mapping here
    const core = await import('../../packages/core/dist/index.js');
    const vault = core.Vault.open({ path: join(home, 'vault.nkv'), passphrase: 'brain-bench-throwaway', deviceSecret: core.loadDeviceSecret() });
    const found = vault.retrieve('Heron Cabin sleeps', { skipProjectPaperwork: true });
    vault.close();
    const tidy = found.find((r: { entry: { content: string } }) => r.entry.content === 'Heron Cabin: Sleeps eight.');
    expect(tidy?.entry.source).toBe('mcp:curator');
    expect(Date.now() - Date.parse(tidy.entry.created_at)).toBeLessThan(2 * 86_400_000);
  });
});

describe('brain-bench replay', () => {
  const now = Date.parse('2026-11-23T12:00:00.000Z');
  const row = (content: string, confirmed = false) => ({
    entry: { content, type: confirmed ? 'identity' : 'semantic', source: 'cli', created_at: '2026-11-10T12:00:00.000Z', metadata: confirmed ? { confirmed: { by: 'user', at: 'x' } } : null },
    terms: searchRules.searchTerms(content),
  });
  const rows = [
    row("Pat's car is a blue hatchback"),
    ...Array.from({ length: 12 }, (_, i) => row(`Pat keeps ledger ${i} in the harbor office`, true)),
    ...Array.from({ length: 12 }, (_, i) => row(`Tide table ${i} is pinned by the door`)),
  ];
  const top = (rule: string, query: string): string[] => (makeRules(searchRules)[rule](rows, searchRules.searchTerms(query), now) as { row: { entry: { content: string } } }[]).slice(0, 8).map((s) => s.row.entry.content);

  it('shows the shipped rule losing the answer to confirmed rows that match only the name', () => {
    expect(top('As shipped (0.29.0)', 'car vehicle Pat drives')).not.toContain("Pat's car is a blue hatchback");
    expect(top('Fix 2: common-only matches last', 'car vehicle Pat drives')[0]).toBe("Pat's car is a blue hatchback");
    expect(top('ADR 0089: rank by rarity', 'car vehicle Pat drives')[0]).toBe("Pat's car is a blue hatchback");
  });

  it('counts an answer as found only when every part of it came back', () => {
    const split = question('split-01');
    expect(holdsAnswer(split, ["Morgan's dog Biscuit is a corgi born in 2021."])).toBe(false);
    expect(holdsAnswer(split, ["Morgan's dog Biscuit is a corgi born in 2021.", "Pepper is Morgan's second corgi."])).toBe(true);
  });
});

describe('brain-bench ranking cases', () => {
  const rules = makeRules(searchRules) as Record<string, unknown>;
  const lost = (rule: string): string[] => (RANKING_CASES as { name: string }[]).filter((c) => answerRank(rules[rule], searchRules, c) === 0).map((c) => c.name);

  it('the shipped rule loses the answer in five of the eleven hard cases', () => {
    expect(lost('As shipped (0.29.0)')).toEqual([
      'the name is in every confirmed memory', 'the name is in a fifth of the memories', 'ten memories left after a scope filter',
      'nine confirmed memories share a street name', 'a nickname in a tenth of the memories',
    ]);
  });

  it('both rejected fixes still lose answers', () => {
    expect(lost('Fix 1: drop common words').length).toBeGreaterThan(0);
    expect(lost('Fix 2: common-only matches last')).toContain('a padding word, and an answer made of common words');
  });

  it('each simpler rarity rule loses something the chosen one keeps', () => {
    expect(lost('Bonuses multiply, equal weights')).toEqual(['ten memories left after a scope filter']);
    expect(lost('Rarity, prior of 10, absent words counted')).toEqual([
      'a 300-word answer and a query word no memory holds',
      'a 450-word answer, confirmed, and a query word no memory holds',
      'a 700-word answer, confirmed, and a query word no memory holds',
    ]);
  });

  it('the ADR 0089 rule finds the answer in all eleven', () => {
    expect((RANKING_CASES as unknown[]).length).toBe(11);
    expect(lost('ADR 0089: rank by rarity')).toEqual([]);
  });

  it('and keeps three checks the product already makes, which rarity without a prior does not', () => {
    const failed = (rule: string): string[] => (KEPT_CASES as { name: string }[]).filter((c) => !passes(rules[rule], searchRules, c)).map((c) => c.name);
    expect(failed('As shipped (0.29.0)')).toEqual([]);
    expect(failed('ADR 0089: rank by rarity')).toEqual([]);
    expect(failed('Rarity, no prior')).toEqual(['a long row against a short exact answer, two memories', 'an answer split across two memories among project chatter']);
  });
});

describe('brain-bench reworded instruction', () => {
  it('replaces the shipped first paragraph and keeps the milestone rule', () => {
    const text = baseInstructions('look', { shipped: 'SHIPPED', milestoneRule: 'RULE' }) as string;
    expect(text).toBe(`${PROPOSED_FOUND_FIRST} RULE`);
    expect(text).toContain('even when your own saved notes or memories about the user seem to answer it');
    expect(baseInstructions('search', { shipped: 'SHIPPED', milestoneRule: 'RULE' })).toBe('SHIPPED');
  });
});
