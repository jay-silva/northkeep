// Grades an answer against the answer key with plain text rules, so the score
// does not depend on a model's opinion. Every transcript is kept for a person
// to check.

/** Lower-case, drop punctuation, keep numbers intact ("$2,450" -> "2450", "6.75" stays). */
export function normalize(text) {
  return ` ${String(text)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’']/g, '')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/\.(?!\d)|(?<!\d)\./g, ' ')
    .replace(/-(?!\d)|(?<!\d)-/g, ' ')
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
  '\\bno (record|information|info|memory|memories|mention|entry|entries|notes?|details?|saved)\\b',
  '\\b(not|isnt|arent|wasnt) (recorded|saved|stored|listed|on record|in (your|the|my) (record|records|vault|northkeep|notes))\\b',
  '\\bnothing (saved|recorded|on record|about|in)\\b',
  '\\b(havent|have not|hasnt|has not) (been told|been saved|been recorded|saved|recorded)\\b',
].join('|'));

const FLAG = new RegExp([
  '\\b(disputed?|unresolved|unclear|unsettled|not settled|open question)\\b',
  '\\b(conflict(s|ing)?|disagree(s|ment)?|discrepanc(y|ies)|inconsisten(t|cy)|contradict(s|ory|ion)?|dont match|do not match)\\b',
  '\\btwo (different |separate )?(records|notes|entries|answers|memories|versions)\\b',
  '\\b(cant|cannot|can not) (confirm|say for sure|tell which|be sure)\\b',
  '\\bnot (sure|certain|clear) which\\b',
  '\\bwhich (one|entity|is right|is correct)\\b',
  '\\b(ask|check with|confirm with) (you|morgan)\\b',
  '\\byou (should|need to|will need to|would need to|must) (confirm|decide|tell me|say)\\b',
].join('|'));

export function abstains(answer) { return ABSTAIN.test(normalize(answer)); }
export function flags(answer) { return FLAG.test(normalize(answer)); }

/**
 * Verdict for one answer:
 *   correct     the answer key is satisfied
 *   incomplete  part of a multi-part answer, and nothing out of date
 *   abstained   said it does not know, when an answer existed
 *   wrong       gave something else, or made up an answer that is nowhere
 * `stale` is true when the answer repeats the out-of-date value.
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

const VERDICTS = ['correct', 'incomplete', 'abstained', 'wrong'];

/** Totals for one design's graded sessions. */
export function summarize(rows) {
  const valid = rows.filter((row) => !row.error);
  const count = (pick) => valid.filter(pick).length;
  const byVerdict = Object.fromEntries(VERDICTS.map((v) => [v, count((row) => row.verdict === v)]));
  const cats = [...new Set(valid.map((row) => row.cat))];
  const byCat = Object.fromEntries(cats.map((cat) => [cat, { correct: count((row) => row.cat === cat && row.verdict === 'correct'), total: count((row) => row.cat === cat) }]));
  const missed = valid.filter((row) => row.verdict !== 'correct');
  return {
    total: valid.length,
    errors: rows.length - valid.length,
    ...byVerdict,
    looked: count((row) => row.looked),
    missed_without_looking: missed.filter((row) => !row.looked).length,
    missed_after_looking: missed.filter((row) => row.looked).length,
    stale_repeated: count((row) => row.stale && row.verdict !== 'correct'),
    tool_calls: valid.reduce((sum, row) => sum + row.tool_calls.length, 0),
    cost_usd: valid.reduce((sum, row) => sum + (row.cost_usd ?? 0), 0),
    byCat,
  };
}

const LABELS = { search: 'Today\'s search', brief: 'Search plus brief', pages: 'Pages plus brief' };
const CAT_LABELS = {
  core: 'Confirmed core facts', direct: 'Plain facts', paraphrase: 'Different wording', stale: 'Old note vs newer fact',
  changed: 'Fact that changed', split: 'Answer in two places', absent: 'Not recorded anywhere', trap: 'Marked as disputed',
  conflict: 'Two records disagree', own_stale: 'App\'s own notes out of date', own_only: 'Only in app\'s own notes',
  project: 'In a project', same_name: 'Two people, one first name',
};

/** The one-page report, in Markdown. */
export function renderReport({ model, date, arms }) {
  const names = Object.keys(arms);
  const sums = Object.fromEntries(names.map((arm) => [arm, summarize(arms[arm])]));
  const out = [`# Brain bench: ${date}`, '', `Agent: Claude Code, model \`${model}\`, one new session per question. Fictional data only.`, ''];
  out.push('| Design | Correct | Incomplete | Said it did not know | Wrong | Looked in NorthKeep |', '| --- | --- | --- | --- | --- | --- |');
  for (const arm of names) {
    const s = sums[arm];
    out.push(`| ${LABELS[arm] ?? arm} | ${s.correct} of ${s.total} | ${s.incomplete} | ${s.abstained} | ${s.wrong} | ${s.looked} of ${s.total} |`);
  }
  out.push('', '"Wrong" is the count that matters most: a confident answer that is not right.', '');
  out.push('## Where the misses came from', '', '| Design | Missed without looking | Missed after looking | Repeated an out-of-date value |', '| --- | --- | --- | --- |');
  for (const arm of names) out.push(`| ${LABELS[arm] ?? arm} | ${sums[arm].missed_without_looking} | ${sums[arm].missed_after_looking} | ${sums[arm].stale_repeated} |`);
  out.push('', '## Correct answers by kind of question', '', `| Kind | ${names.map((arm) => LABELS[arm] ?? arm).join(' | ')} |`, `| --- | ${names.map(() => '---').join(' | ')} |`);
  const cats = Object.keys(CAT_LABELS).filter((cat) => names.some((arm) => sums[arm].byCat[cat]));
  for (const cat of cats) out.push(`| ${CAT_LABELS[cat]} | ${names.map((arm) => { const c = sums[arm].byCat[cat]; return c ? `${c.correct} of ${c.total}` : 'not run'; }).join(' | ')} |`);
  out.push('', '## Cost', '', '| Design | Tool calls | Cost at list price | Sessions that failed to run |', '| --- | --- | --- | --- |');
  for (const arm of names) out.push(`| ${LABELS[arm] ?? arm} | ${sums[arm].tool_calls} | $${sums[arm].cost_usd.toFixed(2)} | ${sums[arm].errors} |`);
  out.push('', '## Every answer that was not correct', '');
  for (const arm of names) {
    out.push(`### ${LABELS[arm] ?? arm}`, '');
    const missed = arms[arm].filter((row) => !row.error && row.verdict !== 'correct');
    if (missed.length === 0) out.push('None.', '');
    for (const row of missed) out.push(`- \`${row.id}\` ${row.verdict}${row.looked ? '' : ', did not look'}: "${row.q}" answered "${row.answer.replace(/\s+/g, ' ').slice(0, 220)}"`);
    out.push('');
  }
  return out.join('\n');
}
