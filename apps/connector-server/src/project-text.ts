/**
 * The hosted mirror of core's assertProjectText: the connector cannot import
 * core, so the six-line rule is restated with the same regexes and messages.
 * A smuggled heading splits the document and makes local project_get refuse
 * the project the hosted tool just accepted.
 */
import { PROJECT_DOC_MAX_CHARS } from './project-doc.js';

export const PROJECT_FIELD_MAX_CHARS = PROJECT_DOC_MAX_CHARS;

export function projectTextError(value: string, field: string, allowEmpty: boolean): string | null {
  if (typeof value !== 'string') return `${field} must be a string.`;
  if (value.length > PROJECT_FIELD_MAX_CHARS) {
    return `${field} is ${value.length} characters; the limit is ${PROJECT_FIELD_MAX_CHARS}.`;
  }
  if (/\r/.test(value)) return `${field} cannot contain a carriage return; use plain line breaks (\\n).`;
  if (/^\n|\n$/.test(value)) return `${field} cannot start or end with a line break.`;
  if (/^( {0,3})#{1,6}[ \t]+\S/m.test(value)) {
    return `${field} cannot contain a Markdown heading (a line starting with # and a space); it would split the project document.`;
  }
  if (!allowEmpty && value.trim().length === 0) return `${field} must not be empty.`;
  if (value.length > 0 && value.trim().length === 0) {
    return `${field} cannot contain only whitespace; send an empty string to clear it.`;
  }
  return null;
}

/**
 * The first refusal among the given fields, in argument order. `undefined`
 * fields are skipped: an omitted optional argument is not a value to check.
 */
export function firstProjectTextError(
  fields: Array<[field: string, value: string | undefined, allowEmpty: boolean]>,
): string | null {
  for (const [field, value, allowEmpty] of fields) {
    if (value === undefined) continue;
    const error = projectTextError(value, field, allowEmpty);
    if (error !== null) return error;
  }
  return null;
}

/**
 * The same rule in the words hosts read in the tool schema. The hosted tools
 * refuse line breaks at either end and CRLF rather than removing them.
 */
export const HOSTED_SECTION_TEXT_RULES =
  'Markdown without headings: a line starting with # and a space is refused. ' +
  'It must not start or end with a line break, and CRLF line endings are refused.';
