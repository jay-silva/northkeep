// Hard cases for a ranking rule, each one a way a real fix attempt lost the
// answer (ADR 0087's reviews). A rule is ready when it finds the answer in
// all of them and loses none of the recorded searches in replay.mjs.
const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));
const fact = (content) => ({ content, confirmed: false });
const confirmed = (content) => ({ content, confirmed: true });
const filler = (n) => many(n, (i) => fact(`Tide table ${i} is pinned by the door`));
const ledgers = (n, who = 'Pat') => many(n, (i) => confirmed(`${who} keeps ledger ${i} in the harbor office`));

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
];

/** Where the answer lands under a rule, counting from 1, or 0 when it is not in the first eight. */
export function answerRank(rule, core, testCase, now = Date.parse('2026-11-23T12:00:00.000Z')) {
  const rows = testCase.memories.map(({ content, confirmed: isConfirmed }) => ({
    entry: {
      content, type: isConfirmed ? 'identity' : 'semantic', source: 'mcp',
      created_at: isConfirmed ? '2026-11-12T12:00:00.000Z' : '2026-06-01T12:00:00.000Z',
      metadata: isConfirmed ? { confirmed: { by: 'user', at: '2026-11-12T12:00:00.000Z' } } : null,
    },
    terms: core.searchTerms(content),
  }));
  const top = rule(rows, core.searchTerms(testCase.query), now).slice(0, 8).map((scored) => scored.row.entry.content);
  return top.findIndex((content) => content.includes(testCase.want)) + 1;
}
