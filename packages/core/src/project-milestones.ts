/**
 * Project milestones (ADR 0065): the `## Milestones` section of a project
 * document. One pure module owns the grammar, the limits and every transition,
 * so the vault, the MCP server and the apps read the plan the same way. No I/O.
 *
 * `confirmPass`, the owner's transition, lives in project-milestones-owner.ts
 * behind its own package entry point.
 */
import { parseProjectDoc } from './project-doc.js';

export const MILESTONES_HEADING = 'Milestones';
export const MILESTONE_MAX_ITEMS = 20;
export const MILESTONE_LINE_MAX_CHARS = 240;
export const MILESTONE_TITLE_MAX_CHARS = 80;
export const MILESTONE_TEST_MAX_CHARS = 120;
export const MILESTONE_ID_PATTERN = /^M[1-9][0-9]{0,2}$/;

export type MilestoneId = string & { readonly __brand: 'MilestoneId' };
export type MilestoneAuthor = 'you' | 'agent';
export type OpenMilestone = { id: MilestoneId; title: string; test: string; state: 'open' };
export type PassedMilestone = { id: MilestoneId; title: string; test: string; state: 'passed'; on: string; by: MilestoneAuthor };
export type Milestone = OpenMilestone | PassedMilestone;
export type MilestonePlan =
  | { kind: 'absent' }
  | { kind: 'none'; reason: string }
  | { kind: 'plan'; items: Milestone[] }
  | { kind: 'malformed'; reason: string };
/** The plans that can be written back as text. */
export type ValidMilestonePlan = Extract<MilestonePlan, { kind: 'none' | 'plan' }>;

/** One open milestone an agent proposes; an omitted id gets the next free number. */
export interface MilestoneProposal { id?: string; title: string; test: string }
export type MilestonePlanInput = { kind: 'plan'; items: MilestoneProposal[] } | { kind: 'none'; reason: string };

/** Progress for project lists (ADR 0065 Decision 1). */
export interface MilestoneSummary { passed: number; total: number; current: { id: string; title: string } | null }

export class MilestoneError extends Error {
  constructor(message: string) { super(message); this.name = 'MilestoneError'; }
}

export const MILESTONE_LINE_FORMAT = '- [ ] M1 Title | test: how the user checks it';
export const MILESTONES_MALFORMED_MESSAGE =
  'The Milestones section does not follow the milestone format, so it cannot be changed here. Ask the user to repair it in the NorthKeep app.';

const ABSENT: MilestonePlan = { kind: 'absent' };
/** Control, format and line-separator characters: invisible text must not enter a milestone line. */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const LINE = /^- \[([ x])\] (M[1-9][0-9]{0,2}) ([^|]*) \| test: ([^|]*?)(?: \| passed (\d{4}-\d{2}-\d{2}) \((you|agent)\))?$/;
const NONE = /^none: (.*)$/;
/** Letters from other scripts that render like the Latin letters of "you", "agent" and "passed". */
const CONFUSABLES: Record<string, string> = {
  'а': 'a', 'ɑ': 'a', 'α': 'a', 'е': 'e', 'ε': 'e', 'о': 'o', 'ο': 'o', 'σ': 'o', 'у': 'y', 'γ': 'y', 'ү': 'y',
  'υ': 'u', 'ս': 'u', 'ц': 'u', 'п': 'n', 'ո': 'n', 'η': 'n', 'т': 't', 'τ': 't', 'ɡ': 'g', 'ց': 'g', 'р': 'p', 'ρ': 'p',
  'ѕ': 's', 'ꜱ': 's', 'с': 'c', 'х': 'x', 'χ': 'x', '×': 'x', 'і': 'i', 'ι': 'i', 'ј': 'j', 'ԁ': 'd', 'һ': 'h',
  'М': 'm', 'м': 'm', 'Μ': 'm', 'μ': 'm',
  '⟨': '(', '〈': '(', '‹': '(', '«': '(', '【': '(', '〔': '(', '「': '(', '『': '(', '❨': '(', '❪': '(',
  '⟩': ')', '〉': ')', '›': ')', '»': ')', '】': ')', '〕': ')', '」': ')', '』': ')', '❩': ')', '❫': ')',
};
/** The text as a reader sees it: compatibility forms folded, marks and invisible characters dropped, lower case, lookalike letters mapped. */
export function milestoneSkeleton(text: string): string {
  const folded = text.normalize('NFKD').replace(/[\p{M}\p{Cf}]/gu, '').normalize('NFKC').toLowerCase();
  return [...folded].map((ch) => CONFUSABLES[ch] ?? ch).join('').replace(/\s+/g, ' ');
}
const CHECKBOX = /\[\s*[^\]\sa-wyz0-9]?\s*\]|[☐☑☒✅✓✔✗✘❎🗹🗸√✕✖]/u;
const AUTHOR_STAMP = /[([{<]\s*(?:you|agent)\s*[)\]}>]/;
const PASSED_DATE = /\bpass(?:ed)?\b[^0-9a-z]{0,5}\d{4}[^0-9a-z]\d{1,2}[^0-9a-z]\d{1,2}/;
/** A checkbox or a pass stamp inside milestone text would read as a pass to a person (review wound W2). */
export function looksLikePass(text: string): boolean {
  const skeleton = milestoneSkeleton(text);
  return CHECKBOX.test(skeleton) || AUTHOR_STAMP.test(skeleton) || PASSED_DATE.test(skeleton);
}
/** A line carrying an author stamp or a pass date. No id is required: a reader takes such a line as a pass whatever it is numbered (K1 review finding A). */
function carriesPassStamp(line: string): boolean {
  const skeleton = milestoneSkeleton(line);
  return AUTHOR_STAMP.test(skeleton) || PASSED_DATE.test(skeleton);
}
const LONGEST_STAMP = ' | passed 0000-00-00 (agent)';

export function asMilestoneId(value: string): MilestoneId | null {
  return MILESTONE_ID_PATTERN.test(value) ? (value as MilestoneId) : null;
}

function textProblem(value: string, field: 'title' | 'test' | 'reason', max: number): string | null {
  if (value.length === 0) return `The ${field} is empty.`;
  if (value !== value.trim()) return `The ${field} starts or ends with a space.`;
  if (value.includes('|')) return `The ${field} contains "|".`;
  if (UNSAFE_CHARS.test(value)) return `The ${field} contains a line break, control or invisible formatting character.`;
  if (value.length > max) return `The ${field} is ${value.length} characters; the limit is ${max}.`;
  return null;
}

export function formatMilestone(item: Milestone): string {
  switch (item.state) {
    case 'open':
      return `- [ ] ${item.id} ${item.title} | test: ${item.test}`;
    case 'passed':
      return `- [x] ${item.id} ${item.title} | test: ${item.test} | passed ${item.on} (${item.by})`;
    default: {
      const unreachable: never = item;
      return unreachable;
    }
  }
}

/** The section body for a plan; parseMilestoneSection is its inverse. */
export function formatMilestones(plan: ValidMilestonePlan): string {
  switch (plan.kind) {
    case 'none':
      return `none: ${plan.reason}`;
    case 'plan':
      return plan.items.map(formatMilestone).join('\n');
    default: {
      const unreachable: never = plan;
      return unreachable;
    }
  }
}

function isUtcDate(value: string): boolean {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function lineProblem(line: string, n: number): string | null {
  if (line.length > MILESTONE_LINE_MAX_CHARS) return `Line ${n} is ${line.length} characters; the limit is ${MILESTONE_LINE_MAX_CHARS}.`;
  return null;
}

function parseLine(line: string, n: number): Milestone | string {
  const match = LINE.exec(line);
  if (!match) return `Line ${n} does not follow the format "${MILESTONE_LINE_FORMAT}".`;
  const [, box, id, title, test, on, by] = match as unknown as [string, string, string, string, string, string | undefined, string | undefined];
  const passed = on !== undefined;
  if (box === 'x' && !passed) return `Line ${n} is checked but has no pass stamp.`;
  if (box !== 'x' && passed) return `Line ${n} has a pass stamp but its box is not checked.`;
  const problem = textProblem(title, 'title', MILESTONE_TITLE_MAX_CHARS) ?? textProblem(test, 'test', MILESTONE_TEST_MAX_CHARS) ?? lineProblem(line, n);
  if (problem !== null) return problem.startsWith('Line') ? problem : `Line ${n}: ${problem}`;
  if (!passed) return { id: id as MilestoneId, title, test, state: 'open' };
  if (!isUtcDate(on)) return `Line ${n} has a pass date that is not a real date.`;
  return { id: id as MilestoneId, title, test, state: 'passed', on, by: by as MilestoneAuthor };
}

/** Parses the body of a `## Milestones` section. */
export function parseMilestoneSection(body: string): MilestonePlan {
  const text = body.replace(/\r\n/g, '\n');
  if (text.length === 0) return { kind: 'malformed', reason: 'The Milestones section is empty.' };
  const lines = text.split('\n');
  const none = NONE.exec(lines[0]!);
  if (none) {
    if (lines.length !== 1) return { kind: 'malformed', reason: 'A none: line must be the only line in the Milestones section.' };
    const problem = textProblem(none[1]!, 'reason', MILESTONE_LINE_MAX_CHARS - 'none: '.length);
    return problem === null ? { kind: 'none', reason: none[1]! } : { kind: 'malformed', reason: `Line 1: ${problem}` };
  }
  if (lines.length > MILESTONE_MAX_ITEMS) return { kind: 'malformed', reason: `The plan has ${lines.length} lines; the limit is ${MILESTONE_MAX_ITEMS} milestones.` };
  const items: Milestone[] = [];
  const seen = new Set<string>();
  for (const [index, line] of lines.entries()) {
    const parsed = parseLine(line, index + 1);
    if (typeof parsed === 'string') return { kind: 'malformed', reason: parsed };
    if (seen.has(parsed.id)) return { kind: 'malformed', reason: `${parsed.id} appears more than once.` };
    seen.add(parsed.id);
    if (parsed.state === 'passed' && items.some((item) => item.state === 'open')) {
      return { kind: 'malformed', reason: `${parsed.id} has passed but comes after a milestone that has not; passed milestones come first.` };
    }
    items.push(parsed);
  }
  return { kind: 'plan', items };
}

/** Bodies of every level-2 Milestones section, in document order. */
export function milestoneSectionBodies(document: string): string[] {
  return parseProjectDoc(document).sections.filter((s) => s.level === 2 && s.title === MILESTONES_HEADING).map((s) => s.body);
}

/** The plan in a project document. Only a level-2 `## Milestones` heading holds it. */
export function parseMilestones(document: string): MilestonePlan {
  const bodies = milestoneSectionBodies(document);
  if (bodies.length === 0) return ABSENT;
  if (bodies.length > 1) return { kind: 'malformed', reason: 'The document has more than one Milestones section.' };
  return parseMilestoneSection(bodies[0]!);
}

export function passedMilestones(plan: MilestonePlan): PassedMilestone[] {
  return plan.kind === 'plan' ? plan.items.filter((item): item is PassedMilestone => item.state === 'passed') : [];
}

/** The first open milestone: the one being worked on. */
export function currentMilestone(plan: MilestonePlan): OpenMilestone | null {
  if (plan.kind !== 'plan') return null;
  return plan.items.find((item): item is OpenMilestone => item.state === 'open') ?? null;
}

export function summarizeMilestones(plan: MilestonePlan): MilestoneSummary | null {
  switch (plan.kind) {
    case 'plan': {
      const current = currentMilestone(plan);
      return { passed: passedMilestones(plan).length, total: plan.items.length, current: current ? { id: current.id, title: current.title } : null };
    }
    case 'absent':
    case 'none':
    case 'malformed':
      return null;
    default: {
      const unreachable: never = plan;
      return unreachable;
    }
  }
}

/** The plan as a project document can hold it: the line, the count and the stamp limits. */
export function assertPlanFits(items: Milestone[]): void {
  if (items.length > MILESTONE_MAX_ITEMS) throw new MilestoneError(`The plan has ${items.length} milestones; the limit is ${MILESTONE_MAX_ITEMS}.`);
  for (const item of items) {
    const line = formatMilestone(item);
    if (line.length > MILESTONE_LINE_MAX_CHARS) throw new MilestoneError(`Milestone ${item.id} would be ${line.length} characters long; the limit is ${MILESTONE_LINE_MAX_CHARS}. Shorten its title or test.`);
  }
}

/**
 * Proposed text as sent by an agent: one milestone per line, `M3 Title | test: Test`
 * (the id is optional), or a single `none: <reason>` line. Blank lines are skipped.
 */
export function parseMilestoneProposals(text: string): MilestonePlanInput {
  if (typeof text !== 'string') throw new MilestoneError('milestones must be text, one milestone per line.');
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) throw new MilestoneError('milestones is empty. Send one line per milestone, like "M1 Agree the milestones | test: the user approves the plan", or one line "none: <reason>".');
  const none = NONE.exec(lines[0]!);
  if (none) {
    if (lines.length !== 1) throw new MilestoneError('A none: line must be the only line in milestones.');
    return { kind: 'none', reason: none[1]!.trim() };
  }
  const items = lines.map((line, index): MilestoneProposal => {
    const n = index + 1;
    if (looksLikePass(line)) throw new MilestoneError(`Line ${n} has a checkbox or a pass stamp. Send open milestones only, like "M3 Title | test: how the user checks it"; NorthKeep records passes itself.`);
    const parts = line.split('|');
    if (parts.length !== 2 || !/^\s*test:/.test(parts[1]!)) throw new MilestoneError(`Line ${n} must look like "M3 Title | test: how the user checks it", with one "|".`);
    const test = parts[1]!.replace(/^\s*test:/, '').trim();
    const head = parts[0]!.trim();
    const first = head.split(/\s+/, 1)[0]!;
    if (/^M\d+$/.test(first)) {
      if (asMilestoneId(first) === null) throw new MilestoneError(`Line ${n}: ${first} is not a milestone id. Ids run from M1 to M999.`);
      return { id: first, title: head.slice(first.length).trim(), test };
    }
    return { title: head, test };
  });
  return { kind: 'plan', items };
}

function proposalProblem(item: MilestoneProposal, n: number): string | null {
  if (item === null || typeof item !== 'object' || typeof item.title !== 'string' || typeof item.test !== 'string') return `Milestone ${n} needs a title and a test.`;
  if (looksLikePass(item.title) || looksLikePass(item.test)) return `Milestone ${n} has a checkbox or a pass stamp in its text. Send open milestones only; NorthKeep records passes itself.`;
  const problem = textProblem(item.title, 'title', MILESTONE_TITLE_MAX_CHARS) ?? textProblem(item.test, 'test', MILESTONE_TEST_MAX_CHARS);
  return problem === null ? null : `Milestone ${n}: ${problem}`;
}

/**
 * The agents' transition: replaces the open part of the plan. Passed
 * milestones carry over byte for byte, first and in order. Refuses a
 * malformed current plan, since its passes cannot be seen.
 */
export function replacePlan(current: MilestonePlan, incoming: MilestonePlanInput): ValidMilestonePlan {
  if (current.kind === 'malformed') throw new MilestoneError(MILESTONES_MALFORMED_MESSAGE);
  const passed = passedMilestones(current);
  switch (incoming.kind) {
    case 'none': {
      if (passed.length > 0) throw new MilestoneError('This project has passed milestones, so its plan cannot be replaced with none:.');
      const problem = typeof incoming.reason === 'string' ? textProblem(incoming.reason, 'reason', MILESTONE_LINE_MAX_CHARS - 'none: '.length) : 'The reason is missing.';
      if (problem !== null) throw new MilestoneError(`none: ${problem}`);
      return { kind: 'none', reason: incoming.reason };
    }
    case 'plan': {
      if (!Array.isArray(incoming.items)) throw new MilestoneError('milestones must be a list.');
      if (incoming.items.length === 0 && passed.length === 0) throw new MilestoneError('Send at least one milestone, or none: and a reason.');
      const passedIds = new Set<string>(passed.map((m) => m.id));
      const used = new Set<string>(passedIds);
      incoming.items.forEach((item, index) => {
        const problem = proposalProblem(item, index + 1);
        if (problem !== null) throw new MilestoneError(problem);
        if (item.id === undefined) return;
        if (typeof item.id !== 'string' || asMilestoneId(item.id) === null) throw new MilestoneError(`Milestone ${index + 1}: ${String(item.id)} is not a milestone id. Ids run from M1 to M999.`);
        if (passedIds.has(item.id)) throw new MilestoneError(`${item.id} has already passed. Passed milestones cannot be changed; send only the milestones still to do.`);
        if (used.has(item.id)) throw new MilestoneError(`${item.id} appears more than once.`);
        used.add(item.id);
      });
      let next = Math.max(0, ...[...used].map((id) => Number(id.slice(1)))) + 1;
      const open = incoming.items.map((item): OpenMilestone => {
        let id = item.id;
        if (id === undefined) {
          while (used.has(`M${next}`)) next += 1;
          id = `M${next}`;
          used.add(id);
        }
        const valid = asMilestoneId(id);
        if (valid === null) throw new MilestoneError(`There is no free milestone id left; ids run from M1 to M999.`);
        return { id: valid, title: item.title, test: item.test, state: 'open' };
      });
      // Room for the longest stamp, so an open milestone can always be passed later.
      for (const item of open) {
        const width = formatMilestone(item).length + LONGEST_STAMP.length;
        if (width > MILESTONE_LINE_MAX_CHARS) throw new MilestoneError(`Milestone ${item.id} is too long: with its pass stamp the line would be ${width} characters, and the limit is ${MILESTONE_LINE_MAX_CHARS}. Shorten its title or test.`);
      }
      const items: Milestone[] = [...passed, ...open];
      assertPlanFits(items);
      return { kind: 'plan', items };
    }
    default: {
      const unreachable: never = incoming;
      return unreachable;
    }
  }
}

/** UTC date of a save timestamp; a replay passes the ledger's saved_at, so it rebuilds the same bytes. */
export function passDate(savedAt: string): string {
  const parsed = Date.parse(savedAt);
  if (!Number.isFinite(parsed)) throw new MilestoneError('The save time is not a valid timestamp.');
  return new Date(parsed).toISOString().slice(0, 10);
}

/** The pass an agent reports at checkpoint or wrap: the current milestone only, stamped (agent). */
export function recordAgentPass(current: MilestonePlan, id: string, savedAt: string): { plan: ValidMilestonePlan; passed: PassedMilestone } {
  switch (current.kind) {
    case 'malformed':
      throw new MilestoneError(MILESTONES_MALFORMED_MESSAGE);
    case 'absent':
    case 'none':
      throw new MilestoneError('This project has no milestone plan, so there is no milestone to report passed.');
    case 'plan': {
      const open = currentMilestone(current);
      if (open === null) throw new MilestoneError('Every milestone in this project has already passed.');
      if (open.id !== id) throw new MilestoneError(`Only the current milestone, ${open.id}, can be reported passed. Report a milestone passed only when the user says its acceptance test passed.`);
      const passed: PassedMilestone = { id: open.id, title: open.title, test: open.test, state: 'passed', on: passDate(savedAt), by: 'agent' };
      const items = current.items.map((item) => (item.id === open.id ? passed : item));
      assertPlanFits(items);
      return { plan: { kind: 'plan', items }, passed };
    }
    default: {
      const unreachable: never = current;
      return unreachable;
    }
  }
}

function headingText(line: string): string | null {
  const match = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
  return match === null ? null : (match[1] ?? '');
}

/** A setext underline. The line above it reads as a heading to a person, whatever Markdown makes of it. */
const SETEXT_UNDERLINE = /^ {0,3}[=-]+\s*$/;
const MILESTONE_ID_SKELETON = /(?<![\p{L}\p{N}])m ?0*[1-9][0-9]{0,2}(?!\p{N})/u;

/**
 * Lines outside the one real Milestones section, counted, so an addition can be
 * told from a line already there. A setext heading counts as one more entry,
 * its text and underline joined by a newline, which no single line can hold.
 */
function linesOutsideSection(document: string): Map<string, number> {
  const lines = document.replace(/\r\n/g, '\n').split('\n');
  const bodies = milestoneSectionBodies(document);
  const inside = new Map<string, number>();
  if (bodies.length === 1) for (const line of bodies[0]!.replace(/\r\n/g, '\n').split('\n')) inside.set(line, (inside.get(line) ?? 0) + 1);
  const kept: string[] = [];
  for (const line of lines) {
    const skip = inside.get(line) ?? 0;
    if (skip > 0) { inside.set(line, skip - 1); continue; }
    kept.push(line);
  }
  const outside = new Map<string, number>();
  const count = (key: string) => outside.set(key, (outside.get(key) ?? 0) + 1);
  kept.forEach((line, i) => {
    count(line);
    const next = kept[i + 1];
    if (next !== undefined && line.trim() !== '' && SETEXT_UNDERLINE.test(next)) count(`${line}\n${next}`);
  });
  return outside;
}

const HEADING_REFUSAL = 'A heading named like Milestones can only be "## Milestones". Use that exact heading for the plan.';

/** Review wound W3 and K4 review F1: no stamped or checkbox milestone line outside the section, and no heading that only looks like Milestones. */
function assertNothingMilestoneLikeAdded(before: string | null, after: string): void {
  const was = before === null ? new Map<string, number>() : linesOutsideSection(before);
  const added = (line: string, count: number) => count > (was.get(line) ?? 0);
  for (const [line, count] of linesOutsideSection(after)) {
    if (!added(line, count)) continue;
    if (line.includes('\n')) {
      if (milestoneSkeleton(line.slice(0, line.indexOf('\n'))).trim() === 'milestones') throw new MilestoneError(HEADING_REFUSAL);
      continue;
    }
    const heading = headingText(line);
    if (heading !== null && line !== `## ${MILESTONES_HEADING}` && milestoneSkeleton(heading).trim() === 'milestones') {
      throw new MilestoneError(HEADING_REFUSAL);
    }
    if (carriesPassStamp(line)) {
      throw new MilestoneError('Only the Milestones section can hold a passed milestone line. An AI app cannot add one anywhere else.');
    }
    const skeleton = milestoneSkeleton(line);
    if (CHECKBOX.test(skeleton) && MILESTONE_ID_SKELETON.test(skeleton)) {
      throw new MilestoneError('Only the Milestones section can hold a milestone line with a checkbox. An AI app cannot add one anywhere else.');
    }
  }
}

/**
 * The agent write rule (ADR 0065 Decision 2). Compares the parsed plans of the
 * document before and after an agent write: every passed milestone stays
 * byte-identical by id, no new pass appears except `allowedPass`, and the
 * section stays valid. A section that was already malformed must stay
 * byte-identical. `before` is null when the write creates the document.
 */
export function assertAgentWriteKeepsPasses(before: string | null, after: string, allowedPass?: PassedMilestone): void {
  assertSectionKeepsPasses(before, after, allowedPass);
  assertNothingMilestoneLikeAdded(before, after);
}

function assertSectionKeepsPasses(before: string | null, after: string, allowedPass?: PassedMilestone): void {
  const was = before === null ? ABSENT : parseMilestones(before);
  if (was.kind === 'malformed') {
    const old = milestoneSectionBodies(before!);
    const now = milestoneSectionBodies(after);
    if (old.length !== now.length || old.some((body, i) => body !== now[i])) {
      throw new MilestoneError(`${MILESTONES_MALFORMED_MESSAGE} Leave that section exactly as it is.`);
    }
    return;
  }
  const is = parseMilestones(after);
  if (is.kind === 'malformed') throw new MilestoneError(`This change would leave the Milestones section unreadable, so nothing was saved: ${is.reason}`);
  const kept = passedMilestones(was);
  if (kept.length > 0 && is.kind !== 'plan') {
    throw new MilestoneError('This project has passed milestones, so its Milestones section must stay, with every passed line unchanged.');
  }
  const now = new Map(passedMilestones(is).map((item) => [item.id as string, item]));
  for (const item of kept) {
    const found = now.get(item.id);
    if (found === undefined || formatMilestone(found) !== formatMilestone(item)) {
      throw new MilestoneError(`${item.id} has passed, so its line cannot be changed, moved out of Milestones or removed.`);
    }
    now.delete(item.id);
  }
  for (const item of now.values()) {
    if (allowedPass === undefined || allowedPass.by !== 'agent' || item.id !== allowedPass.id || formatMilestone(item) !== formatMilestone(allowedPass)) {
      throw new MilestoneError(`An AI app cannot mark ${item.id} passed this way. Report the current milestone passed with milestone_passed at a checkpoint or wrap, after the user says its test passed.`);
    }
  }
  const order = [...kept.map((item) => item.id), ...now.keys()];
  if (passedMilestones(is).some((item, i) => item.id !== order[i])) {
    throw new MilestoneError(`Passed milestones must stay in the order they passed: ${order.join(', ')}.`);
  }
  // Review wound W1: an open line an agent adds or changes cannot carry a stamp in its text.
  const earlier = new Set(was.kind === 'plan' ? was.items.map(formatMilestone) : []);
  for (const item of is.kind === 'plan' ? is.items : []) {
    if (item.state !== 'open' || earlier.has(formatMilestone(item))) continue;
    if (looksLikePass(item.title) || looksLikePass(item.test)) {
      throw new MilestoneError(`${item.id} has a checkbox or a pass stamp in its text. Open milestones cannot carry one; NorthKeep records passes itself.`);
    }
  }
}
