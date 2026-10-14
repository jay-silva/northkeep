import { describe, expect, it } from 'vitest';
import {
  MilestoneError,
  assertAgentWriteKeepsPasses,
  formatMilestones,
  milestoneSkeleton,
  parseMilestoneProposals,
  parseMilestoneSection,
  parseMilestones,
  recordAgentPass,
  replacePlan,
  summarizeMilestones,
  type MilestonePlan,
  type PassedMilestone,
} from '../src/project-milestones.js';
import { confirmPass, confirmPassInDocument } from '../src/project-milestones-owner.js';

const PLAN = [
  '- [x] M1 Define the buy box | test: buy box written and agreed | passed 2026-09-28 (you)',
  '- [x] M2 Shortlist 3 markets | test: 3 markets with comps | passed 2026-10-09 (agent)',
  '- [ ] M3 Underwrite top 5 listings | test: each has a pro forma with ADR, occupancy and cash-on-cash',
].join('\n');

function doc(milestones: string | null, extra = ''): string {
  return [
    '# Buy a rental',
    '## What & Why\n\nA first rental.',
    '## Current Status\n\nShortlisting.',
    ...(milestones === null ? [] : [`## Milestones\n\n${milestones}`]),
    '## Next Actions\n\n- [x] Merge the PR\n- [ ] Call the lender',
    '## Decisions',
    '## Log',
    ...(extra ? [extra] : []),
  ].join('\n\n');
}

const reason = (plan: MilestonePlan): string => (plan.kind === 'malformed' ? plan.reason : `not malformed: ${plan.kind}`);
const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(MilestoneError);
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
};

describe('parseMilestones', () => {
  it('reads the plan from the level-2 section, and formats it back byte for byte', () => {
    const plan = parseMilestones(doc(PLAN));
    expect(plan).toEqual({
      kind: 'plan',
      items: [
        { id: 'M1', title: 'Define the buy box', test: 'buy box written and agreed', state: 'passed', on: '2026-09-28', by: 'you' },
        { id: 'M2', title: 'Shortlist 3 markets', test: '3 markets with comps', state: 'passed', on: '2026-10-09', by: 'agent' },
        { id: 'M3', title: 'Underwrite top 5 listings', test: 'each has a pro forma with ADR, occupancy and cash-on-cash', state: 'open' },
      ],
    });
    expect(formatMilestones(plan as Extract<MilestonePlan, { kind: 'plan' }>)).toBe(PLAN);
    expect(parseMilestoneSection(formatMilestones({ kind: 'none', reason: 'a one-off errand' }))).toEqual({ kind: 'none', reason: 'a one-off errand' });
    expect(summarizeMilestones(plan)).toEqual({ passed: 2, total: 3, current: { id: 'M3', title: 'Underwrite top 5 listings' } });
  });

  it('is absent with no level-2 section, and ignores a title or a deeper heading named Milestones', () => {
    expect(parseMilestones(doc(null))).toEqual({ kind: 'absent' });
    expect(parseMilestones('# Milestones\n\n## Current Status\n\nx')).toEqual({ kind: 'absent' });
    expect(parseMilestones(`## Current Status\n\nx\n\n### Milestones\n\n${PLAN}`)).toEqual({ kind: 'absent' });
    expect(summarizeMilestones({ kind: 'absent' })).toBeNull();
  });

  it('reads a CRLF document the same as LF', () => {
    expect(parseMilestones(doc(PLAN).replace(/\n/g, '\r\n'))).toEqual(parseMilestones(doc(PLAN)));
  });

  it('reads none: as no plan on purpose, alone on its line', () => {
    expect(parseMilestones(doc('none: a one-off errand'))).toEqual({ kind: 'none', reason: 'a one-off errand' });
    expect(reason(parseMilestones(doc('none: a one-off errand\n- [ ] M1 A | test: B')))).toBe('A none: line must be the only line in the Milestones section.');
  });

  it.each([
    ['an empty section', '', 'The Milestones section is empty.'],
    ['a duplicate id', '- [ ] M1 A | test: B\n- [ ] M1 C | test: D', 'M1 appears more than once.'],
    ['a pass after an open line', '- [ ] M1 A | test: B\n- [x] M2 C | test: D | passed 2026-10-01 (you)', 'M2 has passed but comes after a milestone that has not; passed milestones come first.'],
    ['a checked box with no stamp', '- [x] M1 A | test: B', 'Line 1 is checked but has no pass stamp.'],
    ['a stamp with an open box', '- [ ] M1 A | test: B | passed 2026-10-01 (you)', 'Line 1 has a pass stamp but its box is not checked.'],
    ['a trailing space after the stamp', '- [x] M1 A | test: B | passed 2026-10-01 (you) ', 'Line 1 does not follow the format "- [ ] M1 Title | test: how the user checks it".'],
    ['a capitalised stamp word', '- [x] M1 A | test: B | passed 2026-10-01 (You)', 'Line 1 does not follow the format "- [ ] M1 Title | test: how the user checks it".'],
    ['an id outside the pattern', '- [ ] M0 A | test: B', 'Line 1 does not follow the format "- [ ] M1 Title | test: how the user checks it".'],
    ['a date that does not exist', '- [x] M1 A | test: B | passed 2026-02-30 (you)', 'Line 1 has a pass date that is not a real date.'],
    ['a | in the title', '- [ ] M1 A | B | test: C', 'Line 1 does not follow the format "- [ ] M1 Title | test: how the user checks it".'],
    ['a control character', '- [ ] M1 A\u0007 | test: B', 'Line 1: The title contains a line break, control or invisible formatting character.'],
    ['a format character', '- [ ] M1 A\u200b | test: B', 'Line 1: The title contains a line break, control or invisible formatting character.'],
    ['a line separator', '- [ ] M1 A\u2028B | test: C', 'Line 1: The title contains a line break, control or invisible formatting character.'],
    ['a paragraph separator', '- [ ] M1 A | test: B\u2029C', 'Line 1: The test contains a line break, control or invisible formatting character.'],
    ['a lone carriage return', '- [ ] M1 A | test: B\rC', 'Line 1: The test contains a line break, control or invisible formatting character.'],
    ['a blank line between items', '- [ ] M1 A | test: B\n\n- [ ] M2 C | test: D', 'Line 2 does not follow the format "- [ ] M1 Title | test: how the user checks it".'],
    ['a title of 81 characters', `- [ ] M1 ${'t'.repeat(81)} | test: B`, 'Line 1: The title is 81 characters; the limit is 80.'],
    ['a test of 121 characters', `- [ ] M1 A | test: ${'t'.repeat(121)}`, 'Line 1: The test is 121 characters; the limit is 120.'],
    ['21 milestones', Array.from({ length: 21 }, (_, i) => `- [ ] M${i + 1} A | test: B`).join('\n'), 'The plan has 21 lines; the limit is 20 milestones.'],
  ])('is malformed with %s', (_label, body, expected) => {
    expect(reason(parseMilestones(doc(body)))).toBe(expected);
  });

  it('is malformed with a line over 240 characters, and accepts the longest title and test that fit', () => {
    const atLimits = `- [x] M999 ${'t'.repeat(80)} | test: ${'u'.repeat(120)} | passed 2026-10-01 (agent)`;
    expect(atLimits.length).toBe(248);
    expect(reason(parseMilestones(doc(atLimits)))).toBe('Line 1 is 248 characters; the limit is 240.');
    const fits = `- [x] M1 ${'t'.repeat(80)} | test: ${'u'.repeat(114)} | passed 2026-10-01 (agent)`;
    expect(fits.length).toBe(240);
    expect(parseMilestones(doc(fits)).kind).toBe('plan');
  });

  it('is malformed when the document has two level-2 Milestones sections', () => {
    expect(reason(parseMilestones(doc('- [ ] M1 A | test: B', '## Milestones\n\n- [ ] M2 C | test: D')))).toBe('The document has more than one Milestones section.');
  });
});

describe('parseMilestoneProposals', () => {
  it('reads one milestone per line, with or without an id, skipping blank lines', () => {
    expect(parseMilestoneProposals('M1 Agree the milestones | test: Jay approves the plan\n\n  Ship it | test: it runs  \r\n')).toEqual({
      kind: 'plan',
      items: [{ id: 'M1', title: 'Agree the milestones', test: 'Jay approves the plan' }, { title: 'Ship it', test: 'it runs' }],
    });
    expect(parseMilestoneProposals('none: a one-off errand')).toEqual({ kind: 'none', reason: 'a one-off errand' });
  });

  it.each([
    ['- [x] M1 A | test: B', 'Line 1 has a checkbox or a pass stamp. Send open milestones only, like "M3 Title | test: how the user checks it"; NorthKeep records passes itself.'],
    ['- [ ] M1 A | test: B', 'Line 1 has a checkbox or a pass stamp. Send open milestones only, like "M3 Title | test: how the user checks it"; NorthKeep records passes itself.'],
    ['M1 A | test: B | passed 2026-10-01 (you)', 'Line 1 has a checkbox or a pass stamp. Send open milestones only, like "M3 Title | test: how the user checks it"; NorthKeep records passes itself.'],
    ['M1 A | test: B\nM2 C test D', 'Line 2 must look like "M3 Title | test: how the user checks it", with one "|".'],
    ['M0 A | test: B', 'Line 1: M0 is not a milestone id. Ids run from M1 to M999.'],
    [' \n ', 'milestones is empty. Send one line per milestone, like "M1 Agree the milestones | test: the user approves the plan", or one line "none: <reason>".'],
  ])('refuses %j', (text, expected) => {
    expect(refusal(() => parseMilestoneProposals(text))).toBe(expected);
  });
});

describe('replacePlan', () => {
  const current = parseMilestones(doc(PLAN));

  it('keeps passed milestones first and byte for byte, and numbers new ones after the highest id', () => {
    const next = replacePlan(current, { kind: 'plan', items: [{ title: 'Make offers', test: 'two offers sent' }, { id: 'M7', title: 'Close', test: 'keys in hand' }, { title: 'Rent it', test: 'lease signed' }] });
    expect(formatMilestones(next)).toBe([
      PLAN.split('\n')[0], PLAN.split('\n')[1],
      '- [ ] M8 Make offers | test: two offers sent',
      '- [ ] M7 Close | test: keys in hand',
      '- [ ] M9 Rent it | test: lease signed',
    ].join('\n'));
  });

  it.each([
    ['an id that has passed', { kind: 'plan' as const, items: [{ id: 'M2', title: 'Again', test: 'x' }] }, 'M2 has already passed. Passed milestones cannot be changed; send only the milestones still to do.'],
    ['a checkbox in a title', { kind: 'plan' as const, items: [{ title: '[x] Done', test: 'x' }] }, 'Milestone 1 has a checkbox or a pass stamp in its text. Send open milestones only; NorthKeep records passes itself.'],
    ['a stamp in a test', { kind: 'plan' as const, items: [{ title: 'A', test: 'ok (you)' }] }, 'Milestone 1 has a checkbox or a pass stamp in its text. Send open milestones only; NorthKeep records passes itself.'],
    ['a duplicate id', { kind: 'plan' as const, items: [{ id: 'M4', title: 'A', test: 'x' }, { id: 'M4', title: 'B', test: 'y' }] }, 'M4 appears more than once.'],
    ['a | in a title', { kind: 'plan' as const, items: [{ title: 'A | B', test: 'x' }] }, 'Milestone 1: The title contains "|".'],
    ['none: over passes', { kind: 'none' as const, reason: 'dropped' }, 'This project has passed milestones, so its plan cannot be replaced with none:.'],
  ])('refuses %s', (_label, incoming, expected) => {
    expect(refusal(() => replacePlan(current, incoming))).toBe(expected);
  });

  it('refuses a malformed current plan, so an agent cannot rebuild passes it cannot see', () => {
    expect(refusal(() => replacePlan({ kind: 'malformed', reason: 'x' }, { kind: 'plan', items: [{ title: 'A', test: 'B' }] })))
      .toBe('The Milestones section does not follow the milestone format, so it cannot be changed here. Ask the user to repair it in the NorthKeep app.');
  });

  it('refuses an open line with no room for its pass stamp, and a plan of more than 20', () => {
    expect(refusal(() => replacePlan({ kind: 'absent' }, { kind: 'plan', items: [{ title: 't'.repeat(80), test: 'u'.repeat(120) }] })))
      .toBe('Milestone M1 is too long: with its pass stamp the line would be 246 characters, and the limit is 240. Shorten its title or test.');
    const many = Array.from({ length: 19 }, (_, i) => ({ title: `Step ${i}`, test: 'done' }));
    expect(refusal(() => replacePlan(current, { kind: 'plan', items: many }))).toBe('The plan has 21 milestones; the limit is 20.');
  });

  it('accepts none: and an empty list when nothing has passed it refuses', () => {
    expect(replacePlan({ kind: 'absent' }, { kind: 'none', reason: 'errand' })).toEqual({ kind: 'none', reason: 'errand' });
    expect(refusal(() => replacePlan({ kind: 'absent' }, { kind: 'plan', items: [] }))).toBe('Send at least one milestone, or none: and a reason.');
  });
});

describe('recordAgentPass and confirmPass', () => {
  const current = parseMilestones(doc(PLAN));

  it('stamps the current milestone (agent) with the UTC date of the save', () => {
    const { plan, passed } = recordAgentPass(current, 'M3', '2026-10-14T01:30:00+02:00');
    expect(passed).toEqual({ id: 'M3', title: 'Underwrite top 5 listings', test: 'each has a pro forma with ADR, occupancy and cash-on-cash', state: 'passed', on: '2026-10-13', by: 'agent' });
    expect(formatMilestones(plan).split('\n')[2]).toBe('- [x] M3 Underwrite top 5 listings | test: each has a pro forma with ADR, occupancy and cash-on-cash | passed 2026-10-13 (agent)');
  });

  it('refuses any id but the current one, and plans with nothing to pass', () => {
    expect(refusal(() => recordAgentPass(current, 'M2', '2026-10-14T00:00:00.000Z'))).toBe('Only the current milestone, M3, can be reported passed. Report a milestone passed only when the user says its acceptance test passed.');
    expect(refusal(() => recordAgentPass({ kind: 'none', reason: 'x' }, 'M1', '2026-10-14T00:00:00.000Z'))).toBe('This project has no milestone plan, so there is no milestone to report passed.');
    expect(refusal(() => recordAgentPass({ kind: 'malformed', reason: 'x' }, 'M1', '2026-10-14T00:00:00.000Z'))).toBe('The Milestones section does not follow the milestone format, so it cannot be changed here. Ask the user to repair it in the NorthKeep app.');
  });

  it('confirms the current milestone or an (agent) pass as (you), and nothing else', () => {
    expect(confirmPass(current, 'M2', '2026-10-14T09:00:00.000Z').passed).toMatchObject({ id: 'M2', on: '2026-10-14', by: 'you' });
    expect(confirmPass(current, 'M3', '2026-10-14T09:00:00.000Z').passed).toMatchObject({ id: 'M3', on: '2026-10-14', by: 'you' });
    expect(refusal(() => confirmPass(current, 'M1', '2026-10-14T09:00:00.000Z'))).toBe('M1 is already confirmed.');
    const later = parseMilestones(doc('- [ ] M1 A | test: B\n- [ ] M2 C | test: D'));
    expect(refusal(() => confirmPass(later, 'M2', '2026-10-14T09:00:00.000Z'))).toBe('Only the current milestone, M1, can be confirmed now. Milestones pass in order.');
    expect(confirmPassInDocument(doc(PLAN), 'M3', '2026-10-14T09:00:00.000Z').content).toBe(doc(PLAN.replace(
      '- [ ] M3 Underwrite top 5 listings | test: each has a pro forma with ADR, occupancy and cash-on-cash',
      '- [x] M3 Underwrite top 5 listings | test: each has a pro forma with ADR, occupancy and cash-on-cash | passed 2026-10-14 (you)',
    )));
  });
});

describe('assertAgentWriteKeepsPasses', () => {
  const before = doc(PLAN);
  const m1 = PLAN.split('\n')[0]!;
  const open3 = PLAN.split('\n')[2]!;
  const allowed: PassedMilestone = { id: 'M3' as PassedMilestone['id'], title: 'Underwrite top 5 listings', test: 'each has a pro forma with ADR, occupancy and cash-on-cash', state: 'passed', on: '2026-10-14', by: 'agent' };

  it('accepts edits elsewhere, a checked task in Next Actions, a CRLF re-save and new open milestones', () => {
    expect(() => assertAgentWriteKeepsPasses(before, before.replace('Shortlisting.', 'Underwriting.'))).not.toThrow();
    expect(() => assertAgentWriteKeepsPasses(before, before.replace('- [ ] Call the lender', '- [x] Call the lender'))).not.toThrow();
    expect(() => assertAgentWriteKeepsPasses(before, before.replace(/\n/g, '\r\n'))).not.toThrow();
    expect(() => assertAgentWriteKeepsPasses(before, doc(`${PLAN}\n- [ ] M4 Close | test: keys`))).not.toThrow();
    expect(() => assertAgentWriteKeepsPasses(null, doc('- [ ] M1 A | test: B'))).not.toThrow();
  });

  it('accepts the one (agent) pass it was given, and no other new pass', () => {
    const passed = doc(PLAN.replace(open3, `${open3.replace('- [ ]', '- [x]')} | passed 2026-10-14 (agent)`));
    expect(() => assertAgentWriteKeepsPasses(before, passed, allowed)).not.toThrow();
    expect(refusal(() => assertAgentWriteKeepsPasses(before, passed))).toBe('An AI app cannot mark M3 passed this way. Report the current milestone passed with milestone_passed at a checkpoint or wrap, after the user says its test passed.');
    expect(refusal(() => assertAgentWriteKeepsPasses(before, passed.replace('2026-10-14 (agent)', '2026-10-14 (you)'), { ...allowed, by: 'you' }))).toBe('An AI app cannot mark M3 passed this way. Report the current milestone passed with milestone_passed at a checkpoint or wrap, after the user says its test passed.');
  });

  it.each([
    ['ticking an open line as (you)', doc(PLAN.replace(open3, `${open3.replace('- [ ]', '- [x]')} | passed 2026-10-14 (you)`)), 'An AI app cannot mark M3 passed this way. Report the current milestone passed with milestone_passed at a checkpoint or wrap, after the user says its test passed.'],
    ['restamping an (agent) pass as (you)', doc(PLAN.replace('(agent)', '(you)')), 'M2 has passed, so its line cannot be changed, moved out of Milestones or removed.'],
    ['removing a passed line', doc(PLAN.split('\n').slice(1).join('\n')), 'M1 has passed, so its line cannot be changed, moved out of Milestones or removed.'],
    ['editing a passed title', doc(PLAN.replace('Define the buy box', 'Define the box')), 'M1 has passed, so its line cannot be changed, moved out of Milestones or removed.'],
    ['moving a passed line into Log', doc(PLAN.split('\n').slice(1).join('\n'), m1), 'M1 has passed, so its line cannot be changed, moved out of Milestones or removed.'],
    ['renaming the heading and adding a fresh section', doc(null, `## Milestones (old)\n\n${PLAN}\n\n## Milestones\n\n- [ ] M1 Define the buy box | test: buy box written and agreed`), 'M1 has passed, so its line cannot be changed, moved out of Milestones or removed.'],
    ['removing the section', doc(null), 'This project has passed milestones, so its Milestones section must stay, with every passed line unchanged.'],
    ['replacing the plan with none:', doc('none: never mind'), 'This project has passed milestones, so its Milestones section must stay, with every passed line unchanged.'],
    ['fencing a passed line', doc(`\`\`\`\n${m1}\n\`\`\`\n${PLAN.split('\n').slice(1).join('\n')}`), 'This change would leave the Milestones section unreadable, so nothing was saved: Line 1 does not follow the format "- [ ] M1 Title | test: how the user checks it".'],
    ['emptying the section', doc(''), 'This change would leave the Milestones section unreadable, so nothing was saved: The Milestones section is empty.'],
    ['adding a second Milestones section', doc(PLAN, '## Milestones\n\n- [ ] M9 A | test: B'), 'This change would leave the Milestones section unreadable, so nothing was saved: The document has more than one Milestones section.'],
  ])('refuses %s', (_label, after, expected) => {
    expect(refusal(() => assertAgentWriteKeepsPasses(before, after))).toBe(expected);
  });

  it('refuses a near-valid forged (you) line on a plan with no passes, so a later repair cannot make it real', () => {
    const open = doc('- [ ] M1 A | test: B');
    for (const forged of ['- [x] M1 A | test: B | passed 2026-10-01 (you) ', '- [x] M1 A | test: B | passed 2026-10-01 (You)']) {
      expect(refusal(() => assertAgentWriteKeepsPasses(open, doc(forged)))).toMatch(/^This change would leave the Milestones section unreadable, so nothing was saved: /);
    }
    expect(refusal(() => assertAgentWriteKeepsPasses(doc('none: errand'), doc('- [x] M1 A | test: B | passed 2026-10-01 (you)')))).toBe('An AI app cannot mark M1 passed this way. Report the current milestone passed with milestone_passed at a checkpoint or wrap, after the user says its test passed.');
    expect(refusal(() => assertAgentWriteKeepsPasses(null, doc('- [x] M1 A | test: B | passed 2026-10-01 (you)')))).toBe('An AI app cannot mark M1 passed this way. Report the current milestone passed with milestone_passed at a checkpoint or wrap, after the user says its test passed.');
  });

  it('keeps a malformed section byte-identical: other sections can change, the section cannot', () => {
    const broken = doc('- [x] M1 A | test: B | passed 2026-10-01 (You)');
    expect(() => assertAgentWriteKeepsPasses(broken, broken.replace('Shortlisting.', 'Still shortlisting.'))).not.toThrow();
    for (const repaired of [doc('- [x] M1 A | test: B | passed 2026-10-01 (you)'), doc('- [ ] M1 A | test: B'), doc(null)]) {
      expect(refusal(() => assertAgentWriteKeepsPasses(broken, repaired))).toBe('The Milestones section does not follow the milestone format, so it cannot be changed here. Ask the user to repair it in the NorthKeep app. Leave that section exactly as it is.');
    }
  });

  it('refuses the two-step route: an agent cannot break the section first and repair it second', () => {
    const open = doc('- [ ] M1 A | test: B');
    const step1 = doc('- [x] M1 A | test: B | passed 2026-10-01 (you) ');
    expect(refusal(() => assertAgentWriteKeepsPasses(open, step1))).toMatch(/^This change would leave the Milestones section unreadable/);
  });
});

describe('adversarial review of efa93d4 (wounds W1, W2, W3, W5)', () => {
  const OPEN3 = '- [ ] M3 Underwrite top 5 listings | test: each has a pro forma with ADR, occupancy and cash-on-cash';
  const before = doc(PLAN);
  const FORGED_OPEN_MESSAGE = 'M3 has a checkbox or a pass stamp in its text. Open milestones cannot carry one; NorthKeep records passes itself.';

  it('W1: refuses a new or changed open line whose title or test carries a forged stamp', () => {
    for (const forged of [
      '- [ ] M3 [x] Under (you) | test: pro forma ｜ passed 2026-10-03 (you)',
      '- [ ] M3 Underwrite | test: pro forma — passed 2026-10-03 (you)',
      '- [ ] M3 Underwrite | test: pro forma passed 2026-10-03',
    ]) {
      expect(refusal(() => assertAgentWriteKeepsPasses(before, before.replace(OPEN3, forged)))).toBe(FORGED_OPEN_MESSAGE);
    }
    const added = before.replace(OPEN3, `${OPEN3}\n- [ ] M4 Close | test: keys (agent)`);
    expect(refusal(() => assertAgentWriteKeepsPasses(before, added))).toBe('M4 has a checkbox or a pass stamp in its text. Open milestones cannot carry one; NorthKeep records passes itself.');
    expect(refusal(() => assertAgentWriteKeepsPasses(null, doc('- [ ] M1 Buy | test: done (you)')))).toBe('M1 has a checkbox or a pass stamp in its text. Open milestones cannot carry one; NorthKeep records passes itself.');
  });

  it('W1: an unchanged open line is not re-judged, so an owner-written line does not block other edits', () => {
    const owned = doc(PLAN.replace(OPEN3, '- [ ] M3 Underwrite | test: the lender says (you) are approved'));
    expect(() => assertAgentWriteKeepsPasses(owned, owned.replace('Shortlisting.', 'Underwriting.'))).not.toThrow();
  });

  it('W2: the stamp test sees through lookalikes', () => {
    for (const text of ['done ✅ (уou)', '［x］ a', '[ X ] a', 'done (YOU)', 'done ( agent )', 'done ⟨you⟩', 'ok ☑ fine', 'Passed 2026/10/03', 'passed ２０２６-１０-０３', 'done (ａｇｅｎｔ)', 'done (yοu)']) {
      expect(refusal(() => parseMilestoneProposals(`M3 Underwrite | test: ${text}`)), text).toBe('Line 1 has a checkbox or a pass stamp. Send open milestones only, like "M3 Title | test: how the user checks it"; NorthKeep records passes itself.');
    }
    for (const text of ['three listings with comps', 'you and the lender agree', 'agent of record signs', 'passed inspection']) {
      expect(() => parseMilestoneProposals(`M3 Underwrite | test: ${text}`), text).not.toThrow();
    }
  });

  it('W3: refuses a passed-milestone line added outside the real section, and a lookalike Milestones heading', () => {
    const empty = doc(null);
    const stamp = '- [x] M1 Buy box | test: agreed | passed 2026-10-01 (you)';
    for (const heading of ['## Milestones ##', '### Milestones', '## milestones', '# Milestones', '## Ｍilestones']) {
      const after = `${empty}\n\n${heading}\n\n${stamp}`;
      expect(parseMilestones(after).kind, heading).toBe('absent');
      expect(refusal(() => assertAgentWriteKeepsPasses(empty, after)), heading).toMatch(/^(A heading named like Milestones can only be "## Milestones"\.|Only the Milestones section can hold a passed milestone line\.)/);
    }
    expect(refusal(() => assertAgentWriteKeepsPasses(empty, empty.replace('## Log', `## Log\n\n${stamp}`)))).toBe('Only the Milestones section can hold a passed milestone line. An AI app cannot add one anywhere else.');
    expect(refusal(() => assertAgentWriteKeepsPasses(empty, empty.replace('## Log', '## Log\n\nM2 passed 2026-10-01 (you)')))).toBe('Only the Milestones section can hold a passed milestone line. An AI app cannot add one anywhere else.');
    expect(refusal(() => assertAgentWriteKeepsPasses(empty, `${empty}\n\n### Milestones\n\nNotes.`))).toBe('A heading named like Milestones can only be "## Milestones". Use that exact heading for the plan.');
    expect(refusal(() => assertAgentWriteKeepsPasses(null, `${empty}\n\n## milestones\n\n- [ ] M1 A | test: b`))).toBe('A heading named like Milestones can only be "## Milestones". Use that exact heading for the plan.');
  });

  it('W3: a line or heading already in the document before is not a new addition', () => {
    const stamp = '- [x] M1 Buy box | test: agreed | passed 2026-10-01 (you)';
    const legacy = `${doc(null)}\n\n### Milestones\n\n${stamp}`;
    expect(() => assertAgentWriteKeepsPasses(legacy, legacy.replace('Shortlisting.', 'Underwriting.'))).not.toThrow();
    expect(() => assertAgentWriteKeepsPasses(before, before.replace('## Log', '## Log\n\n- [x] Merged the PR'))).not.toThrow();
  });

  it('K1 review A: refuses a stamped or pass-dated line added outside the section, with or without a Latin id', () => {
    const empty = doc(null);
    const message = 'Only the Milestones section can hold a passed milestone line. An AI app cannot add one anywhere else.';
    for (const line of [
      '- [x] Shortlist 3 markets | test: 3 markets with comps | passed 2026-10-14 (you)',
      '- [x] \u041c2 Shortlist 3 markets | test: 3 markets with comps | passed 2026-10-14 (you)',
      '- [x] \u039c2 Shortlist 3 markets | test: 3 markets with comps | passed 2026-10-14 (you)',
      '- [x] M02 Shortlist 3 markets | test: 3 markets with comps | passed 2026-10-14 (you)',
      '- \u221a Shortlist 3 markets (you)',
      'Shortlist done, passed 2026-10-14',
    ]) {
      expect(refusal(() => assertAgentWriteKeepsPasses(empty, empty.replace('## Log', `## Log\n\n${line}`))), line).toBe(message);
      expect(refusal(() => assertAgentWriteKeepsPasses(null, empty.replace('A first rental.', line))), line).toBe(message);
    }
    const legacy = empty.replace('## Log', '## Log\n\n- [x] Shortlist 3 markets | passed 2026-10-14 (you)');
    expect(() => assertAgentWriteKeepsPasses(legacy, legacy.replace('Shortlisting.', 'Underwriting.'))).not.toThrow();
    expect(() => assertAgentWriteKeepsPasses(empty, empty.replace('## Log', '## Log\n\n- [x] Merged the PR\n- \u221a Called the lender'))).not.toThrow();
  });

  it('K1 review A: Cyrillic and Greek M read as M, and a square-root tick reads as a checkbox', () => {
    for (const text of ['done \u221a', '\u041c2 passed 2026-10-14', '\u039c2 (you)']) {
      expect(refusal(() => parseMilestoneProposals(`M3 Underwrite | test: ${text}`)), text).toMatch(/^Line 1 has a checkbox or a pass stamp\./);
    }
    expect(milestoneSkeleton('\u041c\u043c\u039c\u03bc')).toBe('mmmm');
  });

  it('K4 review F1: refuses an added setext Milestones heading and a checkbox line with a milestone id outside the section', () => {
    const empty = doc(null);
    const heading = 'A heading named like Milestones can only be "## Milestones". Use that exact heading for the plan.';
    const checkbox = 'Only the Milestones section can hold a milestone line with a checkbox. An AI app cannot add one anywhere else.';
    const status = 'Beds done.\n\nMilestones\n----------\n- [x] M2 Order seeds | test: seed order confirmed | passed 14 Oct 2026 (confirmed by you)';
    expect(refusal(() => assertAgentWriteKeepsPasses(empty, empty.replace('Shortlisting.', status)))).toBe(heading);
    for (const under of ['----------', '===', '--']) {
      expect(refusal(() => assertAgentWriteKeepsPasses(empty, empty.replace('Shortlisting.', `Beds done.\n\nＭilestones\n${under}\nNotes.`))), under).toBe(heading);
    }
    expect(refusal(() => assertAgentWriteKeepsPasses(empty, empty.replace('Shortlisting.', 'Beds done.\n\nMilestones\n----------\n- [x] M2 Order seeds')))).toBe(heading);
    const already = empty.replace('Shortlisting.', 'Beds done.\n\nMilestones');
    expect(refusal(() => assertAgentWriteKeepsPasses(already, already.replace('Milestones', 'Milestones\n===')))).toBe(heading);
    for (const line of ['- [x] M2 Order seeds', '✅ M2 Order seeds passed, confirmed by you', '* [X] \u041c2 Order seeds', '- [ ] M02 Order seeds', '☑ m 2 done']) {
      expect(refusal(() => assertAgentWriteKeepsPasses(empty, empty.replace('## Log', `## Log\n\n${line}`))), line).toBe(checkbox);
      expect(refusal(() => assertAgentWriteKeepsPasses(null, empty.replace('A first rental.', line))), line).toBe(checkbox);
    }
    const fine = empty.replace('Shortlisting.', 'Beds done.\n\nNotes\n-----\nMilestones are below.\n\n---\n\n- [x] Ordered 12 seed packs\n- M2 is next');
    expect(() => assertAgentWriteKeepsPasses(empty, fine)).not.toThrow();
    const legacy = empty.replace('Shortlisting.', 'Milestones\n----------\n- [x] M2 Order seeds');
    expect(() => assertAgentWriteKeepsPasses(legacy, legacy.replace('## Log', '## Log\n\nCalled the lender.'))).not.toThrow();
  });

  it('W5: passed lines keep their order', () => {
    const passed = PLAN.split('\n');
    const swapped = before.replace(`${passed[0]}\n${passed[1]}`, `${passed[1]}\n${passed[0]}`);
    expect(refusal(() => assertAgentWriteKeepsPasses(before, swapped))).toBe('Passed milestones must stay in the order they passed: M1, M2.');
  });

  it('W5: the allowed new pass goes right after the earlier passes', () => {
    const plan = parseMilestones(before);
    const { plan: next, passed } = recordAgentPass(plan, 'M3', '2026-10-14T00:00:00.000Z');
    const after = doc(formatMilestones(next));
    expect(() => assertAgentWriteKeepsPasses(before, after, passed)).not.toThrow();
  });
});
