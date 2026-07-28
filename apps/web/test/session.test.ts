import { describe, expect, it } from 'vitest';
import { UiSession } from '../src/session.js';

// checkToken never touches disk, so a bare vaultPath is fine.
function newSession(): UiSession {
  return new UiSession('/tmp/northkeep-session-test.nkv');
}

describe('UiSession.checkToken', () => {
  it('accepts the exact token', () => {
    const s = newSession();
    expect(s.checkToken(s.token)).toBe(true);
  });

  it('rejects undefined and empty', () => {
    const s = newSession();
    expect(s.checkToken(undefined)).toBe(false);
    expect(s.checkToken('')).toBe(false);
  });

  it('rejects a same-length wrong token without throwing', () => {
    const s = newSession();
    const wrong = 'f'.repeat(s.token.length);
    expect(s.checkToken(wrong)).toBe(false);
  });

  it('returns false (never throws) when UTF-16 length matches but UTF-8 bytes differ', () => {
    const s = newSession();
    // The real token is 64 ASCII hex chars → 64 UTF-8 bytes. Build a candidate
    // with the SAME UTF-16 code-unit count but a different UTF-8 byte length: a
    // trailing 'é' (U+00E9) is one UTF-16 unit but two UTF-8 bytes. The old
    // guard compared string .length, so this reached timingSafeEqual on
    // mismatched Buffer lengths and threw RangeError (an uncaught 500).
    const candidate = s.token.slice(0, s.token.length - 1) + 'é';
    expect(candidate.length).toBe(s.token.length); // equal UTF-16 length
    expect(Buffer.byteLength(candidate, 'utf8')).not.toBe(Buffer.byteLength(s.token, 'utf8'));
    expect(() => s.checkToken(candidate)).not.toThrow();
    expect(s.checkToken(candidate)).toBe(false);
  });
});
