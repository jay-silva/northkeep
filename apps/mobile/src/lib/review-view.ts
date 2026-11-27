/**
 * The Review tab's fixed words (ADR 0095 section 2). Pure, so the copy is
 * unit-tested in apps/mobile/test/review-view.test.ts. Everything NorthKeep
 * says on that screen comes from here; saved text and app names are only ever
 * values the screen draws inside labelled boxes or after "App:".
 */

import type { AcceptedLine, AnswerReport, NeedsYesItem } from '@northkeep/sync';

export const REVIEW_TITLE = 'Review';
export const REVIEW_SECTION_NEEDS = 'Needs your yes';
export const REVIEW_SECTION_ACCEPTED = 'Accepted lately';
export const REVIEW_EMPTY_TITLE = 'Nothing needs your yes.';
export const REVIEW_EMPTY_BODY =
  'When an AI app asks to change or remove a memory, or a fact about money, ownership, accounts, legal matters or numbers needs you, it shows here.';
export const REVIEW_EMPTY_ACCEPTED = 'Answers your AI apps settle in chat, and each Yes you give on this phone, are listed under Accepted lately.';
export const REVIEW_REPORTED_WORDS = 'Reported words';
export const REVIEW_REPORTED_FACT = 'Reported fact';
export const REVIEW_VOID_LINE = "An app's answer could not be used, so nothing changed.";
export const REVIEW_NOTHING_ACCEPTED = 'Nothing accepted yet.';
export const REVIEW_FORGET_NO_APP = 'Asked by a connected app. NorthKeep does not record which one or when.';
export const REVIEW_FORGET_NOT_SHARED = 'Asked while this collection was shared with your apps. It is not shared now.';
export const REVIEW_FORGET_CONFIRM_TITLE = 'Forget this memory on all your devices?';
export const REVIEW_FORGET_CONFIRM_BODY = 'This cannot be undone.';
export const REVIEW_UNDO_CONFIRM_TITLE = 'Undo this?';
export const REVIEW_UNDO_CONFIRM_BODY = 'The memory it retired comes back and the mark is removed.';
export const REVIEW_UNDO_BOTH_BODY = 'Both memories stay as they are, and a later answer about them waits for you.';
export const REVIEW_FORGOTTEN_LINE = 'A memory was forgotten, as a connected app asked. Its text is gone, so this cannot be undone.';
export const REVIEW_NOT_PAIRED = 'No AI app is connected through Cloud Connect yet, so nothing can be waiting.';

export function reviewHeading(kind: NeedsYesItem['kind']): string {
  if (kind === 'answer') return 'Settle a disagreement?';
  return kind === 'replace' ? 'Replace a memory?' : 'Forget a memory?';
}

/** The fixed lead before the reported words: the app is a value, never NorthKeep's voice. */
export function reportedLead(app: string | null): string {
  return `${app ?? 'a connected app'} (as the app reported) reported you said:`;
}

/** The reported answer as a fixed phrase. */
export function reportedAnswer(answer: AnswerReport['answer']): string {
  switch (answer) {
    case 'first': return 'Reported answer: 1 is right.';
    case 'second': return 'Reported answer: 2 is right.';
    case 'both': return 'Reported answer: both are right.';
    case 'neither': return 'Reported answer: neither; it reported the right fact as:';
  }
}

/** What Yes does to an answer, in NorthKeep's words. */
export function answerYesLine(answer: AnswerReport['answer']): string {
  switch (answer) {
    case 'first': return 'Yes marks 1 as confirmed by you and 2 as replaced by it. You can undo this.';
    case 'second': return 'Yes marks 2 as confirmed by you and 1 as replaced by it. You can undo this.';
    case 'both': return 'Yes marks both as confirmed by you. You can undo this.';
    case 'neither': return 'Yes marks the reported fact as confirmed by you and both memories as replaced by it. You can undo this.';
  }
}

/** The line above the sections, hidden at zero (ADR 0095 section 2). */
export function chatSinceLine(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count === 1
    ? '1 answer was accepted in chat since you last looked. It is under Accepted lately, with an Undo.'
    : `${count} answers were accepted in chat since you last looked. They are under Accepted lately, each with an Undo.`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Nov 24", in the phone's own time zone. */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** "3:12 PM", in the phone's own time zone. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const h = d.getHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "Today" for the current local day, otherwise the short date. */
export function dayLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? 'Today' : shortDate(iso);
}

/** The lines under a card's heading that say where the request came from. The app name is a value, never a sentence. */
export function sourceLines(item: Pick<NeedsYesItem, 'kind' | 'app' | 'arrived' | 'not_shared_now'>): string[] {
  if (item.kind === 'forget') return item.not_shared_now ? [REVIEW_FORGET_NO_APP, REVIEW_FORGET_NOT_SHARED] : [REVIEW_FORGET_NO_APP];
  const arrived = item.arrived !== null && shortDate(item.arrived) !== '' ? ` · arrived ${shortDate(item.arrived)}` : '';
  return [`App: ${item.app ?? 'a connected app'} (as the app reported)${arrived}`];
}

/** What Yes does, in NorthKeep's words. */
export function yesLine(kind: NeedsYesItem['kind']): string {
  return kind === 'replace' ? 'Yes marks Old as replaced by New. You can undo this.' : 'Yes forgets this memory on all your devices. This cannot be undone.';
}

export function buttonLabels(kind: NeedsYesItem['kind']): { yes: string; no: string; later: string } {
  if (kind === 'answer') return { yes: 'Yes, apply it', no: 'No', later: 'Not now' };
  return kind === 'replace' ? { yes: 'Replace', no: 'Keep both', later: 'Not now' } : { yes: 'Forget', no: 'Keep it', later: 'Not now' };
}

export function acceptedLead(line: Pick<AcceptedLine, 'state'> & Partial<Pick<AcceptedLine, 'kind' | 'by'>>): string {
  if (line.state === 'undone') return 'Undone';
  if (line.state === 'declined') return 'Declined';
  if (line.state === 'void') return 'Not used';
  const chat = line.kind === 'answer' && line.by === 'chat';
  if (line.state === 'both') return chat ? 'Both kept in chat' : 'You said yes on this phone';
  return chat ? 'Accepted in chat' : 'You said yes on this phone';
}

/** An answer's app as a value on its line. */
export function answerAppLine(app: string | undefined): string {
  return `App: ${app ?? 'a connected app'} (as the app reported)`;
}

/** After an undo the old memory is live again, so it is not "Retired". */
export function retiredLabel(line: Pick<AcceptedLine, 'state'>): string {
  return line.state === 'undone' ? 'Brought back' : 'Retired';
}

export function checkedLine(checkedAt: string | null): string {
  return checkedAt === null || clockTime(checkedAt) === '' ? 'Pull down to check.' : `Checked ${clockTime(checkedAt)}. Pull down to check again.`;
}

export function waitingOnMacLine(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? '1 change to a project waits for your Mac.' : `${count} changes to projects wait for your Mac.`;
}

export function hiddenLine(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? '1 item is hidden until tomorrow because you chose Not now.' : `${count} items are hidden until tomorrow because you chose Not now.`;
}

/** The tab's red number: nothing at zero, and "99+" past two digits so it never outgrows its dot. */
export function tabBadge(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count > 99 ? '99+' : String(Math.floor(count));
}

export function tabLabel(count: number): string {
  const n = tabBadge(count);
  return n === null ? 'Review' : `Review, ${n} need${count === 1 ? 's' : ''} your yes`;
}
