import {
  MilestoneError,
  assertAgentWriteKeepsPasses,
  formatMilestone,
  milestoneSectionBodies,
  parseMilestones,
  passedMilestones,
  type MilestonePlan,
  type PassedMilestone,
} from '@northkeep/core';

/**
 * ADR 0065 Decision 3, down-sync: a cloud project document applies on its own
 * only when it keeps every passed milestone of the local head, so the Mac runs
 * the same agent write rule the vault runs on an AI app's write.
 */
export function cloudRowKeepsPasses(local: string | null, cloud: string): boolean {
  try {
    assertAgentWriteKeepsPasses(local, cloud);
    return true;
  } catch (err) {
    if (err instanceof MilestoneError) return false;
    throw err;
  }
}

/** One pass that taking the cloud version would add, change or remove, in words. */
export interface MilestonePassChange {
  /** The milestone id; null when a Milestones section cannot be read. */
  id: string | null;
  change: 'added' | 'changed' | 'removed' | 'unreadable';
  text: string;
}

function whoPassed(m: PassedMilestone): string {
  return m.by === 'you' ? `confirmed by you on ${m.on}` : `reported passed by an AI app on ${m.on}`;
}

function passesById(plan: MilestonePlan): Map<string, PassedMilestone> {
  return new Map(passedMilestones(plan).map((m) => [m.id as string, m]));
}

/**
 * Every pass the cloud version would add, change or remove compared with the
 * local head (null when there is none). The conflict dialog lists these for
 * every reason, because an older reason can carry a pass change too.
 */
export function milestonePassChanges(local: string | null, cloud: string): MilestonePassChange[] {
  const mine = local === null ? ({ kind: 'absent' } as const) : parseMilestones(local);
  const theirs = parseMilestones(cloud);
  if (mine.kind === 'malformed' || theirs.kind === 'malformed') {
    const same = local !== null && JSON.stringify(milestoneSectionBodies(local)) === JSON.stringify(milestoneSectionBodies(cloud));
    if (same) return [];
    return [{
      id: null,
      change: 'unreadable',
      text: theirs.kind === 'malformed'
        ? "The cloud version's Milestones section does not follow the milestone format, so NorthKeep cannot tell which milestones it marks passed. Check it line by line before you take it."
        : 'Your Milestones section does not follow the milestone format. Taking the cloud version replaces it, including any passed lines in it.',
    }];
  }
  const before = passesById(mine);
  const after = passesById(theirs);
  const out: MilestonePassChange[] = [];
  for (const [id, was] of before) {
    const now = after.get(id);
    if (now === undefined) {
      out.push({ id, change: 'removed', text: `${id} ${was.title} would no longer be passed. It was ${whoPassed(was)}.` });
    } else if (formatMilestone(now) !== formatMilestone(was)) {
      out.push({ id, change: 'changed', text: `Passed milestone ${id} would change from "${formatMilestone(was)}" to "${formatMilestone(now)}".` });
    }
  }
  for (const [id, now] of after) {
    if (before.has(id)) continue;
    out.push({ id, change: 'added', text: `${id} ${now.title} would be marked passed, ${whoPassed(now)}.` });
  }
  return out;
}
