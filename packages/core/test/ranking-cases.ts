// ADR 0090: hard cases for search ranking. Each is a way an earlier rule lost
// the answer. Every fact here is fictional. The connector's tests use them too.

export interface RankingMemory {
  content: string;
  confirmed?: boolean;
  /** Defaults to "semantic", or "identity" when confirmed. */
  type?: 'identity' | 'semantic' | 'procedural' | 'episodic';
  /** Days before the test's "now" this was saved. Defaults to 175, or 11 when confirmed. */
  daysAgo?: number;
}

export interface RankingCase {
  name: string;
  query: string;
  /** Text only the answer holds. */
  want: string;
  /** False where another memory may fairly come first; the answer must still be in the first eight. */
  first: boolean;
  /**
   * False where the answer is padded with made-up words: a meaning model cannot
   * place them, and short rows that echo the question score closer. 0.29.0
   * loses these by meaning too (ADR 0090, Not fixed).
   */
  byMeaning?: false;
  memories: RankingMemory[];
}

const many = <T>(n: number, make: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => make(i));
const fact = (content: string): RankingMemory => ({ content });
const confirmed = (content: string): RankingMemory => ({ content, confirmed: true });
const filler = (n: number): RankingMemory[] => many(n, (i) => fact(`Tide table ${i} is pinned by the door`));
const ledgers = (n: number, who = 'Pat'): RankingMemory[] => many(n, (i) => confirmed(`${who} keeps ledger ${i} in the harbor office`));

/** One query word, "dog", is in no memory, and the answer is long. */
const longAnswerCase = (words: number, isConfirmed: boolean): RankingCase => ({
  name: `a ${words}-word answer${isConfirmed ? ', confirmed,' : ''} and a query word no memory holds`,
  query: 'when is the vet appointment for the dog', want: 'vet appointment is on Friday', first: true,
  ...(isConfirmed ? {} : { byMeaning: false as const }),
  memories: [
    { content: `The vet appointment is on Friday at ten. ${many(words, (i) => `xword${i}`).join(' ')}`, confirmed: isConfirmed },
    ...many(40, (i) => fact(`Vet bill ${i} was paid`)), ...many(30, (i) => fact(`Appointment ${i} with the bank moved`)), ...filler(1400),
  ],
});

export const RANKING_CASES: RankingCase[] = [
  { name: 'the name is in every confirmed memory', query: 'car vehicle Pat drives', want: 'blue hatchback', first: true,
    memories: [fact("Pat's car is a blue hatchback"), ...ledgers(12), ...filler(12)] },
  { name: 'the rarer word is on an unrelated memory', query: 'Pat employer', want: 'Pat works at Harbor Rescue', first: false,
    memories: [fact("Robin's employer is Southcoast Marine"), confirmed('Pat works at Harbor Rescue'), ...ledgers(6), ...filler(20)] },
  { name: 'a padding word, and an answer made of common words', query: 'heron cabin corgi dog', want: 'called Biscuit', first: true,
    memories: [fact('The corgi at Heron Cabin is called Biscuit'), ...many(11, (i) => fact(`Heron sighting ${i} by the marsh`)), ...many(11, (i) => fact(`Cabin supply run ${i} is done`)),
      ...many(11, (i) => fact(`Corgi meetup ${i} was fun`)), ...many(9, (i) => fact(`Neighbor dog ${i} barked at night`)), ...filler(57)] },
  { name: 'the name is in a fifth of the memories', query: 'car Pat', want: 'blue hatchback', first: true,
    memories: [fact("Pat's car is a blue hatchback"), ...ledgers(10), ...many(11, (i) => fact(`Pat mentioned errand ${i}`)), ...filler(78)] },
  { name: 'ten memories, nine of them confirmed and sharing the name', query: 'Pat car', want: 'spare car key', first: true,
    memories: [fact('The spare car key hangs by the door'), ...many(9, (i) => confirmed(`Pat parks trailer ${i} in the garage`))] },
  { name: 'nine confirmed memories share a street name', query: 'Morgan Street water heater age', want: 'water heater', first: true,
    memories: [fact('The water heater at 12 Morgan Street was replaced in 2019'), ...many(9, (i) => confirmed(`Unit ${i} at 40 Morgan Street has a tenant`)),
      ...many(30, (i) => fact(`Morgan note ${i} about work`)), ...filler(60)] },
  { name: 'a nickname in a tenth of the memories', query: 'car vehicle Jay drives', want: 'blue hatchback', first: true,
    memories: [fact("Jay's car is a blue hatchback"), ...ledgers(9, 'Jay'), ...many(40, (i) => fact(`Jason item ${i} on the list`)), ...filler(50)] },
  { name: 'an answer of common words, padded with a rarer one', query: 'Morgan daughter birthday date', want: 'Juno was born', first: true,
    memories: [fact("Morgan's daughter Juno was born on March 9"), ...many(39, (i) => fact(`Morgan note ${i} about work`)), ...many(11, (i) => fact(`A daughter of friend ${i} visited`)),
      ...many(9, (i) => fact(`Release date for build ${i} slipped`)), ...filler(40)] },
  longAnswerCase(300, false),
  longAnswerCase(450, true),
  longAnswerCase(700, true),
  // A long memory the user confirmed over a year ago, against eight fresh AI notes that only repeat the question.
  { name: 'a long confirmed answer against fresh notes that repeat the question', query: 'septic test pit results', want: 'passed at four feet', first: true, byMeaning: false,
    memories: [{ content: `The septic test pit results: the pit passed at four feet. ${many(450, (i) => `xword${i}`).join(' ')}`, confirmed: true, daysAgo: 400 },
      ...many(8, (i) => ({ content: `User asked where the septic test pit results are, time ${i}`, type: 'episodic' as const, daysAgo: 5 })), ...filler(300)] },
];
