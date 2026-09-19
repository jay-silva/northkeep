/**
 * The hosted mirror of core's assertProjectText: the connector cannot import
 * core, so the six-line rule is restated with the same regexes and messages.
 * A smuggled heading splits the document and makes local project_get refuse
 * the project the hosted tool just accepted.
 */
import { PROJECT_DOC_MAX_CHARS } from './project-doc.js';

export const PROJECT_FIELD_MAX_CHARS = PROJECT_DOC_MAX_CHARS;

export function projectTextError(value: string, field: string, allowEmpty: boolean): string | null {
  if (typeof value !== 'string' || value.length > PROJECT_FIELD_MAX_CHARS) {
    return `${field} is invalid or too long.`;
  }
  if (/\r/.test(value) || /^\n|\n$/.test(value) || /^( {0,3})#{1,6}[ \t]+\S/m.test(value)) {
    return `${field} contains unsupported section formatting.`;
  }
  if (!allowEmpty && value.trim().length === 0) return `${field} must not be empty.`;
  if (value.length > 0 && value.trim().length === 0) return `${field} cannot contain only whitespace.`;
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
