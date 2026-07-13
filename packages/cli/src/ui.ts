/**
 * Shared terminal styling for the NorthKeep CLI (M9a). One home for the ANSI
 * codes (previously duplicated in converseCmd.ts), the brand palette, and the
 * ASCII keep logo used by the launcher.
 *
 * Colors degrade gracefully: when stdout isn't a TTY or NO_COLOR is set, every
 * helper returns the plain string, so piped/redirected output stays clean.
 */

const useColor = (): boolean =>
  process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb' && process.stdout.isTTY === true;

// Basic ANSI (kept for compatibility with existing call sites).
export const DIM = '\x1b[2m';
export const BOLD = '\x1b[1m';
export const GREEN = '\x1b[32m';
export const YELLOW = '\x1b[33m';
export const RED = '\x1b[31m';
export const RESET = '\x1b[0m';

// Brand palette (256-color; Meridian pine + gold + cream).
const PINE = '\x1b[38;5;29m';
const GOLD = '\x1b[38;5;179m';
const CREAM = '\x1b[38;5;230m';
const MUTED = '\x1b[38;5;245m';

/** Wrap `s` in `code` … RESET, or return it plain when color is off. */
function paint(code: string, s: string): string {
  return useColor() ? `${code}${s}${RESET}` : s;
}

export const c = {
  dim: (s: string) => paint(DIM, s),
  bold: (s: string) => paint(BOLD, s),
  green: (s: string) => paint(GREEN, s),
  yellow: (s: string) => paint(YELLOW, s),
  red: (s: string) => paint(RED, s),
  pine: (s: string) => paint(PINE, s),
  gold: (s: string) => paint(GOLD, s),
  cream: (s: string) => paint(CREAM, s),
  muted: (s: string) => paint(MUTED, s),
};

/**
 * The NorthKeep keep: a crenellated tower (merlons on top, tapering banner
 * base) with the N, in pine + gold — a text echo of the app icon. Full blocks
 * render in every monospace terminal.
 */
export function logo(): string {
  const g = (s: string) => paint(PINE, s);
  const gold = (s: string) => paint(GOLD, s);
  const n = paint(CREAM + BOLD, 'N');
  const lines = [
    `  ${g('██')} ${g('██')} ${g('██')}`,
    `  ${g('██████████')}`,
    `  ${g('███')} ${n} ${g('███')}   ${paint(BOLD, 'NorthKeep')}`,
    `  ${g('██████████')}   ${c.muted('your memory · your models · your machine')}`,
    `   ${gold('▜')}${g('██████')}${gold('▛')}`,
    `    ${gold('▜')}${g('████')}${gold('▛')}`,
    `     ${gold('▜██▛')}`,
  ];
  return lines.join('\n');
}

/** A labeled status row: "  label  value" with a dim label. */
export function statusRow(label: string, value: string): string {
  return `  ${c.muted(label.padEnd(11))}${value}`;
}

/** Privacy dot for an endpoint tier. */
export function tierDot(tier: 'private' | 'bounded'): string {
  return tier === 'private' ? c.green('● private') : c.yellow('● bounded');
}
