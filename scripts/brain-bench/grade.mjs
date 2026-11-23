// Grades answers and writes the report. Two graders mark every answer: plain
// text rules here, and a second model that is shown the answer key
// (judge.mjs). Where both ran, the second grader's verdict is the score and
// every disagreement is listed for a person to check.
import { ADDS } from './designs.mjs';

/** Lower-case, drop punctuation and possessives, keep numbers intact ("$2,450/month" -> "2450 month"). */
export function normalize(text) {
  return ` ${String(text)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’']s\b/g, '')
    .replace(/[‘’']/g, '')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/\.(?!\d)|(?<!\d)\./g, ' ')
    .replace(/-(?!\d)|(?<!\d)-/g, ' ')
    .replace(/\/(?!\d)|(?<!\d)\//g, ' ')
    .replace(/[^a-z0-9./-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;
}

/** True when the phrase appears in the answer as whole words. */
export function has(answer, phrase) {
  return normalize(answer).includes(normalize(phrase));
}

const ABSTAIN = new RegExp([
  '\\b(dont|do not|didnt|did not|couldnt|could not|cant|cannot|wasnt able to|unable to|not able to) (know|have|find|see|locate)\\b',
  '\\b(doesnt|does not|dont|do not|didnt|did not) (mention|list|include|say|show|contain|record|hold)\\b',
  '\\b(no|not any) (record|information|info|memory|memories|mention|entry|entries|notes?|details?|saved|matching|match)\\b',
  '\\b(has|have|had|holds|returned|found) (no|nothing)\\b',
  '\\b(not|isnt|arent|wasnt) (recorded|saved|stored|listed|on record|on file|in (your|the|my) (record|records|vault|northkeep|notes|pages?)|something (northkeep|i|your record))\\b',
  '\\bnothing (saved|recorded|on record|on file|about|in)\\b',
  '\\b(havent|have not|hasnt|has not) (been told|been saved|been recorded|saved|recorded)\\b',
].join('|'));

const FLAG = new RegExp([
  '\\b(disputed?|unresolved|unclear|unsettled|undecided|not settled|open question)\\b',
  '\\b(still|is|are|remains?) (open|unknown)\\b',
  '\\b(conflict(s|ing)?|disagree(s|ment)?|discrepanc(y|ies)|inconsisten(t|cy)|contradict(s|ory|ion)?|dont match|do not match|dont agree|do not agree)\\b',
  '\\b(records|notes|entries|answers|memories|versions|sources) (differ|say different)\\b',
  '\\btwo (different |separate )?(records|notes|entries|answers|memories|versions)\\b',
  '\\b(cant|cannot|can not) (confirm|say for sure|tell which|be sure)\\b',
  '\\bnot (sure|certain|clear) which\\b',
  '\\b(ask|asking|check with|confirm with) you\\b',
  '\\b(tell|let) me (know )?which\\b',
].join('|'));

export function abstains(answer) { return ABSTAIN.test(normalize(answer)); }
export function flags(answer) { return FLAG.test(normalize(answer)); }

/**
 * The rules' verdict for one answer:
 *   correct     the answer key is satisfied
 *   incomplete  part of a multi-part answer, and nothing out of date
 *   abstained   said it does not know, when an answer existed
 *   wrong       gave something else, or made up an answer that is nowhere
 * `stale` is true when the answer mentions the out-of-date value.
 */
export function gradeAnswer(question, answer) {
  const stale = question.must_not.some((phrase) => has(answer, phrase));
  if (question.expect === 'abstain') return { verdict: abstains(answer) ? 'correct' : 'wrong', stale };
  if (question.expect === 'flag') {
    const namesBoth = question.both.length > 0 && question.both.every((phrase) => has(answer, phrase));
    return { verdict: flags(answer) || namesBoth ? 'correct' : abstains(answer) ? 'abstained' : 'wrong', stale };
  }
  const met = question.must.filter((group) => group.some((phrase) => has(answer, phrase))).length;
  if (met === question.must.length) return { verdict: 'correct', stale };
  if (met > 0 && !stale) return { verdict: 'incomplete', stale };
  if (abstains(answer) && !stale) return { verdict: 'abstained', stale };
  return { verdict: 'wrong', stale };
}

/** The verdict that counts: the second grader's when it ran, else the rules'. */
export const finalVerdict = (row) => row.judge_verdict ?? row.rule_verdict;

/** 95% range for a share of k out of n (Wilson), as whole numbers out of n. */
export function range95(k, n) {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const p = k / n;
  const mid = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
  return [Math.max(0, Math.round((mid - half) * n)), Math.min(n, Math.round((mid + half) * n))];
}

/** Chance that a split this lopsided, b against c, comes from two equal designs (exact paired test). */
export function chanceOfSplit(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  let tail = 0;
  let choose = 1;
  for (let i = 0; i <= Math.min(b, c); i += 1) {
    tail += choose;
    choose = (choose * (n - i)) / (i + 1);
  }
  return Math.min(1, (2 * tail) / 2 ** n);
}

const VERDICTS = ['correct', 'incomplete', 'abstained', 'wrong'];

/** Totals for one design's graded sessions. */
export function summarize(rows) {
  const valid = rows.filter((row) => !row.error);
  const count = (pick) => valid.filter(pick).length;
  const byVerdict = Object.fromEntries(VERDICTS.map((v) => [v, count((row) => finalVerdict(row) === v)]));
  const cats = [...new Set(valid.map((row) => row.cat))];
  const byCat = Object.fromEntries(cats.map((cat) => [cat, { correct: count((row) => row.cat === cat && finalVerdict(row) === 'correct'), total: count((row) => row.cat === cat) }]));
  const missed = valid.filter((row) => finalVerdict(row) !== 'correct');
  const byQuestion = {};
  for (const row of valid) (byQuestion[row.id] ??= new Set()).add(finalVerdict(row) === 'correct');
  return {
    total: valid.length,
    errors: rows.length - valid.length,
    ...byVerdict,
    range: range95(byVerdict.correct, valid.length),
    looked: count((row) => row.looked),
    missed_without_looking: missed.filter((row) => !row.looked).length,
    missed_after_looking: missed.filter((row) => row.looked).length,
    stale_repeated: missed.filter((row) => row.stale).length,
    graders_disagree: count((row) => row.judge_verdict && row.judge_verdict !== row.rule_verdict),
    flipped: Object.values(byQuestion).filter((set) => set.size > 1).length,
    tool_calls: valid.reduce((sum, row) => sum + row.tool_calls.length, 0),
    cost_usd: valid.reduce((sum, row) => sum + (row.cost_usd ?? 0), 0),
    byCat,
  };
}

/** Questions only the first design got right, and only the second, matched by question and repeat. */
export function compare(before, after) {
  const key = (row) => `${row.id}#${row.repeat ?? 1}`;
  const right = (rows) => new Map(rows.filter((row) => !row.error).map((row) => [key(row), finalVerdict(row) === 'correct']));
  const a = right(before);
  const b = right(after);
  let onlyBefore = 0;
  let onlyAfter = 0;
  for (const [k, ok] of a) {
    if (!b.has(k)) continue;
    if (ok && !b.get(k)) onlyBefore += 1;
    if (!ok && b.get(k)) onlyAfter += 1;
  }
  return { onlyBefore, onlyAfter, chance: chanceOfSplit(onlyBefore, onlyAfter) };
}

const LABELS = { search: 'Today\'s search', brief: 'Brief', nudge: 'Look-first', tidy: 'Cleanup', pages: 'Pages', 'pages-index': 'Pages with index' };
const label = (arm) => LABELS[arm] ?? arm;
const CAT_LABELS = {
  core: 'Confirmed core facts', direct: 'Plain facts', paraphrase: 'Different wording', stale: 'Old note vs newer fact',
  changed: 'Fact that changed', split: 'Answer in two places', absent: 'Not recorded anywhere', trap: 'Marked as disputed',
  conflict: 'Two records disagree', own_stale: 'App\'s own notes out of date', own_only: 'Only in app\'s own notes',
  project: 'In a project', same_name: 'Two people, one first name',
};
/** A paired comparison in words: the percentage is how often two equal designs would split this unevenly. */
const chanceWords = (c) => (c.onlyBefore + c.onlyAfter === 0 ? 'no change' : c.chance < 0.05 ? `unlikely (${c.chance < 0.001 ? 'under 0.1' : (c.chance * 100).toFixed(1)}%)` : `yes (${Math.round(c.chance * 100)}%)`);
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.join(' | ')} |`)];

/** The report, in Markdown. `arms` maps each design to its graded rows, in ladder order. */
export function renderReport({ model, app, search, date, arms }) {
  const names = Object.keys(arms);
  const sums = Object.fromEntries(names.map((arm) => [arm, summarize(arms[arm])]));
  const judged = names.some((arm) => arms[arm].some((row) => row.judge_verdict));
  const out = [
    `# Brain bench: ${date}`, '',
    `Agent: Claude Code as a ${app} app, model \`${model}\`, ${search} search, one new session per question. Fictional data only.`,
    judged ? 'Scored by a second model that sees the answer key; plain text rules mark every answer too.' : 'Scored by plain text rules only (no second grader on this run).',
    '',
    ...table(
      ['Design', 'What it adds', 'Correct', 'Likely range', 'Wrong', 'Incomplete', 'Said it did not know', 'Looked in NorthKeep'],
      names.map((arm) => { const s = sums[arm]; return [label(arm), ADDS[arm] ?? '', `${s.correct} of ${s.total}`, `${s.range[0]} to ${s.range[1]}`, s.wrong, s.incomplete, s.abstained, `${s.looked} of ${s.total}`]; }),
    ),
    '',
    '"Wrong" matters most: a confident answer that is not right. "Likely range" is where the score would probably land if the same test were run again.',
    '',
  ];
  if (names.length > 1) {
    out.push('## What each step added', '', 'Each design adds one thing to the one above it. A step counts only if the split is unlikely to be chance.', '');
    out.push(...table(
      ['Step', 'Adds', 'Newly right', 'Newly not right', 'Could this be chance?'],
      names.slice(1).map((arm, i) => {
        const c = compare(arms[names[i]], arms[arm]);
        return [`${label(names[i])} to ${label(arm)}`, ADDS[arm] ?? '', c.onlyAfter, c.onlyBefore, chanceWords(c)];
      }),
    ), '');
    out.push(`## Against ${label(names[0]).toLowerCase()}`, '', 'One step can be too small to tell from chance while several together are not.', '');
    out.push(...table(
      ['Design', 'Newly right', 'Newly not right', 'Could this be chance?'],
      names.slice(1).map((arm) => { const c = compare(arms[names[0]], arms[arm]); return [label(arm), c.onlyAfter, c.onlyBefore, chanceWords(c)]; }),
    ), '');
  }
  out.push('## Where the misses came from', '', ...table(
    ['Design', 'Missed without looking', 'Missed after looking', 'Repeated an out-of-date value', 'Answer changed between repeats'],
    names.map((arm) => [label(arm), sums[arm].missed_without_looking, sums[arm].missed_after_looking, sums[arm].stale_repeated, sums[arm].flipped]),
  ), '');
  const cats = Object.keys(CAT_LABELS).filter((cat) => names.some((arm) => sums[arm].byCat[cat]));
  out.push('## Correct answers by kind of question', '', 'These groups are small, so read them as hints, not results.', '', ...table(
    ['Kind', ...names.map(label)],
    cats.map((cat) => [CAT_LABELS[cat], ...names.map((arm) => { const c = sums[arm].byCat[cat]; return c ? `${c.correct} of ${c.total}` : 'not run'; })]),
  ), '');
  out.push('## Cost and checks', '', ...table(
    ['Design', 'Tool calls', 'Cost at list price', 'Sessions that failed to run', 'Graders disagreed'],
    names.map((arm) => [label(arm), sums[arm].tool_calls, `$${sums[arm].cost_usd.toFixed(2)}`, sums[arm].errors, sums[arm].graders_disagree]),
  ), '');
  const short = (row) => row.answer.replace(/\s+/g, ' ').slice(0, 220);
  if (judged) {
    out.push('## Answers the two graders marked differently', '');
    const split = names.flatMap((arm) => arms[arm].filter((row) => !row.error && row.judge_verdict && row.judge_verdict !== row.rule_verdict).map((row) => `- ${label(arm)} \`${row.id}\`: rules said ${row.rule_verdict}, second grader said ${row.judge_verdict}: "${short(row)}"`));
    out.push(...(split.length ? split : ['None.']), '');
  }
  out.push('## Every answer that was not correct', '');
  for (const arm of names) {
    out.push(`### ${label(arm)}`, '');
    const missed = arms[arm].filter((row) => !row.error && finalVerdict(row) !== 'correct');
    if (missed.length === 0) out.push('None.');
    for (const row of missed) out.push(`- \`${row.id}\` ${finalVerdict(row)}${row.looked ? '' : ', did not look'}: "${row.q}" answered "${short(row)}"`);
    out.push('');
  }
  return out.join('\n');
}
