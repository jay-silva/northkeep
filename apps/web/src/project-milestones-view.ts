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

/**
 * The passes restoring `older` over `current` would undo: each passed line in
 * the current plan that the older text does not hold byte for byte. An older
 * text with an unreadable section undoes every current pass.
 */
export function passesUndoneByRestore(current: string, older: string): PassNote[] {
  const now = passedMilestones(parseMilestones(current));
  const then = parseMilestones(older);
  if (then.kind === 'malformed') return now.map(note);
  const kept = new Set(passedMilestones(then).map(formatMilestone));
  return now.filter((item) => !kept.has(formatMilestone(item))).map(note);
}

/** The text a repair view starts from: every Milestones section body, in order. */
export function milestoneRepairText(document: string): string {
  return milestoneSectionBodies(document).join('\n');
}

export type RepairPreview =
  | { ok: true; plan: Extract<MilestonePlan, { kind: 'plan' | 'none' }>; passes: PassNote[]; content: string }
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
  return { ok: true, plan, passes: passedMilestones(plan).map(note), content };
}
