// The second grader: a model that is shown each question, what the record
// really holds, and the answer, and gives a verdict. It catches what text
// rules cannot, such as an old value presented as current, or a made-up
// answer wrapped in "I'm not sure". It never sees which design answered.
import { runClaude } from './agent.mjs';

const SYSTEM = 'You are a strict grader. You judge only against the answer key you are given. You answer with JSON only.';

const TASK = `You are grading answers an AI assistant gave to its user. Each item has the question, what the user's record really holds, and the assistant's answer. Give one verdict per item:

- "correct": the answer gives the right fact as the current fact. Mentioning an older value as history is fine. If the key says the fact is not recorded, correct means the answer says it has no record and offers no specific answer of its own. If the key says the fact is disputed or that two records disagree, correct means the answer says so and does not present one side as settled.
- "incomplete": the right answer has several parts and the answer gives only some of them, with nothing wrong.
- "abstained": the answer says it does not know or has no record, when the key shows the record holds the answer.
- "wrong": anything else. That includes an out-of-date value given as current, a specific answer to a fact that is not recorded, and picking one side of a dispute.

Answer with JSON only, one entry per item, in order: {"verdicts":[{"n":1,"verdict":"correct"}]}

Items:
`;

/** What the record holds for a question, in words the grader can check against. */
export function describeKey(question) {
  if (question.expect === 'abstain') return 'This fact is not recorded anywhere, in the record or in the assistant\'s own notes.';
  if (question.expect === 'flag') return question.note;
  const parts = question.must.map((group) => (group.length === 1 ? `"${group[0]}"` : `one of ${group.slice(0, 6).map((p) => `"${p}"`).join(', ')}`));
  const old = question.must_not.length ? ` The out-of-date value is ${question.must_not.map((p) => `"${p}"`).join(' or ')}.` : '';
  return `The right answer names ${parts.join(' AND ')} (spelling and punctuation may differ).${old}`;
}

const VERDICTS = new Set(['correct', 'incomplete', 'abstained', 'wrong']);

/** Judge one batch. Returns a verdict per row, or null for a row the grader did not mark. */
export async function judgeBatch(rows, questions, model) {
  const items = rows.map((row, i) => ({ n: i + 1, question: row.q, record: describeKey(questions.get(row.id)), answer: row.answer.slice(0, 1500) }));
  const run = await runClaude({ prompt: TASK + JSON.stringify(items, null, 1), systemPrompt: SYSTEM, model, timeoutMs: 300_000 });
  if (run.error) return { verdicts: rows.map(() => null), cost_usd: 0, error: run.error };
  let parsed;
  try { parsed = JSON.parse(run.answer.slice(run.answer.indexOf('{'), run.answer.lastIndexOf('}') + 1)); } catch { parsed = null; }
  const byN = new Map((parsed?.verdicts ?? []).map((v) => [v.n, v.verdict]));
  return { verdicts: rows.map((_, i) => (VERDICTS.has(byN.get(i + 1)) ? byN.get(i + 1) : null)), cost_usd: run.cost_usd ?? 0, error: parsed ? null : 'the grader did not return JSON' };
}
