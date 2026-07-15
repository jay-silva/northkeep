import { createHash, randomBytes } from 'node:crypto';

/**
 * sha256 hex of a utf8 string. This is byte-identical to `tokenHash()` from
 * @northkeep/sync (both hash the token HEX STRING as utf8), so the account key
 * the connector stores == the key the client derives. Kept local so the
 * serverless bundle never pulls @northkeep/sync → @northkeep/core → sodium-native.
 */
export function sha256hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** A fresh opaque secret (base64url), for authorization codes and tokens. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * A user-facing pairing code: 8 uppercase base32-ish chars (no 0/1/O/I to avoid
 * transcription errors). Single-use, short TTL; only its sha256 is stored.
 */
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function generatePairingCode(): string {
  const buf = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += PAIRING_ALPHABET[(buf[i] as number) % PAIRING_ALPHABET.length];
  return out;
}
