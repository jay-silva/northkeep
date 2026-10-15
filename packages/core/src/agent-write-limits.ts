/**
 * Limits an assistant's write meets at save time, so a problem is refused
 * where the assistant can fix it instead of surfacing later. The shared caps
 * mirror the connector's per-entry caps (apps/connector-server/src/create-server.ts),
 * which count UTF-8 bytes, not characters: a memory under 8192 characters
 * with accents or emoji can still be refused on push.
 */
import { parseProjectSlug } from './project-doc.js';

export const SHARED_ENTRY_CAP_BYTES = 8 * 1024;
export const SHARED_PROJECT_ENTRY_CAP_BYTES = 64 * 1024;
/** The project page shows Current Status as its summary; longer stops being readable. */
export const PROJECT_STATUS_AGENT_MAX_CHARS = 1000;

export function sharedEntryCapBytes(scope: string): number {
  return parseProjectSlug(scope) !== null ? SHARED_PROJECT_ENTRY_CAP_BYTES : SHARED_ENTRY_CAP_BYTES;
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1).replace(/\.0$/, '')} KB`;
}

/** Null when `content` fits the connector's cap for a shared `scope`. */
export function sharedEntryTooLargeMessage(scope: string, content: string): string | null {
  const cap = sharedEntryCapBytes(scope);
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes <= cap) return null;
  return (
    `Nothing was saved: this memory is ${kb(bytes)}, and "${scope}" is shared with the user's connected apps, ` +
    `which accept at most ${kb(cap)} per memory (${cap} bytes; accented letters and emoji count as more than one). ` +
    `Shorten it below ${kb(cap)} and keep every fact the user would miss, or split it into separate ` +
    'self-contained memories, then save again.'
  );
}

/** Null when an assistant's Current Status is short enough to read as a summary. */
export function projectStatusTooLongMessage(status: string): string | null {
  const chars = [...status].length;
  if (chars <= PROJECT_STATUS_AGENT_MAX_CHARS) return null;
  return (
    `Nothing was saved: status is ${chars} characters, and the limit is ${PROJECT_STATUS_AGENT_MAX_CHARS}. ` +
    'The user reads it as the project summary. Open with one short plain sentence saying where the project ' +
    'stands, with no commit hashes or ids, keep the rest brief, and move technical detail into agent_detail ' +
    '(For the Next Agent), the log entry, or a memory. Then send the update again.'
  );
}
