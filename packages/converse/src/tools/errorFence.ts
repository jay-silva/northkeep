/**
 * Fencing for a FAILED tool call (ADR 0060 Decision 3). Error text from a
 * server or a website is third-party text in front of the model, exactly like
 * a result, so it gets the same nonce fence after category-based sanitizing.
 *
 * "Ours" is a closed set, checked: an error code or guidance sentence is left
 * outside the fence only when NorthKeep itself defines it. Everything else
 * (detail, unknown codes, foreign guidance, non-JSON content) is fenced.
 */
import { MCP_DEFINITIONS_CHANGED_GUIDANCE, MCP_TOOL_FAILED_GUIDANCE } from './mcp/client.js';
import { wrapUntrusted } from './untrusted.js';
import { WEB_FETCH_FALLBACK_GUIDANCE, WEB_FETCH_GUIDANCE } from './webFetch.js';
import { WEB_SEARCH_FALLBACK_GUIDANCE, WEB_SEARCH_GUIDANCE } from './webSearch.js';

/** The loop's own catch (task.ts) authors this one. */
export const TOOL_THREW_GUIDANCE = 'The tool failed unexpectedly. Consider a different approach.';

export const OUR_ERROR_CODES: ReadonlySet<string> = new Set([
  ...Object.keys(WEB_FETCH_GUIDANCE),
  ...Object.keys(WEB_SEARCH_GUIDANCE),
  'tool_failed',
  'tool_definitions_changed',
]);

export const OUR_GUIDANCE: ReadonlySet<string> = new Set([
  ...Object.values(WEB_FETCH_GUIDANCE),
  ...Object.values(WEB_SEARCH_GUIDANCE),
  WEB_FETCH_FALLBACK_GUIDANCE,
  WEB_SEARCH_FALLBACK_GUIDANCE,
  MCP_TOOL_FAILED_GUIDANCE,
  MCP_DEFINITIONS_CHANGED_GUIDANCE,
  TOOL_THREW_GUIDANCE,
]);

export const MAX_ERROR_DETAIL_CODE_POINTS = 2000;

const REPLACE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;
const FENCE_ANY = /\[\s*(?:END\s+)?EXTERNAL\s+CONTENT[^\]\n]*\]?/giu;

/** NFKC, then invisible and control code points to spaces, fence lookalikes defanged, then a code point cap. */
export function sanitizeErrorDetail(text: string): string {
  const cleaned = String(text)
    .normalize('NFKC')
    .replace(REPLACE, ' ')
    .replace(FENCE_ANY, '[fence-marker-removed]');
  // Array.from walks code points, so the cap can never leave half a surrogate pair.
  const points = Array.from(cleaned);
  return points.length > MAX_ERROR_DETAIL_CODE_POINTS
    ? points.slice(0, MAX_ERROR_DETAIL_CODE_POINTS).join('')
    : cleaned;
}

export interface FencedFailure {
  content: string;
  /** Content-free line for the user: our code and guidance only. */
  errorLine: string;
}

export function fenceFailedResult(
  content: string,
  toolName: string,
  nonce: string,
  now: () => Date = () => new Date(),
): FencedFailure {
  let error: string | undefined;
  let guidance: string | undefined;
  const theirs: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = undefined;
  }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (key === 'error' && typeof value === 'string' && OUR_ERROR_CODES.has(value)) error = value;
      else if (key === 'guidance' && typeof value === 'string' && OUR_GUIDANCE.has(value)) guidance = value;
      else theirs.push(typeof value === 'string' ? `${key}: ${value}` : `${key}: ${JSON.stringify(value)}`);
    }
  } else if (content.length > 0) {
    theirs.push(content);
  }
  const ours = JSON.stringify({ error: error ?? 'tool_failed', ...(guidance !== undefined ? { guidance } : {}) });
  const fenced = theirs.length > 0
    ? `\n${wrapUntrusted(sanitizeErrorDetail(theirs.join('\n')), `${toolName} (error)`, nonce, now)}`
    : '';
  return {
    content: `${ours}${fenced}`,
    errorLine: [error ?? 'tool_failed', guidance].filter(Boolean).join(': '),
  };
}
