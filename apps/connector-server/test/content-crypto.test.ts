import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import {
  CONTENT_BLOB_PREFIX,
  connectorContentSecretFromEnv,
  decryptContent,
  encryptContent,
} from '../src/content-crypto.js';
import { createConnectorServer } from '../src/create-server.js';
import { InMemoryConnectorStorage } from '../src/storage.js';
import { NeonConnectorStorage } from '../src/neon-storage.js';

/**
 * Encryption-at-rest for connector shared-scope CONTENT (invariant #2 + #3).
 *
 * Proves the primitive round-trips and FAILS CLOSED on every wrong input
 * (wrong account, wrong secret, tamper, legacy plaintext), that cross-account
 * isolation is cryptographic (account B's key cannot read account A's blob), and
 * that the server factory refuses to boot a REAL (Neon) content store without a
 * secret — the fail-closed guard that keeps plaintext off disk.
 */

const SECRET = Buffer.alloc(32, 0x2b);
const OTHER_SECRET = Buffer.alloc(32, 0x99);
const ACCOUNT_A = 'a'.repeat(64);
const ACCOUNT_B = 'b'.repeat(64);
const PLAINTEXT = 'The Tuesday compliance QA/QI review starts at 0800 in the ops room.';

describe('content-crypto: encrypt/decrypt round-trip and fail-closed', () => {
  it('encrypts to a versioned "nkc1:" blob that does not contain the plaintext', () => {
    const blob = encryptContent(ACCOUNT_A, PLAINTEXT, SECRET);
    expect(blob.startsWith(CONTENT_BLOB_PREFIX)).toBe(true);
    expect(blob.includes(PLAINTEXT)).toBe(false);
    expect(blob.includes('compliance')).toBe(false);
  });

  it('round-trips under the same account + secret', () => {
    const blob = encryptContent(ACCOUNT_A, PLAINTEXT, SECRET);
    expect(decryptContent(ACCOUNT_A, blob, SECRET)).toBe(PLAINTEXT);
  });

  it('round-trips the empty string', () => {
    const blob = encryptContent(ACCOUNT_A, '', SECRET);
    expect(blob.startsWith(CONTENT_BLOB_PREFIX)).toBe(true);
    expect(decryptContent(ACCOUNT_A, blob, SECRET)).toBe('');
  });

  it('round-trips unicode content', () => {
    const s = 'ambulance 🚑 — café — 日本語 — 0800';
    expect(decryptContent(ACCOUNT_A, encryptContent(ACCOUNT_A, s, SECRET), SECRET)).toBe(s);
  });

  it('uses a fresh random nonce (same input → different blobs, both decrypt)', () => {
    const b1 = encryptContent(ACCOUNT_A, PLAINTEXT, SECRET);
    const b2 = encryptContent(ACCOUNT_A, PLAINTEXT, SECRET);
    expect(b1).not.toBe(b2);
    expect(decryptContent(ACCOUNT_A, b1, SECRET)).toBe(PLAINTEXT);
    expect(decryptContent(ACCOUNT_A, b2, SECRET)).toBe(PLAINTEXT);
  });

  it('FAIL CLOSED: wrong accountHash → null', () => {
    const blob = encryptContent(ACCOUNT_A, PLAINTEXT, SECRET);
    expect(decryptContent(ACCOUNT_B, blob, SECRET)).toBeNull();
  });

  it('FAIL CLOSED: different secret → null', () => {
    const blob = encryptContent(ACCOUNT_A, PLAINTEXT, SECRET);
    expect(decryptContent(ACCOUNT_A, blob, OTHER_SECRET)).toBeNull();
  });

  it('FAIL CLOSED: tampered blob → null (does not throw)', () => {
    const blob = encryptContent(ACCOUNT_A, PLAINTEXT, SECRET);
    // Flip the last two base64 chars.
    const tampered = blob.slice(0, -2) + (blob.endsWith('AA') ? 'BB' : 'AA');
    expect(decryptContent(ACCOUNT_A, tampered, SECRET)).toBeNull();
  });

  it('FAIL CLOSED: legacy / non-prefixed plaintext → null', () => {
    expect(decryptContent(ACCOUNT_A, PLAINTEXT, SECRET)).toBeNull();
    expect(decryptContent(ACCOUNT_A, '', SECRET)).toBeNull();
    expect(decryptContent(ACCOUNT_A, 'nkc1:not-base64-@@@', SECRET)).toBeNull();
    expect(decryptContent(ACCOUNT_A, 'nkc1:', SECRET)).toBeNull(); // too short for a nonce
  });

  it('CROSS-ACCOUNT ISOLATION: account A and B derive different keys; neither reads the other', () => {
    const a = encryptContent(ACCOUNT_A, PLAINTEXT, SECRET);
    const b = encryptContent(ACCOUNT_B, 'Account B private note', SECRET);
    expect(decryptContent(ACCOUNT_A, a, SECRET)).toBe(PLAINTEXT);
    expect(decryptContent(ACCOUNT_B, b, SECRET)).toBe('Account B private note');
    // Swap the keys: each fails closed on the other's blob.
    expect(decryptContent(ACCOUNT_B, a, SECRET)).toBeNull();
    expect(decryptContent(ACCOUNT_A, b, SECRET)).toBeNull();
  });
});

describe('content-crypto: connectorContentSecretFromEnv (the boot guard)', () => {
  it('returns null when unset or empty', () => {
    expect(connectorContentSecretFromEnv({})).toBeNull();
    expect(connectorContentSecretFromEnv({ NORTHKEEP_CONNECTOR_CONTENT_SECRET: '' })).toBeNull();
  });

  it('accepts a 32-byte hex secret', () => {
    const hex = crypto.randomBytes(32).toString('hex');
    const buf = connectorContentSecretFromEnv({ NORTHKEEP_CONNECTOR_CONTENT_SECRET: hex });
    expect(buf).not.toBeNull();
    expect(buf!.length).toBe(32);
    expect(buf!.equals(Buffer.from(hex, 'hex'))).toBe(true);
  });

  it('accepts a 32-byte base64 secret', () => {
    const buf = connectorContentSecretFromEnv({
      NORTHKEEP_CONNECTOR_CONTENT_SECRET: crypto.randomBytes(32).toString('base64'),
    });
    expect(buf!.length).toBe(32);
  });

  it('accepts a raw string with >= 32 bytes of entropy', () => {
    const buf = connectorContentSecretFromEnv({ NORTHKEEP_CONNECTOR_CONTENT_SECRET: 'x'.repeat(40) });
    expect(buf!.length).toBeGreaterThanOrEqual(32);
  });

  it('THROWS on a set-but-too-weak secret (never a silent plaintext downgrade)', () => {
    expect(() => connectorContentSecretFromEnv({ NORTHKEEP_CONNECTOR_CONTENT_SECRET: 'short' })).toThrow();
  });

  it('a hex-decoded secret is usable end-to-end', () => {
    const secret = connectorContentSecretFromEnv({
      NORTHKEEP_CONNECTOR_CONTENT_SECRET: crypto.randomBytes(32).toString('hex'),
    })!;
    const blob = encryptContent(ACCOUNT_A, PLAINTEXT, secret);
    expect(decryptContent(ACCOUNT_A, blob, secret)).toBe(PLAINTEXT);
  });
});

describe('createConnectorServer: fail-closed content-secret boot guard', () => {
  const DUMMY_DB = 'postgres://user:pass@host.neon.tech/db';

  it('REFUSES to start a Neon-backed server with no content secret', () => {
    expect(() => createConnectorServer(new NeonConnectorStorage(DUMMY_DB), { contentSecret: null })).toThrow(
      /NORTHKEEP_CONNECTOR_CONTENT_SECRET/,
    );
  });

  it('starts a Neon-backed server when a content secret is provided', () => {
    expect(() => createConnectorServer(new NeonConnectorStorage(DUMMY_DB), { contentSecret: SECRET })).not.toThrow();
  });

  it('allows an in-memory server with no secret (nothing at rest → plaintext passthrough)', () => {
    expect(() => createConnectorServer(new InMemoryConnectorStorage(), { contentSecret: null })).not.toThrow();
  });
});
