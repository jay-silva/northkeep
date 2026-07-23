/**
 * Recovery-secret display formatting (Phase A: backup step after create-vault).
 * Pure TypeScript with NO React Native, Expo, or @northkeep imports, unit-tested
 * under Node (apps/mobile/test/backup-flow.test.ts).
 *
 * The backup screen shows the 64-hex device secret (the exact form the
 * device-link manual paste accepts and the desktop stores in
 * ~/.northkeep/device.secret) grouped for human transcription. The paste side
 * (link-url.ts decodeDeviceSecret) strips internal whitespace from a hex
 * candidate, so BOTH the grouped display form and the raw hex round-trip; the
 * round-trip is asserted in the tests.
 */

const SECRET_HEX_LENGTH = 64;
const GROUP_SIZE = 4;

/**
 * Format a 64-hex device secret as sixteen 4-character groups separated by
 * single spaces, lowercased. Throws on anything that is not exactly 64 hex
 * characters: the caller holds the real secret, so a malformed value is a bug,
 * never user input.
 */
export function formatDeviceSecretGroups(hex: string): string {
  const compact = hex.trim().toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${SECRET_HEX_LENGTH}}$`).test(compact)) {
    throw new Error('Not a 64-character hex device secret.');
  }
  const groups: string[] = [];
  for (let i = 0; i < compact.length; i += GROUP_SIZE) {
    groups.push(compact.slice(i, i + GROUP_SIZE));
  }
  return groups.join(' ');
}
