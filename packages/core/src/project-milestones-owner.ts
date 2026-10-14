/**
 * The owner's milestone transition (ADR 0065 Decision 2), on its own package
 * entry point, `@northkeep/core/project-milestones-owner`. The MCP server and
 * the connector never import it, and a test fails if either does. This keeps
 * the code organised; it is not a security boundary (see KNOWN-LIMITS).
 */
import {
  MilestoneError,
  MILESTONES_HEADING,
  MILESTONES_MALFORMED_MESSAGE,
  assertPlanFits,
  currentMilestone,
  parseMilestones,
  passDate,
  formatMilestones,
  type MilestonePlan,
  type PassedMilestone,
  type ValidMilestonePlan,
} from './project-milestones.js';
import { parseProjectDoc, serializeProjectDoc } from './project-doc.js';

/**
 * Jay confirms a pass: the current milestone, or one an agent already
 * reported passed. Either way the line is stamped (you) with the date of
 * this confirmation.
 */
export function confirmPass(current: MilestonePlan, id: string, savedAt: string): { plan: ValidMilestonePlan; passed: PassedMilestone } {
  switch (current.kind) {
    case 'malformed':
      throw new MilestoneError(MILESTONES_MALFORMED_MESSAGE);
    case 'absent':
    case 'none':
      throw new MilestoneError('This project has no milestone plan.');
    case 'plan': {
      const target = current.items.find((item) => item.id === id);
      if (target === undefined) throw new MilestoneError(`This project has no milestone ${id}.`);
      if (target.state === 'passed' && target.by === 'you') throw new MilestoneError(`${id} is already confirmed.`);
      if (target.state === 'open') {
        const open = currentMilestone(current);
        if (open?.id !== id) throw new MilestoneError(`Only the current milestone, ${open?.id ?? 'none'}, can be confirmed now. Milestones pass in order.`);
      }
      const passed: PassedMilestone = { id: target.id, title: target.title, test: target.test, state: 'passed', on: passDate(savedAt), by: 'you' };
      const items = current.items.map((item) => (item.id === id ? passed : item));
      assertPlanFits(items);
      return { plan: { kind: 'plan', items }, passed };
    }
    default: {
      const unreachable: never = current;
      return unreachable;
    }
  }
}

/** The whole document with `id` confirmed; every other section keeps its text. */
export function confirmPassInDocument(document: string, id: string, savedAt: string): { content: string; passed: PassedMilestone } {
  const { plan, passed } = confirmPass(parseMilestones(document), id, savedAt);
  const doc = parseProjectDoc(document);
  const section = doc.sections.find((s) => s.level === 2 && s.title === MILESTONES_HEADING);
  if (section === undefined) throw new MilestoneError('This project has no milestone plan.');
  section.body = formatMilestones(plan);
  return { content: serializeProjectDoc(doc), passed };
}
