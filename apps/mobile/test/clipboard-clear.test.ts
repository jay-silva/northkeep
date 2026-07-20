import { describe, expect, it } from 'vitest';
import {
  SECRET_CLIPBOARD_CLEAR_MS,
  secretClearDue,
  shouldClearClipboard,
} from '../src/lib/clipboard-clear';

const SECRET = 'a'.repeat(64);

describe('shouldClearClipboard', () => {
  it('clears when the clipboard still holds exactly the copied secret', () => {
    expect(shouldClearClipboard(SECRET, SECRET)).toBe(true);
  });

  it('never clobbers something else the user copied since', () => {
    expect(shouldClearClipboard('a grocery list', SECRET)).toBe(false);
    expect(shouldClearClipboard('b'.repeat(64), SECRET)).toBe(false);
  });

  it('requires an exact match (grouped or whitespace-padded forms differ)', () => {
    expect(shouldClearClipboard(`${SECRET} `, SECRET)).toBe(false);
    expect(shouldClearClipboard(SECRET.slice(0, 4) + ' ' + SECRET.slice(4), SECRET)).toBe(false);
  });

  it('leaves an empty or unreadable clipboard alone', () => {
    expect(shouldClearClipboard('', SECRET)).toBe(false);
    expect(shouldClearClipboard(null, SECRET)).toBe(false);
    expect(shouldClearClipboard(undefined, SECRET)).toBe(false);
  });

  it('does nothing when no secret was copied', () => {
    expect(shouldClearClipboard(SECRET, null)).toBe(false);
    expect(shouldClearClipboard(SECRET, undefined)).toBe(false);
    expect(shouldClearClipboard('', '')).toBe(false);
  });
});

describe('secretClearDue', () => {
  it('is not due before the window elapses', () => {
    expect(secretClearDue(1_000, 1_000)).toBe(false);
    expect(secretClearDue(1_000, 1_000 + SECRET_CLIPBOARD_CLEAR_MS - 1)).toBe(false);
  });

  it('is due at and after the window', () => {
    expect(secretClearDue(1_000, 1_000 + SECRET_CLIPBOARD_CLEAR_MS)).toBe(true);
    expect(secretClearDue(1_000, 1_000 + SECRET_CLIPBOARD_CLEAR_MS * 10)).toBe(true);
  });

  it('window is about a minute (the UI copy says so)', () => {
    expect(SECRET_CLIPBOARD_CLEAR_MS).toBe(60_000);
  });
});
