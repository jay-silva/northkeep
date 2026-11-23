// Hard cases for a ranking rule, each one a way a real fix attempt lost the
// answer (the reviews of ADR 0087 and of the rarity rule). A rule is ready
// when it finds the answer in all of them and loses none of the recorded
// searches in replay.mjs.
const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));
const fact = (content) => ({ content, confirmed: false });
const confirmed = (content) => ({ content, confirmed: true });
const filler = (n) => many(n, (i) => fact(`Tide table ${i} is pinned by the door`));
const ledgers = (n, who = 'Pat') => many(n, (i) => confirmed(`${who} keeps ledger ${i} in the harbor office`));

/** A long memory: its first sentence is the answer, followed by `n` words found nowhere else. */
const longAnswer = (n, isConfirmed) => ({
  content: `The vet appointment is on Friday at ten. ${many(n, (i) => `xword${i}`).join(' ')}`,
  confirmed: isConfirmed,
});
/** One query word, "dog", is in no memory; the answer is long. A rule that weighs the absent word wipes the answer out. */
const longAnswerCase = (n, isConfirmed) => ({
  name: `a ${n}-word answer${isConfirmed ? ', confirmed,' : ''} and a query word no memory holds`,
  query: 'when is the vet appointment for the dog', want: 'vet appointment is on Friday',
  memories: [longAnswer(n, isConfirmed), ...many(40, (i) => fact(`Vet bill ${i} was paid`)), ...many(30, (i) => fact(`Appointment ${i} with the bank moved`)), ...filler(1400)],
});

/** `want` is text only the answer holds; the answer must be among the first eight results. */
export const RANKING_CASES = [
  { name: 'the name is in every confirmed memory', query: 'car vehicle Pat drives', want: 'blue hatchback',
    memories: [fact("Pat's car is a blue hatchback"), ...ledgers(12), ...filler(12)] },
  { name: 'the rarer word is on an unrelated memory', query: 'Pat employer', want: 'Pat works at Harbor Rescue',
    memories: [fact("Robin's employer is Southcoast Marine"), confirmed('Pat works at Harbor Rescue'), ...ledgers(6), ...filler(20)] },
  { name: 'a padding word, and an answer made of common words', query: 'heron cabin corgi dog', want: 'called Biscuit',
    memories: [fact('The corgi at Heron Cabin is called Biscuit'), ...many(11, (i) => fact(`Heron sighting ${i} by the marsh`)), ...many(11, (i) => fact(`Cabin supply run ${i} is done`)),
      ...many(11, (i) => fact(`Corgi meetup ${i} was fun`)), ...many(9, (i) => fact(`Neighbor dog ${i} barked at night`)), ...filler(57)] },
  { name: 'the name is in a fifth of the memories', query: 'car Pat', want: 'blue hatchback',
    memories: [fact("Pat's car is a blue hatchback"), ...ledgers(10), ...many(11, (i) => fact(`Pat mentioned errand ${i}`)), ...filler(78)] },
  { name: 'ten memories left after a scope filter', query: 'Pat car', want: 'spare car key',
    memories: [fact('The spare car key hangs by the door'), ...many(9, (i) => confirmed(`Pat parks trailer ${i} in the garage`))] },
  { name: 'nine confirmed memories share a street name', query: 'Morgan Street water heater age', want: 'water heater',
    memories: [fact('The water heater at 12 Morgan Street was replaced in 2019'), ...many(9, (i) => confirmed(`Unit ${i} at 40 Morgan Street has a tenant`)),
      ...many(30, (i) => fact(`Morgan note ${i} about work`)), ...filler(60)] },
  { name: 'a nickname in a tenth of the memories', query: 'car vehicle Jay drives', want: 'blue hatchback',
    memories: [fact("Jay's car is a blue hatchback"), ...ledgers(9, 'Jay'), ...many(40, (i) => fact(`Jason item ${i} on the list`)), ...filler(50)] },
  { name: 'an answer of common words, padded with a rarer one', query: 'Morgan daughter birthday date', want: 'Juno was born',
    memories: [fact("Morgan's daughter Juno was born on March 9"), ...many(39, (i) => fact(`Morgan note ${i} about work`)), ...many(11, (i) => fact(`A daughter of friend ${i} visited`)),
      ...many(9, (i) => fact(`Release date for build ${i} slipped`)), ...filler(40)] },
  longAnswerCase(300, false),
  longAnswerCase(450, true),
  longAnswerCase(700, true),
];

const longRow = many(400, (i) => `line ${i} about the harbor schedule, office supplies, staff names and directors meeting notes`).join('\n');

/** Three checks the product already makes, as rows. `first` means the answer must lead; `wants` means all must come back. */
export const KEPT_CASES = [
  { name: 'a long row against a short exact answer, two memories', query: 'what is the name of the harbor office director', want: 'Pat Example is the harbor office director', first: true,
    memories: [{ content: 'Pat Example is the harbor office director', at: '2026-11-23T11:59:59.000Z' }, { content: longRow, at: '2026-11-23T12:00:00.000Z' }] },
  { name: 'a confirmed memory against a newer near-copy', query: 'harbor office director', want: 'Pat Example is the harbor office director', first: true,
    memories: [{ content: 'Pat Example is the harbor office director', confirmed: true, type: 'semantic', at: '2026-10-14T12:00:00.000Z' },
      { content: 'Pat Example was the harbor office director last year', type: 'episodic', source: 'cli', at: '2026-11-23T12:00:00.000Z' }] },
  { name: 'an answer split across two memories among project chatter', query: 'what are the names of my beagles dogs', wants: ['Biscuit', 'Pepper'],
    memories: [...many(12, (i) => ({ content: `Beagles game build ${i} shipped with new beagle art`, type: 'episodic', source: 'cli', at: '2026-11-23T12:00:00.000Z' })),
      { content: 'Jay has a beagle named Biscuit born in 2021', at: '2026-11-23T12:00:00.000Z' }, { content: 'Jay has a second beagle named Pepper born in 2026', at: '2026-11-23T12:00:00.000Z' }] },
];

/** The first eight memories a rule returns for a case. */
export function topEight(rule, core, testCase, now = Date.parse('2026-11-23T12:00:00.000Z')) {
  const rows = testCase.memories.map((memory) => ({
    entry: {
      content: memory.content,
      type: memory.type ?? (memory.confirmed ? 'identity' : 'semantic'),
      source: memory.source ?? 'mcp',
      created_at: memory.at ?? (memory.confirmed ? '2026-11-12T12:00:00.000Z' : '2026-06-01T12:00:00.000Z'),
      metadata: memory.confirmed ? { confirmed: { by: 'user', at: '2026-11-12T12:00:00.000Z' } } : null,
    },
    terms: core.searchTerms(memory.content),
  }));
  return rule(rows, core.searchTerms(testCase.query), now).slice(0, 8).map((scored) => scored.row.entry.content);
}

/** Where the answer lands under a rule, counting from 1, or 0 when it is not in the first eight. */
export function answerRank(rule, core, testCase, now) {
  return topEight(rule, core, testCase, now).findIndex((content) => content.includes(testCase.want)) + 1;
}

/** True when a rule meets a case: every wanted memory came back, and the answer leads where it must. */
export function passes(rule, core, testCase) {
  const top = topEight(rule, core, testCase);
  if (testCase.wants) return testCase.wants.every((want) => top.some((content) => content.includes(want)));
  const rank = top.findIndex((content) => content.includes(testCase.want)) + 1;
  return testCase.first ? rank === 1 : rank > 0;
}
