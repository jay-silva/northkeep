/**
 * Parser for the device-link QR payload (ADR: device linking & mobile secret
 * storage; 07-MOBILE-LAUNCH-PLAN.md Track M):
 *
 *   northkeep://link/v1?ds=<base64 of the 32-byte device.secret>
 *
 * Pure TypeScript, no React Native imports, so it is unit-tested under Node
 * (apps/mobile/test/link-url.test.ts). Deliberately does NOT use the global
 * URL class: React Native's URL polyfill is incomplete, and hand-rolled
 * parsing keeps behavior identical between the Node tests and the device.
 *
 * The desktop file format for device.secret is 64 hex characters
 * (packages/core/src/platform.ts loadDeviceSecret); the QR carries base64 to
 * keep the code small. This module normalizes every accepted form to the hex
 * string, which is what SecureStore persists.
 */

const LINK_PREFIX = 'northkeep://link/v1';
const SECRET_BYTES = 32;

/** Thrown for any malformed link payload. Messages are user-facing on the device-link screen. */
export class LinkParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinkParseError';
  }
}

/**
 * Parses a northkeep://link/v1 URL and returns the device secret as a
 * 64-character lowercase hex string. Throws LinkParseError on anything
 * malformed. Accepts standard and URL-safe base64, with or without padding,
 * and percent-encoded query values.
 */
export function parseLinkUrl(raw: string): string {
  const input = raw.trim();
  if (!input.toLowerCase().startsWith('northkeep://')) {
    throw new LinkParseError('Not a NorthKeep link code.');
  }
  const queryIndex = input.indexOf('?');
  const base = (queryIndex === -1 ? input : input.slice(0, queryIndex)).replace(/\/+$/, '');
  if (base !== LINK_PREFIX) {
    throw new LinkParseError(
      'This link code uses a version this app does not understand. Update the app and try again.',
    );
  }
  if (queryIndex === -1) {
    throw new LinkParseError('This link code is missing its secret. Generate a fresh code and rescan.');
  }
  let ds: string | null = null;
  for (const pair of input.slice(queryIndex + 1).split('&')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq) === 'ds') {
      try {
        ds = decodeURIComponent(pair.slice(eq + 1));
      } catch {
        throw new LinkParseError('This link code is garbled. Generate a fresh code and rescan.');
      }
      break;
    }
  }
  if (ds === null || ds.length === 0) {
    throw new LinkParseError('This link code is missing its secret. Generate a fresh code and rescan.');
  }
  return decodeDeviceSecret(ds);
}

/**
 * The manual-paste fallback: accepts a full northkeep://link/v1 URL, the bare
 * base64 value, or the 64-hex form straight from ~/.northkeep/device.secret.
 * Returns lowercase hex.
 */
export function parseManualSecret(raw: string): string {
  const input = raw.trim();
  if (input.length === 0) throw new LinkParseError('Paste your link code or device secret first.');
  if (input.toLowerCase().startsWith('northkeep://')) return parseLinkUrl(input);
  return decodeDeviceSecret(input);
}

/** Decodes a bare secret value (hex or base64/base64url) to lowercase hex, validating length. */
export function decodeDeviceSecret(value: string): string {
  const input = value.trim();
  // The backup screen (backup-secret.tsx) displays the secret grouped in
  // 4-character blocks for transcription (backup-flow.ts), so a hex candidate
  // tolerates internal whitespace: what we show must paste back cleanly.
  const compactHex = input.replace(/\s+/g, '');
  if (/^[0-9a-f]{64}$/i.test(compactHex)) {
    return compactHex.toLowerCase();
  }
  // Strict base64 shape check first: Buffer.from(str, 'base64') silently
  // ignores invalid characters, which would let a corrupted scan "decode".
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new LinkParseError('That does not look like a NorthKeep device secret.');
  }
  const unpadded = normalized.replace(/=+$/, '');
  const bytes = Buffer.from(unpadded, 'base64');
  if (bytes.length !== SECRET_BYTES) {
    throw new LinkParseError(
      'That secret has the wrong length. Generate a fresh link code and try again.',
    );
  }
  return bytes.toString('hex');
}
