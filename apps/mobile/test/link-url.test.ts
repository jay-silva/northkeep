import { describe, expect, it } from 'vitest';
import {
  LinkParseError,
  decodeDeviceSecret,
  parseLinkUrl,
  parseManualSecret,
} from '../src/lib/link-url.js';

// A fixed 32-byte secret for round-trip assertions.
const SECRET = Buffer.from(
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  'hex',
);
const SECRET_HEX = SECRET.toString('hex');
const SECRET_B64 = SECRET.toString('base64');
const SECRET_B64URL = SECRET.toString('base64url');

describe('parseLinkUrl', () => {
  it('parses a link URL with standard base64', () => {
    expect(parseLinkUrl(`northkeep://link/v1?ds=${SECRET_B64}`)).toBe(SECRET_HEX);
  });

  it('parses URL-safe base64 (the QR-friendly form)', () => {
    expect(parseLinkUrl(`northkeep://link/v1?ds=${SECRET_B64URL}`)).toBe(SECRET_HEX);
  });

  it('parses percent-encoded query values', () => {
    expect(parseLinkUrl(`northkeep://link/v1?ds=${encodeURIComponent(SECRET_B64)}`)).toBe(
      SECRET_HEX,
    );
  });

  it('tolerates surrounding whitespace and extra query params', () => {
    expect(parseLinkUrl(`  northkeep://link/v1?x=1&ds=${SECRET_B64URL}&y=2 \n`)).toBe(SECRET_HEX);
  });

  it('rejects a non-northkeep scheme', () => {
    expect(() => parseLinkUrl(`https://evil.example/link/v1?ds=${SECRET_B64}`)).toThrow(
      LinkParseError,
    );
  });

  it('rejects an unknown link version', () => {
    expect(() => parseLinkUrl(`northkeep://link/v2?ds=${SECRET_B64}`)).toThrow(LinkParseError);
    expect(() => parseLinkUrl(`northkeep://pair/v1?ds=${SECRET_B64}`)).toThrow(LinkParseError);
  });

  it('rejects a missing or empty ds parameter', () => {
    expect(() => parseLinkUrl('northkeep://link/v1')).toThrow(LinkParseError);
    expect(() => parseLinkUrl('northkeep://link/v1?ds=')).toThrow(LinkParseError);
    expect(() => parseLinkUrl('northkeep://link/v1?other=x')).toThrow(LinkParseError);
  });

  it('rejects a secret of the wrong length', () => {
    const short = Buffer.alloc(16, 7).toString('base64');
    expect(() => parseLinkUrl(`northkeep://link/v1?ds=${short}`)).toThrow(LinkParseError);
  });

  it('rejects garbage that is not base64 at all', () => {
    expect(() => parseLinkUrl('northkeep://link/v1?ds=!!!not-base64!!!')).toThrow(LinkParseError);
  });
});

describe('parseManualSecret', () => {
  it('accepts a full link URL', () => {
    expect(parseManualSecret(`northkeep://link/v1?ds=${SECRET_B64}`)).toBe(SECRET_HEX);
  });

  it('accepts the 64-hex device.secret file form, case-insensitively', () => {
    expect(parseManualSecret(SECRET_HEX.toUpperCase())).toBe(SECRET_HEX);
    expect(parseManualSecret(` ${SECRET_HEX} `)).toBe(SECRET_HEX);
  });

  it('accepts the grouped display form from the backup screen (internal whitespace)', () => {
    const grouped = SECRET_HEX.match(/.{4}/g)!.join(' ');
    expect(parseManualSecret(grouped)).toBe(SECRET_HEX);
    expect(parseManualSecret(grouped.replace(/ /g, '\n'))).toBe(SECRET_HEX);
  });

  it('accepts bare base64', () => {
    expect(parseManualSecret(SECRET_B64)).toBe(SECRET_HEX);
  });

  it('rejects empty input and garbage', () => {
    expect(() => parseManualSecret('')).toThrow(LinkParseError);
    expect(() => parseManualSecret('   ')).toThrow(LinkParseError);
    expect(() => parseManualSecret('not a secret')).toThrow(LinkParseError);
  });
});

describe('decodeDeviceSecret', () => {
  it('round-trips every accepted encoding to the same hex', () => {
    expect(decodeDeviceSecret(SECRET_HEX)).toBe(SECRET_HEX);
    expect(decodeDeviceSecret(SECRET_B64)).toBe(SECRET_HEX);
    expect(decodeDeviceSecret(SECRET_B64URL)).toBe(SECRET_HEX);
    expect(decodeDeviceSecret(SECRET_B64.replace(/=+$/, ''))).toBe(SECRET_HEX);
  });

  it('rejects base64 with invalid characters instead of silently skipping them', () => {
    // Buffer.from(_, 'base64') alone would ignore the '!' and decode the rest.
    expect(() => decodeDeviceSecret(`${SECRET_B64.slice(0, 10)}!${SECRET_B64.slice(11)}`)).toThrow(
      LinkParseError,
    );
  });

  it('rejects 31- and 33-byte payloads', () => {
    expect(() => decodeDeviceSecret(Buffer.alloc(31, 1).toString('base64'))).toThrow(LinkParseError);
    expect(() => decodeDeviceSecret(Buffer.alloc(33, 1).toString('base64'))).toThrow(LinkParseError);
  });
});
