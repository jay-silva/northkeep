/**
 * Sealing for the notes file (ADR 0072 D1). XChaCha20-Poly1305 through the
 * platform provider, as the vault uses. Each row's readable columns are its
 * associated data, so a row moved to another project, sender or position
 * fails to open instead of showing up somewhere it was never written.
 */
import { decrypt, encrypt, NONCE_BYTES } from './crypto.js';
import { getPlatform } from './platform-context.js';
import type { CryptoProvider } from './crypto-provider.js';
import type { NotePayload } from './project-notes.js';

export interface NoteRowFields {
  id: string;
  project: string;
  client_id: string;
  sender_key: string;
  created_at: string;
}

const KEY_CHECK_PLAINTEXT = Buffer.from('nk-notes-key-check-v1', 'utf8');
const KEY_CHECK_AD = Buffer.from('nk-notes-key-check', 'utf8');

function rowAd(row: NoteRowFields): Buffer {
  return Buffer.from(['v1', row.id, row.project, row.client_id, row.sender_key, row.created_at].join('|'), 'utf8');
}

/** nonce || ciphertext, one blob per row. */
export function sealNote(payload: NotePayload, row: NoteRowFields, key: Buffer, provider: CryptoProvider = getPlatform().crypto): Buffer {
  const { nonce, ciphertext } = encrypt(Buffer.from(JSON.stringify(payload), 'utf8'), key, rowAd(row), provider);
  return Buffer.concat([nonce, ciphertext]);
}

/** Null when the row does not open under this key or does not parse; the caller skips it. */
export function openNote(blob: Buffer, row: NoteRowFields, key: Buffer, provider: CryptoProvider = getPlatform().crypto): NotePayload | null {
  if (blob.length <= NONCE_BYTES) return null;
  try {
    const plain = decrypt(Buffer.from(blob.subarray(NONCE_BYTES)), key, Buffer.from(blob.subarray(0, NONCE_BYTES)), rowAd(row), provider);
    const parsed = JSON.parse(plain.toString('utf8')) as NotePayload;
    return parsed && parsed.v === 1 && typeof parsed.kind === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function sealKeyCheck(key: Buffer, provider: CryptoProvider = getPlatform().crypto): Buffer {
  const { nonce, ciphertext } = encrypt(KEY_CHECK_PLAINTEXT, key, KEY_CHECK_AD, provider);
  return Buffer.concat([nonce, ciphertext]);
}

/** True when the file's key-check row was written under this key. */
export function keyCheckMatches(blob: Buffer, key: Buffer, provider: CryptoProvider = getPlatform().crypto): boolean {
  if (blob.length <= NONCE_BYTES) return false;
  try {
    const plain = decrypt(Buffer.from(blob.subarray(NONCE_BYTES)), key, Buffer.from(blob.subarray(0, NONCE_BYTES)), KEY_CHECK_AD, provider);
    return plain.equals(KEY_CHECK_PLAINTEXT);
  } catch {
    return false;
  }
}
