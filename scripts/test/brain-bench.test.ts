import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain Node script without type declarations
import { gradeAnswer, summarize } from '../brain-bench/grade.mjs';
// @ts-expect-error plain Node script without type declarations
import { APP_NOTES, MEMORIES, QUESTIONS } from '../brain-bench/world.mjs';
// @ts-expect-error plain Node script without type declarations
import { INSTRUCTION_BUDGET, extraInstructions, findPage } from '../brain-bench/designs.mjs';
// @ts-expect-error plain Node script without type declarations
import { assertThrowawayHome, seedHome } from '../brain-bench/seed.mjs';
// @ts-expect-error plain Node script without type declarations
import { pickQuestions } from '../brain-bench/run.mjs';

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
  });

  it('matches whole words and whole numbers only', () => {
    expect(verdict('direct-03', 'It has 18 beds.')).toBe('wrong');
    expect(verdict('stale-09', 'Staylark takes 12%.')).toBe('wrong');
    expect(verdict('changed-05', 'Rent is $24,500 a year.')).toBe('wrong');
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
  });

  it('wants a disputed fact flagged, not picked', () => {
    expect(verdict('trap-01', 'That is disputed. The operating agreement and the loan papers name different entities.')).toBe('correct');
    expect(verdict('trap-01', 'Larkspur Holdings LLC holds your half.')).toBe('wrong');
    expect(verdict('conflict-01', 'One record says $1,700 and another says $2,000.')).toBe('correct');
    expect(verdict('conflict-02', 'Sam Whitlock is on call Christmas Day.')).toBe('wrong');
  });

  it('counts misses by whether the agent looked', () => {
    const row = (v: string, looked: boolean) => ({ cat: 'core', verdict: v, looked, stale: false, tool_calls: looked ? [{}] : [], cost_usd: 0.01, error: null });
    const s = summarize([row('correct', true), row('wrong', false), row('abstained', true), { error: 'no answer', tool_calls: [] }]);
    expect(s).toMatchObject({ total: 3, errors: 1, correct: 1, wrong: 1, abstained: 1, looked: 2, missed_without_looking: 1, missed_after_looking: 1 });
  });
});

describe('brain-bench world', () => {
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

  it('adds nothing to today\'s search, confirmed facts to the brief, and the page list to pages', () => {
    expect(extraInstructions('search', { baseLength: 900, facts, projects, pages })).toBe('');
    const brief = extraInstructions('brief', { baseLength: 900, facts, projects, pages });
    expect(brief).toContain('A confirmed fact.');
    expect(brief).not.toContain('An unconfirmed fact.');
    expect(brief).toContain('alpha');
    expect(extraInstructions('pages', { baseLength: 900, facts, projects, pages })).toContain('Pages: Pat Example.');
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
});
