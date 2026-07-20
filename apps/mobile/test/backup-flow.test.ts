import { describe, expect, it } from 'vitest';
import { formatDeviceSecretGroups } from '../src/lib/backup-flow.js';
import { decodeDeviceSecret, parseManualSecret } from '../src/lib/link-url.js';

const SECRET_HEX =
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

describe('formatDeviceSecretGroups', () => {
  it('formats 64 hex chars as sixteen 4-char groups separated by single spaces', () => {
    const shown = formatDeviceSecretGroups(SECRET_HEX);
    const groups = shown.split(' ');
    expect(groups).toHaveLength(16);
    for (const g of groups) expect(g).toMatch(/^[0-9a-f]{4}$/);
    expect(shown.replace(/ /g, '')).toBe(SECRET_HEX);
  });

  it('normalizes case and surrounding whitespace', () => {
    expect(formatDeviceSecretGroups(` ${SECRET_HEX.toUpperCase()} `)).toBe(
      formatDeviceSecretGroups(SECRET_HEX),
    );
  });

  it('rejects wrong length and non-hex input (a malformed secret is a bug, not user input)', () => {
    expect(() => formatDeviceSecretGroups(SECRET_HEX.slice(0, 62))).toThrow();
    expect(() => formatDeviceSecretGroups(`${SECRET_HEX}00`)).toThrow();
    expect(() => formatDeviceSecretGroups(SECRET_HEX.replace('0', 'g'))).toThrow();
    expect(() => formatDeviceSecretGroups('')).toThrow();
  });

  it('LOAD-BEARING round-trip: the displayed form pastes back through device-link', () => {
    // What backup-secret.tsx shows must be accepted by the manual-paste parser
    // on a new phone; otherwise a hand-transcribed backup is worthless.
    const shown = formatDeviceSecretGroups(SECRET_HEX);
    expect(decodeDeviceSecret(shown)).toBe(SECRET_HEX);
    expect(parseManualSecret(shown)).toBe(SECRET_HEX);
  });
});
