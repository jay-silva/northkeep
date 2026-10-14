/**
 * ADR 0065 K2: the desktop's milestone reads and owner writes. Every rule
 * comes from the core milestone module; this file only shapes its results for
 * the page and builds the documents the owner routes save.
 */
import {
  MILESTONES_HEADING,
  formatMilestone,
  milestoneSectionBodies,
  parseMilestoneSection,
  parseMilestones,
  parseProjectDoc,
  passedMilestones,
  serializeProjectDoc,
  type MilestonePlan,
  type PassedMilestone,
} from '@northkeep/core';

/** One pass as the page names it. */
export interface PassNote { id: string; title: string; on: string; by: 'you' | 'agent' }

const note = (item: PassedMilestone): PassNote => ({ id: item.id, title: item.title, on: item.on, by: item.by });

/** What restoring an older version would do to the passed milestones. */
export interface RestoreMilestoneChanges {
  adds: PassNote[];
  changes: { from: PassNote; to: PassNote }[];
  undoes: PassNote[];
  /** The older version's Milestones section cannot be read, so it would need repair. */
  unreadable: boolean;
}

/**
 * Every pass restoring `older` over `current` would add, change or undo,
 * matched by id. An older text with an unreadable section undoes every
 * current pass and marks none.
 */
export function restoreMilestoneChanges(current: string, older: string): RestoreMilestoneChanges {
  const now = passedMilestones(parseMilestones(current));
  const plan = parseMilestones(older);
  if (plan.kind === 'malformed') {
    const same = JSON.stringify(milestoneSectionBodies(current)) === JSON.stringify(milestoneSectionBodies(older));
    return { adds: [], changes: [], undoes: same ? [] : now.map(note), unreadable: !same };
  }
  const then = new Map(passedMilestones(plan).map((item) => [item.id as string, item]));
  const before = new Set(now.map((item) => item.id as string));
  const changes: RestoreMilestoneChanges['changes'] = [];
  const undoes: PassNote[] = [];
  for (const item of now) {
    const restored = then.get(item.id);
    if (!restored) undoes.push(note(item));
    else if (formatMilestone(restored) !== formatMilestone(item)) changes.push({ from: note(item), to: note(restored) });
  }
  const adds = [...then.values()].filter((item) => !before.has(item.id)).map(note);
  return { adds, changes, undoes, unreadable: false };
}

/** The text a repair view starts from: every Milestones section body, in order. */
export function milestoneRepairText(document: string): string {
  return milestoneSectionBodies(document).join('\n');
}

/** A pass a repair would record, with the exact line Jay must have reviewed. */
export interface RepairPass extends PassNote { line: string }

export type RepairPreview =
  | { ok: true; plan: Extract<MilestonePlan, { kind: 'plan' | 'none' }>; passes: RepairPass[]; content: string }
  | { ok: false; reason: string };

/**
 * Jay's repair of a malformed section: `body` replaces every Milestones
 * section, at the place of the first. The result must parse as a valid plan.
 */
export function previewMilestoneRepair(document: string, body: string): RepairPreview {
  const text = body.replace(/\r\n/g, '\n').replace(/^\n+|\s+$/g, '');
  const plan = parseMilestoneSection(text);
  if (plan.kind === 'malformed') return { ok: false, reason: plan.reason };
  if (plan.kind === 'absent') return { ok: false, reason: 'The Milestones section is empty.' };
  const doc = parseProjectDoc(document);
  const first = doc.sections.findIndex((s) => s.level === 2 && s.title === MILESTONES_HEADING);
  if (first < 0) return { ok: false, reason: 'This project has no Milestones section to repair.' };
  doc.sections = doc.sections.filter((s, index) => index === first || !(s.level === 2 && s.title === MILESTONES_HEADING));
  doc.sections[first]!.body = text;
  const content = serializeProjectDoc(doc);
  // The rest of the document must read back unchanged, so a body holding a heading cannot add sections.
  const after = parseMilestones(content);
  if (after.kind !== plan.kind || milestoneSectionBodies(content).length !== 1 || milestoneSectionBodies(content)[0] !== text) {
    return { ok: false, reason: 'The milestones text cannot contain a heading line.' };
  }
  return { ok: true, plan, passes: passedMilestones(plan).map((item) => ({ ...note(item), line: formatMilestone(item) })), content };
}
